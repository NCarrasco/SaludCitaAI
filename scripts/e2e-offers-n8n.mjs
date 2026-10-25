#!/usr/bin/env node
// Prueba extremo a extremo REAL de ofertas con el planificador de n8n (sin llamar al tick a mano):
// cancelación → oferta → vencimiento procesado por el workflow «Planificador» → oferta al siguiente → aceptación → cascada.
// Requiere el Compose levantado. Uso: node scripts/e2e-offers-n8n.mjs
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

const env = Object.fromEntries(readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')
  .filter((l) => /^[A-Z0-9_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const BASE = `http://127.0.0.1:${env.API_HOST_PORT ?? 8080}/api/v1`;
const sql = (q) => execFileSync('docker', ['compose', '--env-file', '.env', '-f', 'infra/compose.yaml', 'exec', '-T', 'postgres',
  'psql', '-U', 'postgres', '-d', env.APP_DB_NAME, '-tAc', q], { encoding: 'utf8', cwd: new URL('..', import.meta.url).pathname }).trim();
let fails = 0;
const check = (ok, m) => { console.log(`${ok ? '✔' : '✘'} ${m}`); if (!ok) fails++; };
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
async function book(t, slot, optIn) {
  const p = (await call('POST', '/action-intents', t, { kind: 'booking', slot_id: slot, advance_opt_in: optIn })).json;
  return (await confirmOrder(t, p)).json.appointment;
}
async function cancelAppt(t, a) {
  const p = (await call('POST', '/action-intents', t, { kind: 'cancellation', appointment_id: a.id, expected_version: a.version })).json;
  return (await confirmOrder(t, p)).json;
}
const pending = (apptId) => sql(`SELECT id FROM advance_offers WHERE appointment_id = '${apptId}' AND status = 'pending'`);

const [ta, tb, tc] = await Promise.all(['paciente14', 'paciente15', 'paciente16'].map(login));
const from = new Date(Date.now() + 9 * 86400_000).toISOString();
const to = new Date(Date.now() + 23 * 86400_000).toISOString();
const slots = (await call('GET', `/availability?doctor_service_id=40000000-0000-4000-8000-000000000005&from=${from}&to=${to}&limit=3`, ta)).json.items;
const A = await book(ta, slots[0].slot_id, false);
const B = await book(tb, slots[1].slot_id, true);
const C = await book(tc, slots[2].slot_id, true);
check(A && B && C, `tres citas reservadas (${A.booking_reference}, ${B.booking_reference}, ${C.booking_reference})`);
await cancelAppt(ta, A);
const offB = pending(B.id);
check(Boolean(offB), 'la cancelación abre una oferta para el primer candidato (B)');
const inbox = (await call('GET', '/offers', tb)).json.items;
check(inbox.some((o) => o.id === offB && o.status === 'pending'), 'B ve la oferta en su bandeja');

// Vencimiento procesado por n8n: se adelanta el plazo y se espera al workflow (máx. 90 s)
sql(`UPDATE advance_offers SET offered_at = now() - interval '2 hours', expires_at = now() - interval '1 second' WHERE id = '${offB}'`);
const t0 = Date.now();
let st = 'pending';
while (st === 'pending' && Date.now() - t0 < 90_000) {
  await new Promise((r) => setTimeout(r, 3000));
  st = sql(`SELECT status FROM advance_offers WHERE id = '${offB}'`);
}
check(st === 'expired', `el planificador de n8n venció la oferta (${Math.round((Date.now() - t0) / 1000)} s)`);
const offC = pending(C.id);
check(Boolean(offC), 'y la ofreció al siguiente candidato (C)');
const acc = await answerOffer(tc, offC, 'accept');
check(acc.status === 200, 'C acepta: su cita se adelanta');
check(sql(`SELECT slot_id FROM appointments WHERE id = '${C.id}'`) === slots[0].slot_id, 'la cita de C ocupa el horario liberado (misma referencia)');
const cascade = sql(`SELECT status FROM offer_rounds WHERE slot_id = '${slots[2].slot_id}' ORDER BY created_at DESC LIMIT 1`);
check(cascade !== '', `el horario anterior de C abrió una ronda en cascada (estado: ${cascade})`);
check(sql(`SELECT version FROM appointments WHERE id = '${B.id}'`) === '1', 'B conserva su cita original');
console.log(fails ? `\n${fails} fallos` : '\nPrueba de ofertas con n8n superada.');
process.exit(fails ? 1 : 0);
