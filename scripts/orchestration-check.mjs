#!/usr/bin/env node
// Comprobación REAL de la orquestación (C) y del comprobante (E) con n8n y PostgreSQL del Compose local.
// La confirmación de citas pasa por n8n (orden appointment.confirm), igual que en la interfaz.
// Detiene y reinicia SOLO el contenedor n8n de este proyecto. Uso: node scripts/orchestration-check.mjs [--out archivo.md]
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const env = Object.fromEntries(readFileSync('.env', 'utf8').split('\n').filter((l) => /^[A-Z0-9_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const V1 = `http://127.0.0.1:${env.API_HOST_PORT || 8080}/api/v1`;
const OUT = process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : null;
const SVC = { authorization: `Bearer svc_${env.N8N_API_SERVICE_TOKEN}`, 'content-type': 'application/json' };
const compose = (...a) => execFileSync('docker', ['compose', '--env-file', '.env', '-f', 'infra/compose.yaml', ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const sql = (db, q) => compose('exec', '-T', 'postgres', 'sh', '-c', `psql -U "$POSTGRES_USER" -d ${db} -At -F '|' -c "${q.replace(/"/g, '\\"')}"`).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lines = []; let failures = 0;
const log = (s) => { console.log(s); lines.push(s); };
const check = (ok, s) => { if (!ok) failures++; log(`- ${ok ? '✔' : '✘'} ${s}`); };

async function login(u) {
  return (await (await fetch(`${V1}/patient-auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: u, password: env.SEED_PATIENT_PASSWORD }) })).json()).token;
}
const H = (t) => ({ authorization: `Bearer ${t}`, 'content-type': 'application/json' });
async function freeSlot(t, svc, skip) {
  const from = new Date(Date.now() + 12 * 86400e3).toISOString(); const to = new Date(Date.now() + 28 * 86400e3).toISOString();
  return (await (await fetch(`${V1}/availability?doctor_service_id=${svc}&from=${from}&to=${to}&limit=${skip + 1}`, { headers: H(t) })).json()).items[skip];
}
// Confirmación como la hace la interfaz: orden → n8n la reclama → la API la ejecuta → resultado
const confirmation = async (t, id) => (await fetch(`${V1}/action-intents/${id}/confirmation`, { headers: H(t) })).json();
async function submitAndWait(t, p, key, waitMs) {
  const t0 = Date.now();
  const o = await (await fetch(`${V1}/action-intents/${p.intent_id}/submit`, { method: 'POST', headers: { ...H(t), 'idempotency-key': key }, body: JSON.stringify({ token: p.token }) })).json();
  let st; do { await sleep(200); st = await confirmation(t, p.intent_id); } while (['queued', 'running'].includes(st.status) && Date.now() - t0 < waitMs);
  return { o, st, c: st.result ?? {}, ms: Date.now() - t0 };
}
async function book(t, slotId, key = randomUUID(), waitMs = 40000) {
  const p = await (await fetch(`${V1}/action-intents`, { method: 'POST', headers: H(t), body: JSON.stringify({ kind: 'booking', slot_id: slotId }) })).json();
  return { p, key, ...(await submitAndWait(t, p, key, waitMs)) };
}
const receipt = async (t, id) => (await fetch(`${V1}/appointments/${id}/receipt`, { headers: H(t) })).json();
async function waitReady(t, id, ms) { const t0 = Date.now(); let s; do { await sleep(500); s = await receipt(t, id); } while (s.status !== 'ready' && Date.now() - t0 < ms); return { s, ms: Date.now() - t0 }; }
const execsFor = (needle) => sql('n8n', `SELECT e.id || '|' || e.status FROM execution_entity e JOIN execution_data d ON d."executionId" = e.id
  WHERE e."workflowId" = 'scCommands01' AND d.data LIKE '%${needle}%' ORDER BY e.id`).split('\n').filter(Boolean);

log(`# Orquestación con n8n y comprobante PDF — comprobación real (${new Date().toISOString()})\n`);
const SVC_SOSA = '40000000-0000-4000-8000-000000000003', SVC_TAV = '40000000-0000-4000-8000-000000000004';
const ta = await login('paciente05'); const tb = await login('paciente06');

log('## 1. «Confirmar» → orden en n8n → la API confirma → PDF por n8n');
const s1 = await freeSlot(ta, SVC_SOSA, 0);
const A = await book(ta, s1.slot_id);
const apA = A.c.appointment;
check(A.st.status === 'confirmed' && apA?.status === 'booked', `La orden ${A.o.command_id} (appointment.confirm) la ejecutó n8n: cita ${apA?.booking_reference} confirmada en ${A.ms} ms`);
const exConfirm = execsFor(A.o.command_id);
check(exConfirm.length >= 1 && exConfirm.every((x) => x.endsWith('success')), `Ejecución real de n8n «Comandos durables», rama «Confirmar cita»: ${exConfirm.map((x) => '#' + x.split('|')[0]).join(', ')}`);
const corr = sql('saludcita', `SELECT correlation_id FROM appointment_events WHERE appointment_id = '${apA.id}' AND event_type = 'booked'`);
check(corr === A.o.correlation_id, `La cita registra el correlation_id de la orden enviada desde la interfaz (${corr})`);
const r1 = await waitReady(ta, apA.id, 40000);
const cmdA = sql('saludcita', `SELECT id || '|' || attempts || '|' || coalesce(correlation_id::text,'') FROM outbox_jobs WHERE kind = 'receipt.render' AND aggregate_id = '${apA.id}'`).split('|');
check(r1.s.status === 'ready', `Cita ${apA.booking_reference}: comprobante n.º ${r1.s.receipt_number} listo en ${r1.ms} ms (aviso inmediato por webhook)`);
check(cmdA[2] === corr, `El comando del PDF ${cmdA[0]} lleva el mismo correlation_id`);
const exA = execsFor(cmdA[0]);
check(exA.length >= 1 && exA.every((x) => x.endsWith('success')), `Ejecución real de n8n «Comandos durables» con ese comando: ${exA.map((x) => '#' + x.split('|')[0]).join(', ')}`);
const pdfOwn = await fetch(`${V1}/appointments/${apA.id}/receipt.pdf`, { headers: H(ta) });
const bytes = Buffer.from(await pdfOwn.arrayBuffer());
check(pdfOwn.status === 200 && bytes.subarray(0, 8).toString('latin1') === '%PDF-1.4' && bytes.toString('latin1').includes(apA.booking_reference), `El dueño descarga el PDF (${bytes.length} bytes, contiene la referencia)`);
check((await fetch(`${V1}/appointments/${apA.id}/receipt.pdf`, { headers: H(tb) })).status === 404, 'Otro paciente recibe 404 (no se revela la existencia)');
check((await fetch(`${V1}/appointments/${apA.id}/receipt.pdf`)).status === 401, 'Sin sesión: 401');

log('\n## 2. Confirmación duplicada');
const again = await submitAndWait(ta, A.p, A.key, 10000);
const nJobs = sql('saludcita', `SELECT count(*) FROM outbox_jobs WHERE kind = 'receipt.render' AND aggregate_id = '${apA.id}'`);
const nOrders = sql('saludcita', `SELECT count(*) FROM outbox_jobs WHERE kind = 'appointment.confirm' AND aggregate_id = '${A.p.intent_id}'`);
check(again.o.command_id === A.o.command_id && again.c.appointment?.id === apA.id && nJobs === '1' && nOrders === '1',
  `Repetir «Confirmar» (misma clave) devuelve la misma orden y la misma cita: ${nOrders} orden, ${nJobs} comando de PDF`);

log('\n## 3. n8n caído y reinicio');
compose('stop', 'n8n');
const s2 = await freeSlot(tb, SVC_SOSA, 0);
const B = await book(tb, s2.slot_id, randomUUID(), 20000);
const apptsWhileDown = sql('saludcita', `SELECT count(*) FROM appointments WHERE slot_id = '${s2.slot_id}' AND status = 'booked'`);
check(B.st.status === 'queued' && apptsWhileDown === '0', `Con n8n detenido la orden queda en cola («${B.st.status}») y NO hay cita todavía (${apptsWhileDown} citas en ese horario)`);
const tStart = Date.now();
compose('start', 'n8n');
let stB; do { await sleep(1000); stB = await confirmation(tb, B.p.intent_id); } while (['queued', 'running'].includes(stB.status) && Date.now() - tStart < 110000);
check(stB.status === 'confirmed', `Tras reiniciar n8n la orden se ejecuta sin intervención dentro del plazo de 120 s: «${stB.status}» a los ${Math.round((Date.now() - tStart) / 1000)} s del arranque`);
const r2 = await waitReady(tb, stB.result?.appointment?.id, 60000);
check(r2.s.status === 'ready', `Y su comprobante PDF se genera después (${stB.result?.appointment?.booking_reference})`);

log('\n## 4. n8n cae después de reclamar (lease vencido)');
// Con n8n detenido se reclama un comando real (simula un n8n que lo tomó y cayó a mitad) y se arranca n8n de nuevo
compose('stop', 'n8n');
const leaseCmd = sql('saludcita', `INSERT INTO outbox_jobs (kind, dedupe_key, payload) VALUES ('maintenance.guest_cleanup', 'guest_cleanup:lease:${randomUUID()}', '{}') RETURNING id`).split('\n')[0];
const claimed = (await (await fetch(`${V1}/internal/commands/claim`, { method: 'POST', headers: SVC, body: JSON.stringify({ kinds: ['maintenance.guest_cleanup'], limit: 10 }) })).json()).items;
const lt = claimed.find((x) => x.command_id === leaseCmd);
check(Boolean(lt), `Comando reclamado y abandonado (simula un n8n que cae a mitad): intento ${lt?.attempt}`);
compose('start', 'n8n');
const t4 = Date.now();
let st4 = ''; while (st4 !== 'done' && Date.now() - t4 < 260000) { await sleep(2000); st4 = sql('saludcita', `SELECT status FROM outbox_jobs WHERE id = '${leaseCmd}'`); }
const attempts = sql('saludcita', `SELECT attempts FROM outbox_jobs WHERE id = '${leaseCmd}'`);
check(st4 === 'done' && Number(attempts) >= 2 && execsFor(leaseCmd).length >= 1,
  `Al vencer el lease (120 s) n8n lo reclama y termina: ${Math.round((Date.now() - t4) / 1000)} s, intentos = ${attempts}, ejecución ${execsFor(leaseCmd).map((x) => '#' + x.split('|')[0]).join(', ')}`);

log('\n## 4b. Sin atajos: la API no ejecuta operaciones del paciente fuera de n8n');
const s4 = await freeSlot(ta, SVC_TAV, 0);
const p4 = await (await fetch(`${V1}/action-intents`, { method: 'POST', headers: H(ta), body: JSON.stringify({ kind: 'booking', slot_id: s4.slot_id }) })).json();
const direct = await fetch(`${V1}/action-intents/${p4.intent_id}/confirm`, { method: 'POST', headers: { ...H(ta), 'idempotency-key': randomUUID() }, body: JSON.stringify({ token: p4.token }) });
const oldAccept = await fetch(`${V1}/offers/${randomUUID()}/accept`, { method: 'POST', headers: { ...H(ta), 'idempotency-key': randomUUID() }, body: '{}' });
const asPatient = await fetch(`${V1}/internal/commands/${randomUUID()}/confirm`, { method: 'POST', headers: H(ta), body: JSON.stringify({ lease_token: randomUUID() }) });
check(direct.status === 404 && oldAccept.status === 404 && asPatient.status === 403,
  `Rutas directas retiradas (confirmar ${direct.status}, aceptar adelanto ${oldAccept.status}) y el ejecutor interno rechaza a un paciente (${asPatient.status})`);

log('\n## 5. Reprogramación → comprobante actualizado');
const s5 = await freeSlot(ta, SVC_SOSA, 1);
const pr = await (await fetch(`${V1}/action-intents`, { method: 'POST', headers: H(ta), body: JSON.stringify({ kind: 'reschedule', appointment_id: apA.id, expected_version: 1, new_slot_id: s5.slot_id }) })).json();
const resched = await submitAndWait(ta, pr, randomUUID(), 40000);
check(resched.st.status === 'confirmed' && resched.c.outcome === 'rescheduled', `Reprogramación ejecutada por n8n (orden ${resched.o.command_id}) en ${resched.ms} ms`);
const r5 = await waitReady(ta, apA.id, 40000);
const hist = sql('saludcita', `SELECT string_agg(receipt_number || ':' || status, ', ' ORDER BY receipt_number) FROM appointment_receipts WHERE appointment_id = '${apA.id}'`);
check(r5.s.status === 'ready' && r5.s.receipt_number === 2 && hist === '1:superseded, 2:ready', `Reprogramada: comprobante n.º 2 listo; historial ${hist}`);

log('\n## 6. Recordatorio y limpieza ejecutados por n8n');
sql('saludcita', `UPDATE outbox_jobs SET available_at = now() WHERE kind = 'reminder.24h' AND aggregate_id = '${apA.id}' AND status = 'pending'`);
const remId = sql('saludcita', `SELECT id FROM outbox_jobs WHERE kind = 'reminder.24h' AND aggregate_id = '${apA.id}' AND status = 'pending'`);
let remSt = ''; for (let i = 0; i < 60 && remSt !== 'done' && remSt !== 'cancelled'; i++) { await sleep(1000); remSt = sql('saludcita', `SELECT status FROM outbox_jobs WHERE id = '${remId}'`); }
check(remSt === 'done' && execsFor(remId).length >= 1, `Recordatorio de 24 h publicado por la rama 5b (estado ${remSt}, ejecución ${execsFor(remId).map((x) => '#' + x.split('|')[0]).join(', ')})`);
const cl = sql('saludcita', `INSERT INTO outbox_jobs (kind, dedupe_key, payload) VALUES ('maintenance.guest_cleanup', 'guest_cleanup:check:${randomUUID()}', '{}') RETURNING id`).split('\n')[0];
let clSt = ''; for (let i = 0; i < 60 && clSt !== 'done'; i++) { await sleep(1000); clSt = sql('saludcita', `SELECT status FROM outbox_jobs WHERE id = '${cl}'`); }
const clRes = sql('saludcita', `SELECT result FROM outbox_jobs WHERE id = '${cl}'`);
check(clSt === 'done', `Limpieza de invitados ejecutada por la rama 5c: ${clRes}`);

log(`\n**${failures === 0 ? 'Todas las comprobaciones superadas.' : `${failures} comprobación(es) fallaron.`}**`);
if (OUT) writeFileSync(OUT, lines.join('\n') + '\n');
process.exit(failures ? 1 : 0);
