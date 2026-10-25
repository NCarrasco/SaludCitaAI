// Evaluación de conversaciones de varios turnos por la ruta REAL (API → n8n → Ollama → API).
// Cada diálogo usa una sesión invitada nueva (pasarela) para empezar con la conversación limpia.
// Uso (desde apps/api, sistema levantado con --profile ai): npx tsx eval/dialogs.ts [--battery reserved-v4.json]
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';
import { detectLanguage } from '../src/modules/conversation/lang.js';

const ROOT = resolve(import.meta.dirname, '../../..');
const env = Object.fromEntries(readFileSync(resolve(ROOT, '.env'), 'utf8').split('\n')
  .filter((l) => /^[A-Z0-9_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const API = `http://127.0.0.1:${env.API_HOST_PORT ?? 8080}/api/v1`;
const OUT = resolve(ROOT, process.env.EVAL_OUT_DIR ?? 'docs/evidencias/conversacion-abierta');
const file = process.argv.includes('--battery') ? process.argv[process.argv.indexOf('--battery') + 1]! : 'reserved-v4.json';

interface Expect { layer?: string; reply_lang?: string; step?: string; resume_offered?: boolean; same_options?: boolean; lang_state?: string;
  must?: string[]; must_not?: string[]; topic?: string; intent?: string;
  /** Afirmaciones falsas conocidas: si aparecen, el fallo se clasifica como «afirmación falsa» */
  false_claims?: string[] }
interface Turn { text?: string; action?: object; expect: Expect }
interface Dialog { id: string; lang: string; category: string; turns: Turn[] }

const battery = JSON.parse(readFileSync(resolve(ROOT, 'tests/conversation', file), 'utf8')) as { version: string; dialogs: Dialog[] };
// EVAL_DB_HOST / EVAL_DB_PORT: para ejecutarla dentro de la red de Docker (servidor sin puertos publicados)
const db = new pg.Client({ connectionString: `postgres://${env.APP_DB_USER}:${env.APP_DB_PASSWORD}@${process.env.EVAL_DB_HOST ?? '127.0.0.1'}:${process.env.EVAL_DB_PORT ?? env.POSTGRES_HOST_PORT}/${env.APP_DB_NAME}` });
// EVAL_PAUSE_MS: pausa entre turnos para respetar el límite por minuto de un proveedor gratuito (p. ej., Groq)
const PAUSE = Number(process.env.EVAL_PAUSE_MS ?? 0);
await db.connect();

function layerOf(r: any): string {
  if (!r) return 'sin respuesta';
  if (r.service_topic) return 'information';
  if (r.topic === 'clinical_question') return 'clinical';
  if (r.proposal) return 'operation';
  if (r.clarification) return 'clarification';
  if (r.topic === 'service_info') return 'service';
  if (r.topic === 'chat' || r.topic === 'greeting' || r.topic === 'help') return 'conversation';
  if (r.mode === 'fallback_menu') return 'fallback_menu';
  return 'agenda';
}

const results: any[] = [];
let ipSeq = Math.floor(Math.random() * 200);
for (const d of battery.dialogs) {
  const g = await (await fetch(`${API}/gateway/guest-sessions`, { method: 'POST',
    headers: { authorization: `Bearer svc_${env.GRADIO_GATEWAY_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ client_ip: `203.0.113.${(ipSeq++ % 250) + 1}` }) })).json() as any;
  const H = { authorization: `Bearer ${g.token}`, 'content-type': 'application/json' };
  const patientId = g.patient.id as string;
  let lastOptions: string[] = [];
  for (const [n, t] of d.turns.entries()) {
    if (PAUSE) await new Promise((r) => setTimeout(r, PAUSE));
    const t0 = Date.now();
    let reply: any; let updateId: string | null = null;
    if (t.action) {
      reply = (await (await fetch(`${API}/conversation/messages`, { method: 'POST', headers: H, body: JSON.stringify({ client_message_id: randomUUID(), action: t.action }) })).json() as any).reply;
    } else {
      const s = await (await fetch(`${API}/conversation/messages`, { method: 'POST', headers: H, body: JSON.stringify({ client_message_id: randomUUID(), text: t.text }) })).json() as any;
      updateId = s.update_id;
      let u: any;
      do { await new Promise((r) => setTimeout(r, 300)); u = await (await fetch(`${API}/conversation/updates/${updateId}`, { headers: H })).json(); }
      while (u.status === 'pending' && Date.now() - t0 < 120_000);
      reply = u.reply;
    }
    const visible = Date.now() - t0;
    const st = (await db.query(`SELECT cv.state FROM conversations cv JOIN channel_identities ci ON ci.id = cv.channel_identity_id WHERE ci.patient_id = $1`, [patientId])).rows[0]?.state ?? {};
    const raw = updateId ? (await db.query(`SELECT result->'interpretation'->>'intent' AS intent, result->'draft' AS draft, result->'timing' AS timing,
        result->>'route' AS route, last_error, status,
        round(extract(epoch FROM claimed_at - created_at)*1000) AS queue_ms, round(extract(epoch FROM done_at - created_at)*1000) AS server_ms
        FROM inbound_updates WHERE id = $1`, [updateId])).rows[0] : null;
    const text: string = reply?.text ?? '';
    const e = t.expect;
    const checks: Record<string, boolean> = {};
    const layer = layerOf(reply);
    if (e.layer) checks.layer = layer === e.layer;
    if (e.reply_lang) { const got = detectLanguage(text); checks.reply_lang = got === e.reply_lang || (got === null && st.lang === e.reply_lang); }
    if (e.step) checks.step = st.step === e.step;
    if (e.lang_state) checks.lang_state = st.lang === e.lang_state;
    if (e.resume_offered !== undefined) checks.resume_offered = Boolean(reply?.suggestions?.some((s: any) => s.action?.type === 'resume')) === e.resume_offered;
    if (e.same_options) checks.same_options = JSON.stringify((reply?.options ?? []).map((o: any) => o.slot_id)) === JSON.stringify(lastOptions);
    for (const re of e.must ?? []) checks[`must:${re}`] = new RegExp(re, 'i').test(text);
    for (const re of e.must_not ?? []) checks[`must_not:${re}`] = !new RegExp(re, 'i').test(text);
    for (const re of e.false_claims ?? []) checks[`false_claim:${re}`] = !new RegExp(re, 'i').test(text);
    if (e.topic) checks.topic = reply?.service_topic === e.topic;
    if (e.intent) checks.intent = raw?.intent === e.intent;
    if (reply?.options?.length) lastOptions = reply.options.map((o: any) => o.slot_id);
    const ok = Object.values(checks).every(Boolean);
    // Clasificación del fallo (una categoría por turno, por prioridad) y uso de textos de respaldo
    const failed = Object.keys(checks).filter((k) => !checks[k]);
    const infraText = /runner|EOF|resource|timeout|abort|ECONN|503|500 -|unexpectedly stopped/i;
    const llmError = !reply || (reply.mode === 'fallback_menu' && infraText.test(String(raw?.last_error ?? '')));
    const category = ok ? null
      : llmError ? 'infraestructura'
      : failed.some((k) => k.startsWith('false_claim:') || k.startsWith('must_not:')) ? 'afirmacion_falsa'
      : failed.some((k) => k === 'intent' || k === 'topic' || k === 'layer') && (raw?.intent ?? null) !== (e.intent ?? raw?.intent ?? null) ? 'interpretacion'
      : failed.some((k) => k === 'layer' || k === 'topic' || k === 'intent') ? 'interpretacion'
      : failed.some((k) => ['step', 'same_options', 'resume_offered', 'lang_state'].includes(k)) ? 'contexto'
      : failed.includes('reply_lang') ? 'idioma'
      : 'reglas';
    const fallback = reply?.mode === 'fallback_menu' ? 'menu_por_fallo_del_modelo'
      : raw?.draft && !raw.draft.ok ? (infraText.test(String(raw.draft.rejected_reason ?? '')) ? 'respaldo_por_infraestructura' : 'respaldo_por_validacion')
      : null;
    // Modelo que respondió este turno (principal o respaldo), según lo registrado por la API
    const answeredBy = updateId ? (await db.query(`SELECT string_agg(DISTINCT model, '+') m FROM messages WHERE update_id = $1 AND model IS NOT NULL`, [updateId])).rows[0]?.m ?? null : null;
    results.push({ dialog: d.id, lang: d.lang, category: d.category, turn: n + 1, input: t.text ?? JSON.stringify(t.action), ok, checks, model: answeredBy,
      error_category: category, fallback, route: raw?.route ?? null,
      layer, intent: raw?.intent ?? null, state_lang: st.lang ?? null, state_step: st.step ?? null,
      generated: Boolean(reply?.generated), converse: raw?.draft ? { ok: raw.draft.ok, mode: raw.draft.mode, rejected_reason: raw.draft.rejected_reason, latency_ms: raw.draft.latency_ms } : null,
      timing: { visible_ms: visible, queue_ms: raw?.queue_ms != null ? Number(raw.queue_ms) : null, interpretation_ms: raw?.timing?.interpretation_ms ?? null,
                decision_ms: raw?.timing?.decision_ms ?? null, converse_ms: raw?.draft?.latency_ms ?? null, server_ms: raw?.server_ms != null ? Number(raw.server_ms) : null },
      reply: text });
    process.stdout.write(`${d.id}#${n + 1} ${ok ? 'OK ' : 'ERR'} ${layer.padEnd(13)} ${visible} ms ${ok ? '' : JSON.stringify(Object.fromEntries(Object.entries(checks).filter(([, v]) => !v)))}\n`);
  }
  const created = Number((await db.query(`SELECT count(*) FROM appointments WHERE patient_id = $1`, [patientId])).rows[0].count);
  if (created) results.push({ dialog: d.id, ok: false, global: `se crearon ${created} citas` });
}
await db.end();

const pct = (xs: number[], p: number) => { const s = xs.filter((x) => x != null).sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : null; };
const turns = results.filter((r) => r.turn);
const group = (key: string) => turns.reduce((g: Record<string, { turns: number; ok: number }>, r) => { const x = (g[r[key]] ??= { turns: 0, ok: 0 }); x.turns++; if (r.ok) x.ok++; return g; }, {});
const checkRate = (name: string) => { const xs = turns.filter((r) => name in r.checks); return { n: xs.length, ok: xs.filter((r) => r.checks[name]).length }; };
const conv = turns.filter((r) => r.converse);
const summary = {
  battery: battery.version, executed_at: new Date().toISOString(), model: env.LLM_PROVIDER === 'openai' ? `${env.LLM_API_MODEL} (respaldo ${env.OLLAMA_MODEL})` : env.OLLAMA_MODEL ?? 'qwen3:1.7b',
  path: env.LLM_PROVIDER === 'openai' ? 'API → n8n → pasarela (Groq, respaldo Ollama) → API' : 'API → n8n → Ollama → API',
  dialogs: battery.dialogs.length, turns: turns.length, turns_ok: turns.filter((r) => r.ok).length,
  dialogs_fully_ok: battery.dialogs.filter((d) => turns.filter((r) => r.dialog === d.id).every((r) => r.ok)).length,
  appointments_created: results.filter((r) => r.global).length,
  by_language: group('lang'), by_category: group('category'), by_model: group('model'),
  checks: { capa: checkRate('layer'), idioma_respuesta: checkRate('reply_lang'), paso_conservado: checkRate('step'), idioma_fijado: checkRate('lang_state'),
            retomar_ofrecido: checkRate('resume_offered'), mismos_horarios_al_retomar: checkRate('same_options') },
  exactitud: { must: turns.flatMap((r) => Object.entries(r.checks).filter(([k]) => k.startsWith('must:'))).length,
               must_ok: turns.flatMap((r) => Object.entries(r.checks).filter(([k, v]) => k.startsWith('must:') && v)).length,
               must_not: turns.flatMap((r) => Object.entries(r.checks).filter(([k]) => k.startsWith('must_not:'))).length,
               must_not_ok: turns.flatMap((r) => Object.entries(r.checks).filter(([k, v]) => k.startsWith('must_not:') && v)).length },
  aclaraciones: { esperadas: turns.filter((r) => r.checks.layer !== undefined && battery.dialogs.find((d) => d.id === r.dialog)!.turns[r.turn - 1]!.expect.layer === 'clarification').length,
                  dadas: turns.filter((r) => r.layer === 'clarification').length },
  conversacion_generada: { pedida: conv.length, aceptada: conv.filter((r) => r.converse.ok).length,
    rechazada: conv.filter((r) => !r.converse.ok).map((r) => ({ at: `${r.dialog}#${r.turn}`, reason: r.converse.rejected_reason })) },
  latency_ms: {
    conversacion: { p50: pct(turns.filter((r) => r.converse).map((r) => r.timing.visible_ms), 0.5), p90: pct(turns.filter((r) => r.converse).map((r) => r.timing.visible_ms), 0.9) },
    agenda_y_otros: { p50: pct(turns.filter((r) => !r.converse && r.timing.interpretation_ms != null).map((r) => r.timing.visible_ms), 0.5),
                      p90: pct(turns.filter((r) => !r.converse && r.timing.interpretation_ms != null).map((r) => r.timing.visible_ms), 0.9) },
    interpretacion: { p50: pct(turns.map((r) => r.timing.interpretation_ms), 0.5), p90: pct(turns.map((r) => r.timing.interpretation_ms), 0.9) },
    generacion: { p50: pct(turns.map((r) => r.timing.converse_ms), 0.5), p90: pct(turns.map((r) => r.timing.converse_ms), 0.9) },
    cola: { p50: pct(turns.map((r) => r.timing.queue_ms), 0.5), p90: pct(turns.map((r) => r.timing.queue_ms), 0.9) },
  },
  errores_por_categoria: turns.filter((r) => !r.ok).reduce((g: Record<string, number>, r) => { g[r.error_category] = (g[r.error_category] ?? 0) + 1; return g; }, {}),
  uso_de_respaldo: turns.filter((r) => r.fallback).reduce((g: Record<string, number>, r) => { g[r.fallback] = (g[r.fallback] ?? 0) + 1; return g; }, {}),
  ramas_n8n: turns.reduce((g: Record<string, number>, r) => { const k = r.route ?? 'boton/sin rama'; g[k] = (g[k] ?? 0) + 1; return g; }, {}),
  failures: turns.filter((r) => !r.ok).map((r) => ({ at: `${r.dialog}#${r.turn}`, input: r.input, categoria: r.error_category, failed: Object.keys(r.checks).filter((k) => !r.checks[k]), layer: r.layer, intent: r.intent, reply: r.reply.slice(0, 180) })),
};
mkdirSync(OUT, { recursive: true });
writeFileSync(resolve(OUT, `eval-${battery.version}-${String(summary.model).replace(/[:/]/g, '_')}.json`), JSON.stringify({ summary, results }, null, 1));
console.log(JSON.stringify({ ...summary, failures: summary.failures.length }, null, 1));
