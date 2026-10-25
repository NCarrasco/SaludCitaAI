// Incrementos C (comandos durables orquestados por n8n) y E (comprobante PDF). n8n se SIMULA llamando a los
// mismos endpoints que usa el workflow «Comandos durables»; la prueba real con n8n está en scripts/orchestration-check.mjs.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { P, SERVICE, auth, book, confirm, freeSlots, login, prepare, resetAgenda, setupApp, teardown, type Ctx } from '../helpers/app.js';
import { TEST_GATEWAY_SECRET, TEST_SERVICE_SECRET } from '../helpers/env.js';

let ctx: Ctx;
const SVC = auth(`svc_${TEST_SERVICE_SECRET}`);
beforeAll(async () => { ctx = await setupApp(); });
afterAll(async () => { await teardown(ctx); });
beforeEach(async () => { await resetAgenda(ctx); });

const claim = async (kinds: string[]) => (await ctx.app.inject({ method: 'POST', url: `${P}/internal/commands/claim`, headers: SVC, payload: { kinds } })).json().items;
const run = (id: string, path: string, lease: string) => ctx.app.inject({ method: 'POST', url: `${P}/internal/commands/${id}/${path}`, headers: SVC, payload: { lease_token: lease } });
const fail = (id: string, lease: string, error = 'fallo simulado') => ctx.app.inject({ method: 'POST', url: `${P}/internal/commands/${id}/fail`, headers: SVC, payload: { lease_token: lease, error } });
/** n8n simulado: reclama y genera los comprobantes pendientes. */
async function renderReceipts() {
  const items = await claim(['receipt.render']);
  for (const it of items) expect((await run(it.command_id, 'receipt', it.lease_token)).statusCode).toBe(200);
  return items;
}

describe('C · comandos durables', () => {
  it('una confirmación encarga sus comandos con el correlation_id de la operación; confirmar dos veces no los duplica', async () => {
    const t = await login(ctx, 3);
    const [s] = await freeSlots(ctx, SERVICE.sosa, 1, 40);
    const p = (await prepare(ctx, t, { kind: 'booking', slot_id: s!.slot_id })).json();
    const key = randomUUID();
    const c1 = await confirm(ctx, t, p.intent_id, p.token, key);
    const c2 = await confirm(ctx, t, p.intent_id, p.token, key);          // reintento idempotente (misma clave)
    expect(c2.json().appointment.id).toBe(c1.json().appointment.id);
    const c3 = await confirm(ctx, t, p.intent_id, p.token, randomUUID()); // otra clave: la intención ya se consumió
    if (c3.statusCode === 200) expect(c3.json().appointment.id).toBe(c1.json().appointment.id);  // mismo resultado, sin duplicar
    const apptId = c1.json().appointment.id;
    expect((await ctx.db.query(`SELECT count(*)::int n FROM appointments WHERE patient_id = (SELECT patient_id FROM appointments WHERE id = $1)
      AND slot_id = $2`, [apptId, s!.slot_id])).rows[0].n).toBe(1);
    const jobs = (await ctx.db.query(`SELECT kind, correlation_id FROM outbox_jobs WHERE aggregate_id = $1 ORDER BY kind`, [apptId])).rows;
    expect(jobs.filter((j) => j.kind === 'receipt.render')).toHaveLength(1);
    const corr = (await ctx.db.query(`SELECT correlation_id FROM appointment_events WHERE appointment_id = $1 AND event_type = 'booked'`, [apptId])).rows[0].correlation_id;
    expect(jobs.every((j) => j.correlation_id === corr)).toBe(true);
    const claimed = await claim(['receipt.render']);
    expect(claimed[0].correlation_id).toBe(corr);
  });

  it('n8n caído: los comandos esperan; tras un reinicio con el lease vencido se reclaman de nuevo; ejecutar dos veces es idempotente', async () => {
    const t = await login(ctx, 4);
    const [s] = await freeSlots(ctx, SERVICE.taveras, 1, 40);
    const ap = await book(ctx, t, s!.slot_id);
    const [first] = await claim(['receipt.render']);
    expect(first.attempt).toBe(1);
    expect(await claim(['receipt.render'])).toHaveLength(0);              // con lease vigente nadie más lo toma
    await ctx.db.query(`UPDATE outbox_jobs SET lease_until = now() - interval '1 second' WHERE id = $1`, [first.command_id]);  // n8n murió
    const [again] = await claim(['receipt.render']);
    expect(again.command_id).toBe(first.command_id);
    expect(again.attempt).toBe(2);
    expect((await run(first.command_id, 'receipt', first.lease_token)).statusCode).toBe(409);  // el lease viejo ya no vale
    const r1 = (await run(again.command_id, 'receipt', again.lease_token)).json();
    const r2 = (await run(again.command_id, 'receipt', again.lease_token)).json();             // reintento del mismo paso
    expect(r1.result.outcome).toBe('ready');
    expect(r2.result).toEqual(r1.result);
    expect((await ctx.db.query(`SELECT count(*)::int n FROM appointment_receipts WHERE appointment_id = $1 AND status = 'ready'`, [ap.id])).rows[0].n).toBe(1);
  });

  it('un tipo de comando solo se ejecuta por su rama (endpoint)', async () => {
    const t = await login(ctx, 5);
    const [s] = await freeSlots(ctx, SERVICE.mendez, 1, 40);
    await book(ctx, t, s!.slot_id);
    const [it] = await claim(['receipt.render']);
    expect((await run(it.command_id, 'reminder', it.lease_token)).statusCode).toBe(409);
  });

  it('los endpoints de comandos exigen la credencial de servicio', async () => {
    const t = await login(ctx, 6);
    expect((await ctx.app.inject({ method: 'POST', url: `${P}/internal/commands/claim`, headers: auth(t), payload: {} })).statusCode).toBe(403);
    expect((await ctx.app.inject({ method: 'POST', url: `${P}/internal/commands/claim`, payload: {} })).statusCode).toBe(401);
  });

  it('limpieza de invitados: borra solo invitados abandonados y vacíos; conserva citas, historial y la posibilidad de recuperar', async () => {
    const gw = auth(`svc_${TEST_GATEWAY_SECRET}`);
    const guest = async () => (await ctx.app.inject({ method: 'POST', url: `${P}/gateway/guest-sessions`, headers: gw, payload: { client_ip: `198.51.100.${Math.floor(Math.random() * 200) + 1}` } })).json();
    const empty = await guest();          // abandonado y vacío → se borra
    const withAppt = await guest();       // con cita → se conserva
    const withCode = await guest();       // con código de recuperación vigente → se conserva
    const withChat = await guest();       // con conversación → se conserva
    await ctx.app.inject({ method: 'PATCH', url: `${P}/patients/me`, headers: auth(withAppt.token), payload: { full_name: 'Invitado Con Cita', birth_date: '1990-01-01', phone: '(809) 555-0199' } });
    const [s] = await freeSlots(ctx, SERVICE.sosa, 1, 45);
    const ap = await book(ctx, withAppt.token, s!.slot_id);
    const code = (await ctx.app.inject({ method: 'POST', url: `${P}/patient-auth/recovery-code`, headers: auth(withCode.token) })).json().recovery_code;
    await ctx.app.inject({ method: 'POST', url: `${P}/conversation/messages`, headers: auth(withChat.token), payload: { client_message_id: randomUUID(), text: 'hola' } });
    const ids = [empty, withAppt, withCode, withChat].map((g) => g.patient.id);
    // Todos «abandonados»: creados hace 60 días y con sesiones caducadas hace 30
    await ctx.db.query(`UPDATE patients SET created_at = now() - interval '60 days' WHERE id = ANY($1::uuid[])`, [ids]);
    await ctx.db.query(`UPDATE patient_sessions SET created_at = now() - interval '60 days', expires_at = now() - interval '30 days' WHERE patient_id = ANY($1::uuid[])`, [ids]);
    await ctx.db.query(`INSERT INTO outbox_jobs (kind, dedupe_key, payload) VALUES ('maintenance.guest_cleanup', $1, '{}')`, [`guest_cleanup:test:${randomUUID()}`]);
    const [it] = await claim(['maintenance.guest_cleanup']);
    const r = (await run(it.command_id, 'guest-cleanup', it.lease_token)).json();
    expect(r.result.empty_guests_deleted).toBe(1);
    const left = (await ctx.db.query(`SELECT id FROM patients WHERE id = ANY($1::uuid[])`, [ids])).rows.map((x) => x.id);
    expect(left).not.toContain(empty.patient.id);
    expect(left).toEqual(expect.arrayContaining([withAppt.patient.id, withCode.patient.id, withChat.patient.id]));
    expect((await ctx.db.query(`SELECT status FROM appointments WHERE id = $1`, [ap.id])).rows[0].status).toBe('booked');
    expect((await ctx.db.query(`SELECT count(*)::int n FROM messages m JOIN conversations cv ON cv.id = m.conversation_id
      JOIN channel_identities ci ON ci.id = cv.channel_identity_id WHERE ci.patient_id = $1`, [withChat.patient.id])).rows[0].n).toBeGreaterThan(0);
    // El invitado con código aún puede recuperar su acceso (sin fecha de nacimiento registrada basta el código)
    const rec = await ctx.app.inject({ method: 'POST', url: `${P}/gateway/recover`, headers: gw, payload: { code, client_ip: '198.51.100.250' } });
    expect(rec.statusCode).toBe(200);
  });
});

describe('E · comprobante PDF', () => {
  it('tras confirmar se genera un PDF versionado con datos verificados; solo el dueño lo descarga', async () => {
    const t = await login(ctx, 7);
    const other = await login(ctx, 8);
    const [s] = await freeSlots(ctx, SERVICE.sosa, 1, 50);
    const ap = await book(ctx, t, s!.slot_id);
    const st0 = (await ctx.app.inject({ url: `${P}/appointments/${ap.id}/receipt`, headers: auth(t) })).json();
    expect(st0.status).toBe('pending');
    expect((await ctx.app.inject({ url: `${P}/appointments/${ap.id}/receipt.pdf`, headers: auth(t) })).statusCode).toBe(409);  // aún no listo
    await renderReceipts();
    const st = (await ctx.app.inject({ url: `${P}/appointments/${ap.id}/receipt`, headers: auth(t) })).json();
    expect(st).toMatchObject({ status: 'ready', receipt_number: 1, version: 1 });
    const pdf = await ctx.app.inject({ url: `${P}/appointments/${ap.id}/receipt.pdf`, headers: auth(t) });
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.rawPayload.subarray(0, 8).toString('latin1')).toBe('%PDF-1.4');
    expect(pdf.rawPayload.toString('latin1')).toContain(ap.booking_reference);   // referencia verificada en el documento
    expect(pdf.rawPayload.toString('latin1')).toContain('%%EOF');
    // Otro paciente o sin sesión: no
    expect((await ctx.app.inject({ url: `${P}/appointments/${ap.id}/receipt.pdf`, headers: auth(other) })).statusCode).toBe(404);
    expect((await ctx.app.inject({ url: `${P}/appointments/${ap.id}/receipt.pdf` })).statusCode).toBe(401);
  });

  it('una reprogramación genera un comprobante n.º 2; el anterior queda superado; cancelar los anula', async () => {
    const t = await login(ctx, 9);
    const [s1, s2] = await freeSlots(ctx, SERVICE.taveras, 2, 50);
    const ap = await book(ctx, t, s1!.slot_id);
    await renderReceipts();
    const p = (await prepare(ctx, t, { kind: 'reschedule', appointment_id: ap.id, expected_version: 1, new_slot_id: s2!.slot_id })).json();
    expect((await confirm(ctx, t, p.intent_id, p.token)).statusCode).toBe(200);
    await renderReceipts();
    const rows = (await ctx.db.query(`SELECT receipt_number, appointment_version, status FROM appointment_receipts WHERE appointment_id = $1 ORDER BY receipt_number`, [ap.id])).rows;
    expect(rows).toEqual([{ receipt_number: 1, appointment_version: 1, status: 'superseded' }, { receipt_number: 2, appointment_version: 2, status: 'ready' }]);
    const pdf = (await ctx.app.inject({ url: `${P}/appointments/${ap.id}/receipt.pdf`, headers: auth(t) })).rawPayload.toString('latin1');
    expect(pdf).toContain('Comprobante n.\\272 2');               // «n.º 2» en WinAnsi
    const c = (await prepare(ctx, t, { kind: 'cancellation', appointment_id: ap.id, expected_version: 2 })).json();
    await confirm(ctx, t, c.intent_id, c.token);
    expect((await ctx.db.query(`SELECT array_agg(DISTINCT status) s FROM appointment_receipts WHERE appointment_id = $1`, [ap.id])).rows[0].s).toEqual(['void']);
    expect((await ctx.app.inject({ url: `${P}/appointments/${ap.id}/receipt.pdf`, headers: auth(t) })).statusCode).toBe(404);
  });

  it('si el PDF falla, la cita sigue confirmada; tras agotar reintentos queda «failed» y el dueño puede reintentar', async () => {
    const t = await login(ctx, 10);
    const [s] = await freeSlots(ctx, SERVICE.mendez, 1, 55);
    const ap = await book(ctx, t, s!.slot_id);
    for (let i = 0; i < 5; i++) {
      await ctx.db.query(`UPDATE outbox_jobs SET available_at = now() WHERE kind = 'receipt.render' AND aggregate_id = $1`, [ap.id]);
      const [it] = await claim(['receipt.render']);
      const f = (await fail(it.command_id, it.lease_token, 'n8n: error al generar (simulado)')).json();
      expect(f.status).toBe(i < 4 ? 'pending' : 'dead');
    }
    expect((await ctx.db.query(`SELECT status FROM appointments WHERE id = $1`, [ap.id])).rows[0].status).toBe('booked');
    expect((await ctx.app.inject({ url: `${P}/appointments/${ap.id}/receipt`, headers: auth(t) })).json().status).toBe('failed');
    expect((await ctx.app.inject({ method: 'POST', url: `${P}/appointments/${ap.id}/receipt/retry`, headers: auth(await login(ctx, 11)) })).statusCode).toBe(404);
    expect((await ctx.app.inject({ method: 'POST', url: `${P}/appointments/${ap.id}/receipt/retry`, headers: auth(t) })).json().status).toBe('pending');
    await renderReceipts();
    expect((await ctx.app.inject({ url: `${P}/appointments/${ap.id}/receipt`, headers: auth(t) })).json().status).toBe('ready');
  });
});
