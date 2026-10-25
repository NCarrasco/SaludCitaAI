#!/usr/bin/env node
// Demostración TRAZABLE con el sistema real (Docker Compose local, perfil ai). No simula decisiones ni ejecuciones:
// cada paso se comprueba en su fuente (PostgreSQL de la app, base de n8n, registro de Ollama).
//
//  Parte A · Conversación: Gradio/API → n8n (ejecución real por webhook) → Ollama → API → respuesta
//  Parte B · Ofertas:      cancelación → oferta → aceptación → cascada → estadísticas
//
// Uso: node scripts/demo-trace.mjs  [--out docs/evidencias/entrega-5/demo-trazable.md]
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const ROOT = new URL('..', import.meta.url).pathname;
const env = Object.fromEntries(readFileSync(`${ROOT}.env`, 'utf8').split('\n')
  .filter((l) => /^[A-Z0-9_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const BASE = `http://127.0.0.1:${env.API_HOST_PORT ?? 8080}/api/v1`;
const outArg = process.argv.indexOf('--out');
const OUT = outArg > 0 ? process.argv[outArg + 1] : null;
const dc = (...a) => execFileSync('docker', ['compose', '--env-file', '.env', '-f', 'infra/compose.yaml', '--profile', 'ai', ...a], { cwd: ROOT, encoding: 'utf8' });
const sql = (db, q) => dc('exec', '-T', 'postgres', 'psql', '-U', 'postgres', '-d', db, '-tAc', q).trim();
const lines = [];
const log = (s = '') => { console.log(s); lines.push(s); };
let fails = 0;
const check = (ok, m) => { log(`- ${ok ? '✔' : '✘'} ${m}`); if (!ok) fails++; };

async function call(method, path, token, body, key) {
  const r = await fetch(`${BASE}${path}`, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}),
    ...(key ? { 'idempotency-key': key } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: r.status === 204 ? null : await r.json() };
}

// Operaciones del paciente como la interfaz: orden durable → n8n la ejecuta → resultado terminal (no hay rutas directas)
async function waitOrder(url, t, okStatus) {
  const t0 = Date.now();
  for (;;) {
    const st = (await call('GET', url, t)).json;
    if (st.status === okStatus) return { status: 200, json: st.result };
    if (!['queued', 'running'].includes(st.status)) return { status: st.error?.status ?? 500, json: { error: st.error } };
    if (Date.now() - t0 > 60_000) throw new Error(`orden sin resultado tras 60 s (¿n8n detenido?): ${url}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}
async function confirmOrder(t, p) {
  const s = await call('POST', `/action-intents/${p.intent_id}/submit`, t, { token: p.token }, randomUUID());
  return s.status === 202 ? waitOrder(`/action-intents/${p.intent_id}/confirmation`, t, 'confirmed') : s;
}
async function answerOffer(t, offerId, action) {
  const s = await call('POST', `/offers/${offerId}/answer`, t, { action }, randomUUID());
  return s.status === 202 ? waitOrder(`/offers/${offerId}/answer`, t, 'done') : s;
}
const login = async (u) => (await (await fetch(`${BASE}/patient-auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: u, password: env.SEED_PATIENT_PASSWORD }) })).json()).token;

log(`# Demostración trazable · ${new Date().toISOString()}`);
log('');
log('## A. Conversación: Gradio/API → n8n → Ollama → API → respuesta');
log('');
log('El backend de Gradio hace exactamente esta llamada (`POST /conversation/messages`) con la sesión del paciente.');
const tp = await login('paciente08');
await call('POST', '/conversation/messages', tp, { client_message_id: randomUUID(), action: { type: 'discard_proposal' } }); // conversación en reposo
const t0 = new Date();
const text = 'Quiero una cita de cardiología el martes por la mañana';
const sent = await call('POST', '/conversation/messages', tp, { client_message_id: randomUUID(), text });
check(sent.status === 202, `1. API recibe el mensaje y lo persiste (inbound_update ${sent.json.update_id}) — **API**`);
let upd;
for (let i = 0; i < 60; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  upd = await call('GET', `/conversation/updates/${sent.json.update_id}`, tp);
  if (upd.json.status !== 'pending') break;
}
const elapsed = Date.now() - t0.getTime();
const row = sql(env.APP_DB_NAME, `SELECT processed_by || '|' || attempts || '|' || coalesce(result->'interpretation'->>'intent','') FROM inbound_updates WHERE id = '${sent.json.update_id}'`).split('|');
check(row[0] === 'n8n', `2. El mensaje lo reclamó y procesó n8n (processed_by = ${row[0]}, intentos = ${row[1]}) — **n8n**`);
const exec = sql('n8n', `SELECT e.id || '|' || e.mode || '|' || e.status || '|' || to_char(e."startedAt", 'HH24:MI:SS.MS') FROM execution_entity e
  JOIN execution_data d ON d."executionId" = e.id WHERE e."workflowId" = 'scConversation01' AND d.data LIKE '%${sent.json.update_id}%'
  ORDER BY e.id LIMIT 1`).split('|');
check(exec[0] !== '', `3. Ejecución real de n8n #${exec[0]} (workflow «SaludCita · Conversación», modo ${exec[1]}, estado ${exec[2]}, inicio ${exec[3]} UTC) que contiene ese update_id — **n8n**`);
const n8nIp = execFileSync('docker', ['inspect', '-f', '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}', `${dc('ps', '-q', 'n8n').trim()}`], { encoding: 'utf8' }).trim();
const since = Math.max(10, Math.ceil(elapsed / 1000) + 10);
const ollama = dc('logs', '--since', `${since}s`, 'ollama').split('\n').filter((l) => l.includes('/api/chat') && l.includes(n8nIp));
check(ollama.length > 0, `4. Ollama registró la llamada \`POST /api/chat\` desde el contenedor de n8n (${n8nIp}): «${(ollama.at(-1) ?? '').replace(/^.*\[GIN\]\s*/, '').trim()}» — **Ollama**`);
const msg = sql(env.APP_DB_NAME, `SELECT model || '|' || coalesce(latency_ms::text,'') || '|' || coalesce(prompt_tokens::text,'') || '|' || coalesce(completion_tokens::text,'') || '|' || mode
  FROM messages WHERE update_id = '${sent.json.update_id}' AND direction = 'outbound'`).split('|');
check(msg[4] === 'ai', `5. La API validó la interpretación (intent = ${row[2]}) y ejecutó las reglas: respuesta en modo «${msg[4]}», modelo ${msg[0]}, ${msg[1]} ms del modelo, tokens ${msg[2]}/${msg[3]} — **API**`);
const reply = upd.json.reply;
const real = reply?.options?.length ? Number(sql(env.APP_DB_NAME, `SELECT count(*) FROM reservable_slots WHERE slot_id IN (${reply.options.map((o) => `'${o.slot_id}'`).join(',')})`)) : 0;
check(real === (reply?.options?.length ?? -1) && real > 0, `6. Respuesta al paciente con ${reply?.options?.length ?? 0} horarios reales y reservables (comprobados en PostgreSQL) en ${elapsed} ms — **API**`);
log('');
log(`> Mensaje: «${text}»`);
log(`> Respuesta: «${(reply?.text ?? '').split('\n')[0]}»`);

log('');
log('## B. Cancelación → oferta → aceptación → cascada → estadísticas');
log('');
const [ta, tb, tc] = await Promise.all(['paciente05', 'paciente06', 'paciente07'].map(login));
for (const t of [ta, tb, tc]) {
  for (const a of (await call('GET', '/appointments?scope=upcoming&limit=100', t)).json.items.filter((x) => x.status === 'booked')) {
    const p = (await call('POST', '/action-intents', t, { kind: 'cancellation', appointment_id: a.id, expected_version: a.version })).json;
    await confirmOrder(t, p);
  }
}
const from = new Date(Date.now() + 11 * 86400_000).toISOString();
const to = new Date(Date.now() + 27 * 86400_000).toISOString();
const slots = (await call('GET', `/availability?doctor_service_id=40000000-0000-4000-8000-000000000001&from=${from}&to=${to}&limit=3`, ta)).json.items;
async function book(t, slot, optIn) {
  const p = (await call('POST', '/action-intents', t, { kind: 'booking', slot_id: slot, advance_opt_in: optIn })).json;
  return (await confirmOrder(t, p)).json.appointment;
}
const A = await book(ta, slots[0].slot_id, false);
const B = await book(tb, slots[1].slot_id, true);
const C = await book(tc, slots[2].slot_id, true);
check(Boolean(A && B && C), `7. Tres citas del mismo servicio: A ${A.booking_reference} (${slots[0].label}), B ${B.booking_reference} y C ${C.booking_reference} con ofertas activadas — **API**`);
const x = (await call('POST', '/action-intents', ta, { kind: 'cancellation', appointment_id: A.id, expected_version: A.version })).json;
await confirmOrder(ta, x);
const offB = sql(env.APP_DB_NAME, `SELECT id FROM advance_offers WHERE appointment_id = '${B.id}' AND status = 'pending'`);
check(Boolean(offB), '8. La cancelación de A abre una ronda y ofrece el horario a B, en la misma transacción — **API**');
const accB = await answerOffer(tb, offB, 'accept');
check(accB.status === 200 && sql(env.APP_DB_NAME, `SELECT slot_id FROM appointments WHERE id = '${B.id}'`) === slots[0].slot_id,
  `9. B acepta desde su bandeja (orden \`offer.answer\` → **n8n** rama 5d → API): su cita ${B.booking_reference} pasa al horario de A`);
const offC = sql(env.APP_DB_NAME, `SELECT id FROM advance_offers WHERE appointment_id = '${C.id}' AND status = 'pending'`);
check(Boolean(offC), '10. Cascada: el horario anterior de B se ofrece a C — **API**');
// Vencimiento por el planificador real de n8n
sql(env.APP_DB_NAME, `UPDATE advance_offers SET offered_at = now() - interval '1 minute', expires_at = now() - interval '1 second' WHERE id = '${offC}'`);
const forcedAt = sql(env.APP_DB_NAME, `SELECT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.MS')`);
log('  (Se adelanta el plazo de la oferta a C para no esperar 1 hora; el vencimiento lo procesa el planificador de n8n.)');
const tv = Date.now();
let st = 'pending';
while (st === 'pending' && Date.now() - tv < 90_000) { await new Promise((r) => setTimeout(r, 3000)); st = sql(env.APP_DB_NAME, `SELECT status FROM advance_offers WHERE id = '${offC}'`); }
// Primera ejecución del planificador que empezó después de adelantar el plazo y terminó con éxito
const sched = sql('n8n', `SELECT id || '|' || status || '|' || to_char("startedAt" AT TIME ZONE 'UTC', 'HH24:MI:SS') FROM execution_entity
  WHERE "workflowId" = 'scScheduler01' AND "startedAt" >= '${forcedAt}'::timestamp AT TIME ZONE 'UTC' AND status = 'success' ORDER BY id LIMIT 1`).split('|');
check(st === 'expired' && sched[0] !== '', `11. El workflow «Planificador» de n8n (ejecución #${sched[0]}, ${sched[1]}, inicio ${sched[2]} UTC) venció la oferta a C en ${Math.round((Date.now() - tv) / 1000)} s; C conserva su cita — **n8n → API**`);
const cookie = await (async () => {
  const r = await fetch(`${BASE}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'panel@saludcita.test', password: env.SEED_ADMIN_PASSWORD }) });
  return r.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
})();
const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Santo_Domingo' }).format(new Date());
const until = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Santo_Domingo' }).format(new Date(Date.now() + 86400_000));
const so = await (await fetch(`${BASE}/stats/offers?from=${day}&to=${until}`, { headers: { cookie } })).json();
check(so.data.offers_by_status.accepted >= 1 && so.data.offers_by_status.expired >= 1 && so.data.advance_minutes.n >= 1,
  `12. Estadísticas del panel (hoy): ${so.data.offers_by_status.accepted} aceptadas, ${so.data.offers_by_status.expired} vencidas; adelanto mediano ${so.data.advance_minutes.median ?? '—'} min (n = ${so.data.advance_minutes.n}); recuperación ${so.data.recovery.recovered_slots}/${so.data.recovery.freed_eligible_slots} — **API**`);

log('');
log('## Qué pasa por n8n y qué ejecuta la API');
log('');
log('| Paso | Ejecuta |');
log('|---|---|');
log('| Recibir el mensaje del paciente, fijar su identidad y persistirlo | API |');
log('| Avisar a n8n (webhook autenticado) | API → n8n |');
log('| Reclamar el mensaje con lease, llamar a Ollama y entregar el resultado | **n8n** (workflow «Conversación») |');
log('| Interpretar intención y entidades | **Ollama** (modelo local), llamado por n8n |');
log('| Validar el JSON, anclar entidades, consultar la agenda y redactar la respuesta | API (reglas deterministas) |');
log('| Botones (menú, elegir horario, aclaraciones) | API directamente, sin n8n ni modelo |');
log('| Preparar y confirmar reservas, cancelaciones y cambios | API (transacción), desde el backend de Gradio |');
log('| Abrir rondas, ofrecer, aceptar y cascada | API (en la transacción que libera el horario) |');
log('| Vencer ofertas, publicar recordatorios, recuperar leases y ampliar la agenda | **n8n** (workflow «Planificador», cada minuto) → API |');
log('| Estadísticas | API (consultas sobre datos persistidos) |');
log('| Google Calendar | **Pendiente**: workflow importado sin publicar; sin credenciales ni prueba real |');
log('');
log(fails ? `**${fails} comprobaciones fallidas.**` : '**Todas las comprobaciones superadas.**');
if (OUT) writeFileSync(OUT.startsWith("/") ? OUT : `${ROOT}${OUT}`, lines.join('\n') + '\n');
process.exit(fails ? 1 : 0);
