// Evaluación extremo a extremo de la conversación por la ruta real:
// API (/conversation/messages) → webhook n8n → Ollama → /internal/updates/ack → máquina de estados → respuesta.
// Comprueba el RESULTADO de cada caso contra PostgreSQL, no solo la interpretación del modelo.
//
// Requisitos: Compose levantado con --profile ai, workflows publicados y OLLAMA_MODEL configurado.
// Uso (desde apps/api): npx tsx eval/e2e.ts [--cases B01,X01]

import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';

const ROOT = resolve(import.meta.dirname, '../../..');
const env = Object.fromEntries(readFileSync(resolve(ROOT, '.env'), 'utf8').split('\n')
  .filter((l) => /^[A-Z0-9_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const API = `http://127.0.0.1:${env.API_HOST_PORT ?? 8080}/api/v1`;
const OUT = process.env.EVAL_OUT_DIR ?? resolve(ROOT, 'docs/evidencias/entrega-2');
const PATIENT = 'paciente19';
const TIMEOUT_MS = 120_000;

interface Case { id: string; text: string; operation: string; clarity: string; specialty_label: string;
  context: { step: string }; expected: { intent: string; specialty: string | null; date_phrase: string | null; option_number: number | null };
  acceptable_outcomes?: ('direct' | 'clarification')[];
  lang?: string;                 // 'es' (habilitado) | otro (no habilitado: se informa aparte)
  no_invented_date?: boolean;    // el texto no trae fecha: la respuesta no debe fijar una
  draft_must_not?: string[];     // criterios de exactitud de la redacción (regex), fijados ANTES de ejecutar
}
const ORACLE = process.argv.includes('--oracle');

async function call(method: string, path: string, token: string, body?: object) {
  const r = await fetch(`${API}${path}`, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined });
  const json = r.status === 204 ? null : await r.json();
  if (r.status >= 400) throw new Error(`${method} ${path} → ${r.status} ${JSON.stringify(json)}`);
  return json as any;
}
const action = (t: string, a: object) => call('POST', '/conversation/messages', t, { client_message_id: randomUUID(), action: a }).then((r) => r.reply);

async function main() {
  const only = process.argv.includes('--cases') ? process.argv[process.argv.indexOf('--cases') + 1]!.split(',') : null;
  const file = process.argv.includes('--battery') ? process.argv[process.argv.indexOf('--battery') + 1]! : 'cases.json';
  const battery = JSON.parse(readFileSync(resolve(ROOT, 'tests/conversation', file), 'utf8')) as { version: string; cases: Case[] };
  const cases = battery.cases.filter((c) => !only || only.includes(c.id));
  const db = new pg.Client({ connectionString: `postgres://${env.APP_DB_USER}:${env.APP_DB_PASSWORD}@127.0.0.1:${env.POSTGRES_HOST_PORT}/${env.APP_DB_NAME}` });
  await db.connect();
  const login = await (await fetch(`${API}/patient-auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: PATIENT, password: env.SEED_PATIENT_PASSWORD }) })).json() as any;
  const t = login.token as string;
  const patientId = login.patient.id as string;
  const specialties = (await call('GET', '/specialties', t)).items as { id: string; name: string }[];

  // Una cita propia para poder evaluar cancelar/reprogramar/consultar
  if ((await call('GET', '/appointments', t)).items.length === 0) {
    const from = new Date(Date.now() + 5 * 86400_000).toISOString();
    const to = new Date(Date.now() + 20 * 86400_000).toISOString();
    const slot = (await call('GET', `/availability?specialty_id=${specialties[0]!.id}&from=${from}&to=${to}&limit=1`, t)).items[0];
    const p = await call('POST', '/action-intents', t, { kind: 'booking', slot_id: slot.slot_id });
    // Como la interfaz: orden durable que ejecuta n8n; se espera su resultado
    await fetch(`${API}/action-intents/${p.intent_id}/submit`, { method: 'POST',
      headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json', 'idempotency-key': randomUUID() },
      body: JSON.stringify({ token: p.token }) });
    for (let i = 0; i < 300; i++) {
      const st = await call('GET', `/action-intents/${p.intent_id}/confirmation`, t);
      if (!['queued', 'running'].includes(st.status)) break;
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  const countAppts = async () => Number((await db.query(`SELECT count(*) FROM appointments WHERE patient_id = $1`, [patientId])).rows[0].count);
  const apptsBefore = await countAppts();
  const model = env.OLLAMA_MODEL;

  const results: any[] = [];
  for (const c of cases) {
    // Contexto previo con acciones deterministas (sin modelo)
    await action(t, { type: 'discard_proposal' });
    let offered: { slot_id: string; index: number }[] = [];
    if (c.context.step === 'choosing_slot' || c.context.step === 'awaiting_confirmation') {
      await action(t, { type: 'menu', item: 'book' });
      const r = await action(t, { type: 'choose_specialty', specialty_id: specialties[1]!.id });
      offered = r.options ?? [];
      if (c.context.step === 'awaiting_confirmation') await action(t, { type: 'select_option', index: 1 });
    }
    const before = await countAppts();
    const t0 = Date.now();
    const sent = await call('POST', '/conversation/messages', t, { client_message_id: randomUUID(), text: c.text });
    if (ORACLE) {
      const svc = { authorization: `Bearer svc_${env.N8N_API_SERVICE_TOKEN}`, 'content-type': 'application/json' };
      const cl = await (await fetch(`${API}/internal/updates/claim`, { method: 'POST', headers: svc, body: JSON.stringify({ update_id: sent.update_id }) })).json() as any;
      const item = cl.items[0];
      const content = JSON.stringify({ intent: c.expected.intent, specialty: c.expected.specialty, doctor: null, date_phrase: c.expected.date_phrase,
        time_of_day: (c.expected as any).time_of_day ?? null, option_number: c.expected.option_number, booking_reference: null });
      const a = await (await fetch(`${API}/internal/updates/${sent.update_id}/ack`, { method: 'POST', headers: svc,
        body: JSON.stringify({ lease_token: item.lease_token, llm: { ok: true, content, model: 'oraculo (interpretación esperada)' } }) })).json() as any;
      // Nivel de reglas: sin modelo de redacción → se usa el texto verificado
      if (a.status === 'drafting') {
        await fetch(`${API}/internal/updates/${sent.update_id}/draft`, { method: 'POST', headers: svc,
          body: JSON.stringify({ lease_token: item.lease_token, llm: { ok: false, error: 'oráculo: nivel de reglas sin redacción' } }) });
      }
    }
    let u: any;
    while (Date.now() - t0 < TIMEOUT_MS) {
      await new Promise((r) => setTimeout(r, 300));
      u = await call('GET', `/conversation/updates/${sent.update_id}`, t);
      if (u.status !== 'pending') break;
    }
    const latency = Date.now() - t0;
    const reply = u?.reply ?? null;
    const raw = (await db.query(`SELECT result->'interpretation' AS interp, result->'draft' AS draft, result->'timing' AS timing, last_error, processed_by, attempts,
        round(extract(epoch FROM claimed_at - created_at) * 1000) AS queue_ms, round(extract(epoch FROM done_at - created_at) * 1000) AS server_ms
      FROM inbound_updates WHERE id = $1`, [sent.update_id])).rows[0];
    const st = (await db.query(`SELECT cv.state FROM conversations cv JOIN inbound_updates u ON u.conversation_id = cv.id WHERE u.id = $1`, [sent.update_id])).rows[0]?.state;

    // Verificación del resultado según la operación esperada
    const e = c.expected;
    let ok = false; let reason = '';
    const realSlots = async (opts: { slot_id: string }[]) => {
      if (!opts.length) return false;
      const r = await db.query(`SELECT count(*) FROM reservable_slots WHERE slot_id = ANY($1::uuid[])`, [opts.map((o) => o.slot_id)]);
      return Number(r.rows[0].count) === opts.length;
    };
    if (!reply) reason = 'sin respuesta en el plazo';
    else if (reply.mode !== 'ai') reason = `modo ${reply.mode}`;
    else switch (c.operation) {
      case 'book':
        if (e.specialty) {
          ok = Boolean(reply.options?.length && await realSlots(reply.options) && reply.options.every((o: any) => o.specialty === e.specialty))
            || Boolean(reply.date_choices?.length) || /No encontré horarios/.test(reply.text);
          reason = ok ? '' : 'no ofreció horarios reales de la especialidad esperada';
        } else if (c.context.step !== 'idle') {
          // Seguimiento dentro de un flujo con especialidad ya elegida: debe ofrecer horarios reales o aclarar la fecha
          ok = Boolean(reply.options?.length && await realSlots(reply.options)) || Boolean(reply.date_choices?.length);
          reason = ok ? '' : 'no ofreció horarios del flujo en curso';
        } else {
          ok = Boolean(reply.specialty_choices?.length);
          reason = ok ? '' : 'no pidió la especialidad faltante';
        }
        break;
      case 'select':
        if (e.intent === 'select_option') {
          const want = offered.find((o) => o.index === e.option_number)?.slot_id;
          ok = reply.proposal?.kind === 'booking' && reply.proposal.slot_id === want;
          reason = ok ? '' : 'no propuso el horario elegido';
        } else if (e.intent === 'affirm') {
          ok = /botón «Confirmar»/.test(reply.text); reason = ok ? '' : 'no exigió el botón';
        } else {
          ok = !reply.proposal; reason = ok ? '' : 'mantuvo una propuesta tras «no»';
        }
        break;
      case 'list': ok = /^(Tus próximas citas|No tienes citas)/.test(reply.text); reason = ok ? '' : 'no listó citas'; break;
      case 'cancel':
        ok = reply.proposal?.kind === 'cancellation' || Boolean(reply.appointment_choices?.length) || /No encontré una cita activa/.test(reply.text);
        reason = ok ? '' : 'no inició la cancelación'; break;
      case 'reschedule':
        ok = Boolean(reply.options?.length && await realSlots(reply.options)) || Boolean(reply.appointment_choices?.length) || Boolean(reply.date_choices?.length);
        reason = ok ? '' : 'no inició el cambio'; break;
      case 'clinical': ok = /no doy orientación médica/.test(reply.text); reason = ok ? '' : 'no derivó la pregunta clínica'; break;
      case 'handoff': ok = /^AY-/.test(reply.handoff_reference ?? ''); reason = ok ? '' : 'no creó el caso'; break;
      case 'greeting': case 'help': ok = Boolean(reply.menu); reason = ok ? '' : 'no ofreció ayuda'; break;
      case 'out_of_scope':
        ok = !reply.proposal && !reply.options?.length && !reply.appointment_choices?.length && !/SC-[A-Z2-9]{6}/.test(reply.text);
        reason = ok ? '' : 'ofreció una acción ante una petición fuera de alcance'; break;
    }
    const created = (await countAppts()) - before;
    // Aclaración útil: la respuesta pide aclarar y ofrece la acción concreta que corresponde al caso
    const sugg = (reply?.suggestions ?? []) as { action: { type: string; item?: string; specialty_id?: string } }[];
    const spId = e.specialty ? specialties.find((x) => x.name === e.specialty)?.id : undefined;
    const has = (pred: (a: { type: string; item?: string; specialty_id?: string }) => boolean) => sugg.some((x) => pred(x.action));
    const clarificationOk = Boolean(reply?.clarification) && (
      c.operation === 'book' ? (spId ? has((a) => a.type === 'book_with' && a.specialty_id === spId)
                                     : has((a) => a.type === 'book_with' || (a.type === 'menu' && a.item === 'book')) || Boolean(reply.specialty_choices?.length))
      : c.operation === 'list' ? has((a) => a.type === 'menu' && a.item === 'my_appointments')
      : c.operation === 'cancel' ? has((a) => a.type === 'menu' && (a.item === 'cancel' || a.item === 'my_appointments'))
      : c.operation === 'reschedule' ? has((a) => a.type === 'menu' && (a.item === 'reschedule' || a.item === 'my_appointments'))
      : c.operation === 'handoff' ? has((a) => a.type === 'menu' && a.item === 'handoff')
      : false);
    // Fecha inventada: el paciente no dio fecha y el sistema fijó un día concreto
    let inventedDate = false;
    if (c.no_invented_date && reply) {
      // El rango de búsqueda debe ser el predeterminado («los próximos N días»); cualquier otro lo puso el sistema sin que el paciente lo dijera
      inventedDate = Boolean(st?.range && !/^los próximos \d+ días$/.test(st.range.label ?? ''));
      if (inventedDate) { ok = false; reason = `fecha inventada (${st?.range?.label ?? '?'})`; }
    }
    // Redacción por el modelo: ¿se usó, la aceptó el validador y cumple los criterios del caso?
    const drafted = Boolean(raw?.draft);
    const draftAccepted = raw?.draft?.ok === true;
    const draftViolations = draftAccepted ? (c.draft_must_not ?? []).filter((re) => new RegExp(re, 'i').test(reply?.text ?? '')) : [];
    const outcome: 'direct' | 'clarification' | 'failure' = created !== 0 ? 'failure' : ok ? 'direct' : clarificationOk ? 'clarification' : 'failure';
    const acceptable = c.acceptable_outcomes ?? ['direct'];
    if (created !== 0) reason = `se crearon ${created} citas sin botón`;
    ok = acceptable.includes(outcome as 'direct' | 'clarification');
    results.push({ id: c.id, operation: c.operation, clarity: c.clarity, specialty: c.specialty_label, text: c.text,
      ok, outcome, reason: outcome === 'failure' ? reason : '', mode: reply?.mode ?? null, latency_ms: latency, interpretation: raw?.interp ?? null, llm_error: raw?.last_error ?? null,
      lang: c.lang ?? 'es', invented_date: inventedDate,
      draft: drafted ? { accepted: draftAccepted, rejected_reason: raw.draft.rejected_reason ?? null, latency_ms: raw.draft.latency_ms ?? null, violations: draftViolations } : null,
      timing: { queue_ms: raw?.queue_ms != null ? Number(raw.queue_ms) : null, interpretation_ms: raw?.timing?.interpretation_ms ?? null,
                decision_ms: raw?.timing?.decision_ms ?? null, draft_ms: raw?.draft?.latency_ms ?? null, server_ms: raw?.server_ms != null ? Number(raw.server_ms) : null, visible_ms: latency },
      reply_text: reply?.text ?? null });
    process.stdout.write(`${c.id} ${outcome.padEnd(13)} ${ok ? 'OK ' : 'ERR'} ${latency} ms ${outcome === 'failure' ? reason : ''}\n`);
  }
  const apptsAfter = await countAppts();
  await db.end();
  const lat = results.map((r) => r.latency_ms).sort((a, b) => a - b);
  const by = (k: 'operation' | 'clarity' | 'specialty') => results.reduce((g: Record<string, { n: number; direct: number; clarification: number; failure: number }>, r) => {
    const x = (g[r[k]] ??= { n: 0, direct: 0, clarification: 0, failure: 0 }); x.n++; x[r.outcome as 'direct' | 'clarification' | 'failure']++; return g; }, {});
  const summary = {
    model, battery_version: battery.version, executed_at: new Date().toISOString(), path: 'API → n8n → Ollama → API',
    level: ORACLE ? 'reglas (interpretación esperada, sin modelo ni n8n)' : 'sistema completo (API → n8n → Ollama → API)',
    n: results.length, ok: results.filter((r) => r.ok).length,
    outcomes: { direct: results.filter((r) => r.outcome === 'direct').length, clarification: results.filter((r) => r.outcome === 'clarification').length,
                failure: results.filter((r) => r.outcome === 'failure').length },
    failures: results.filter((r) => !r.ok).map((r) => ({ id: r.id, outcome: r.outcome, reason: r.reason, reply: r.reply_text?.slice(0, 160) })),
    by_language: results.reduce((g: Record<string, { n: number; ok: number }>, r) => { const x = (g[r.lang] ??= { n: 0, ok: 0 }); x.n++; if (r.ok) x.ok++; return g; }, {}),
    invented_dates: results.filter((r) => r.invented_date).map((r) => r.id),
    drafting: {
      drafted: results.filter((r) => r.draft).length,
      accepted_by_validator: results.filter((r) => r.draft?.accepted).length,
      rejected: results.filter((r) => r.draft && !r.draft.accepted).map((r) => ({ id: r.id, reason: r.draft.rejected_reason })),
      accepted_but_violates_case_criteria: results.filter((r) => r.draft?.violations?.length).map((r) => ({ id: r.id, violations: r.draft.violations, text: r.reply_text })),
      verified_text_used: results.filter((r) => !r.draft || !r.draft.accepted).length,
    },
    modes: results.reduce((g: Record<string, number>, r) => { g[r.mode ?? 'sin_respuesta'] = (g[r.mode ?? 'sin_respuesta'] ?? 0) + 1; return g; }, {}),
    appointments_created_without_button: apptsAfter - apptsBefore,
    latency_ms: { p50: lat[Math.floor(lat.length / 2)], p90: lat[Math.floor(lat.length * 0.9)], max: lat.at(-1) },
    by_operation: by('operation'), by_clarity: by('clarity'), by_specialty: by('specialty'),
  };
  mkdirSync(OUT, { recursive: true });
  writeFileSync(resolve(OUT, `e2e-${battery.version}-${ORACLE ? 'reglas' : String(model).replace(/[:/]/g, '_')}.json`), JSON.stringify({ summary, results }, null, 1));
  console.log(JSON.stringify(summary, null, 1));
}

main().catch((e) => { console.error(e); process.exit(1); });
