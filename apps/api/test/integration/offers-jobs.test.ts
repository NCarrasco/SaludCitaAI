import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { P, SERVICE, answerOffer, auth, book, confirm, freeSlots, login, prepare, resetAgenda, setupApp, teardown, type Ctx } from '../helpers/app.js';
import { TEST_SERVICE_SECRET } from '../helpers/env.js';

let ctx: Ctx;
const SVC = auth(`svc_${TEST_SERVICE_SECRET}`);
beforeAll(async () => { ctx = await setupApp(); });
afterAll(async () => { await teardown(ctx); });
beforeEach(async () => { await resetAgenda(ctx); });

const cancel = async (t: string, apptId: string, version = 1) => {
  const p = (await prepare(ctx, t, { kind: 'cancellation', appointment_id: apptId, expected_version: version })).json();
  const r = await confirm(ctx, t, p.intent_id, p.token);
  expect(r.statusCode).toBe(200);
};
const offerAction = (t: string, id: string, action: 'accept' | 'reject', key = randomUUID()) => answerOffer(ctx, t, id, action, key);
const pendingOffer = async (apptId: string) =>
  (await ctx.db.query(`SELECT id, round_id FROM advance_offers WHERE appointment_id = $1 AND status = 'pending'`, [apptId])).rows[0] as { id: string; round_id: string } | undefined;
const tick = () => ctx.app.inject({ method: 'POST', url: `${P}/internal/scheduler/tick`, headers: SVC });

/** Escenario: cuatro citas del mismo servicio; A (sin ofertas) en s0, B, C y D aceptan ofertas en s1, s2, s3. */
async function scenario() {
  const s = await freeSlots(ctx, SERVICE.taveras, 4, 6);
  const [ta, tb, tc, td] = await Promise.all([1, 2, 3, 4].map((n) => login(ctx, n)));
  const A = await book(ctx, ta!, s[0]!.slot_id);
  const B = await book(ctx, tb!, s[1]!.slot_id, { advance_opt_in: true });
  const C = await book(ctx, tc!, s[2]!.slot_id, { advance_opt_in: true });
  const D = await book(ctx, td!, s[3]!.slot_id, { advance_opt_in: true });
  return { s, t: { A: ta!, B: tb!, C: tc!, D: td! }, A, B, C, D };
}

describe('ofertas secuenciales y cascada', () => {
  it('cancelación → oferta al primer candidato; el horario queda retenido; dos aceptaciones en cascada; rechazo agota la ronda', async () => {
    const { s, t, A, B, C, D } = await scenario();
    await cancel(t.A, A.id);
    const offB = await pendingOffer(B.id);
    expect(offB).toBeTruthy();
    expect(await pendingOffer(C.id)).toBeUndefined(); // una sola oferta pendiente por ronda
    const notif = await ctx.app.inject({ url: `${P}/notifications`, headers: auth(t.B) });
    expect(notif.json().items[0].kind).toBe('advance_offer');
    // Retenido: otro paciente no puede reservarlo mientras la oferta está pendiente
    const other = await prepare(ctx, await login(ctx, 5), { kind: 'booking', slot_id: s[0]!.slot_id });
    expect(other.json().error.details.reason).toBe('held_by_offer');

    const acc = await offerAction(t.B, offB!.id, 'accept');
    expect(acc.statusCode).toBe(200);
    const b = (await ctx.db.query(`SELECT slot_id, version, booking_reference FROM appointments WHERE id = $1`, [B.id])).rows[0];
    expect(b).toMatchObject({ slot_id: s[0]!.slot_id, version: 2, booking_reference: B.booking_reference }); // misma cita
    expect((await ctx.db.query(`SELECT event_type FROM appointment_events WHERE appointment_id = $1 ORDER BY occurred_at DESC LIMIT 1`, [B.id])).rows[0].event_type).toBe('advanced');

    // Cascada: el horario anterior de B (s1) se ofrece a C
    const offC = await pendingOffer(C.id);
    expect(offC).toBeTruthy();
    expect((await ctx.db.query(`SELECT slot_id, parent_round_id FROM offer_rounds WHERE id = $1`, [offC!.round_id])).rows[0])
      .toEqual({ slot_id: s[1]!.slot_id, parent_round_id: offB!.round_id });
    expect((await offerAction(t.C, offC!.id, 'accept')).statusCode).toBe(200);

    // Segunda cascada: s2 se ofrece a D, que rechaza → no quedan candidatos → ronda agotada y horario público
    const offD = await pendingOffer(D.id);
    expect((await offerAction(t.D, offD!.id, 'reject')).json().status).toBe('rejected');
    const round = (await ctx.db.query(`SELECT status FROM offer_rounds WHERE id = $1`, [offD!.round_id])).rows[0];
    expect(round.status).toBe('exhausted');
    expect((await ctx.db.query(`SELECT 1 FROM reservable_slots WHERE slot_id = $1`, [s[2]!.slot_id])).rowCount).toBe(1);
    expect((await ctx.db.query(`SELECT slot_id FROM appointments WHERE id = $1`, [D.id])).rows[0].slot_id).toBe(s[3]!.slot_id); // D conserva su cita

    // Estadísticas: 2 aceptadas, 1 rechazada, adelanto medido
    const adv = (await ctx.db.query(`SELECT count(*)::int n FROM appointment_events WHERE event_type = 'advanced'`)).rows[0].n;
    expect(adv).toBe(2);
  });

  it('aceptar dos veces con la misma clave devuelve lo mismo; otro paciente no puede aceptar la oferta', async () => {
    const { t, A, B } = await scenario();
    await cancel(t.A, A.id);
    const off = (await pendingOffer(B.id))!;
    expect((await offerAction(t.C, off.id, 'accept')).statusCode).toBe(404);
    const key = randomUUID();
    const r1 = await offerAction(t.B, off.id, 'accept', key);
    const r2 = await offerAction(t.B, off.id, 'accept', key);
    expect(r2.json()).toEqual(r1.json());
    expect(r2.headers['idempotent-replayed']).toBe('true');
  });

  it('vencimiento: el planificador vence la oferta, avisa y ofrece al siguiente; la cita original se conserva', async () => {
    const { t, A, B, C } = await scenario();
    await cancel(t.A, A.id);
    const off = (await pendingOffer(B.id))!;
    await ctx.db.query(`UPDATE advance_offers SET offered_at = now() - interval '2 hours', expires_at = now() - interval '1 second' WHERE id = $1`, [off.id]);
    const r = (await tick()).json();
    expect(r.expired_offers).toBe(1);
    expect((await ctx.db.query(`SELECT status FROM advance_offers WHERE id = $1`, [off.id])).rows[0].status).toBe('expired');
    expect(await pendingOffer(C.id)).toBeTruthy();
    expect((await ctx.db.query(`SELECT version FROM appointments WHERE id = $1`, [B.id])).rows[0].version).toBe(1);
    const kinds = (await ctx.app.inject({ url: `${P}/notifications`, headers: auth(t.B) })).json().items.map((n: { kind: string }) => n.kind);
    expect(kinds).toContain('offer_expired');
    expect((await tick()).json().expired_offers).toBe(0); // repetir no duplica
  });

  it('criterio: carrera entre aceptación y vencimiento sin inconsistencias (decide el plazo bajo bloqueo)', async () => {
    for (const expired of [true, false]) {
      await resetAgenda(ctx);
      const { t, A, B, C } = await scenario();
      await cancel(t.A, A.id);
      const off = (await pendingOffer(B.id))!;
      if (expired) await ctx.db.query(`UPDATE advance_offers SET offered_at = now() - interval '2 hours', expires_at = now() - interval '1 second' WHERE id = $1`, [off.id]);
      const [acc] = await Promise.all([offerAction(t.B, off.id, 'accept'), tick(), tick()]);
      const st = (await ctx.db.query(`SELECT status FROM advance_offers WHERE id = $1`, [off.id])).rows[0].status;
      const bv = (await ctx.db.query(`SELECT version FROM appointments WHERE id = $1`, [B.id])).rows[0].version;
      if (expired) {
        expect(acc.statusCode).toBe(410);
        expect(st).toBe('expired');
        expect(bv).toBe(1);
        expect(await pendingOffer(C.id)).toBeTruthy();
      } else {
        expect(acc.statusCode).toBe(200);
        expect(st).toBe('accepted');
        expect(bv).toBe(2);
      }
      // Nunca más de una oferta pendiente por ronda ni por cita
      const dup = (await ctx.db.query(`SELECT count(*)::int n FROM advance_offers WHERE status = 'pending' GROUP BY round_id HAVING count(*) > 1`)).rowCount;
      expect(dup).toBe(0);
    }
  });

  it('si la cita candidata cambia, su oferta se invalida y pasa al siguiente', async () => {
    const { t, A, B, C } = await scenario();
    await cancel(t.A, A.id);
    const off = (await pendingOffer(B.id))!;
    await cancel(t.B, B.id); // B cancela su propia cita
    expect((await ctx.db.query(`SELECT status FROM advance_offers WHERE id = $1`, [off.id])).rows[0].status).toBe('invalidated');
    expect(await pendingOffer(C.id)).toBeTruthy();
  });

  it('un horario sin la hora completa antes del inicio no se oferta y queda para reserva directa', async () => {
    const t1 = await login(ctx, 6);
    const t2 = await login(ctx, 7);
    // Slot que empieza en 40 minutos (creado para la prueba) y una cita posterior con ofertas activadas
    const s = (await ctx.db.query(
      `INSERT INTO slots (doctor_service_id, doctor_id, starts_at, ends_at)
       VALUES ($1, '30000000-0000-4000-8000-000000000006', date_trunc('minute', now()) + interval '40 minutes', date_trunc('minute', now()) + interval '60 minutes')
       ON CONFLICT DO NOTHING RETURNING id`, [SERVICE.ortega])).rows[0];
    if (!s) return; // solapa con un slot existente a esta hora: escenario no aplicable
    const near = await book(ctx, t1, s.id);
    const [later] = await freeSlots(ctx, SERVICE.ortega, 1, 10);
    await book(ctx, t2, later!.slot_id, { advance_opt_in: true });
    await cancel(t1, near.id);
    const round = (await ctx.db.query(`SELECT status, close_reason FROM offer_rounds WHERE slot_id = $1`, [s.id])).rows[0];
    expect(round).toEqual({ status: 'closed', close_reason: 'too_close_to_start' });
    expect((await ctx.db.query(`SELECT count(*)::int n FROM advance_offers`)).rows[0].n).toBe(0);
    expect((await ctx.db.query(`SELECT 1 FROM reservable_slots WHERE slot_id = $1`, [s.id])).rowCount).toBe(1);
  });

  it('una ausencia que bloquea un horario en oferta invalida la oferta y cierra la ronda', async () => {
    const { s, t, A, B } = await scenario();
    await cancel(t.A, A.id);
    const off = (await pendingOffer(B.id))!;
    const startAt = (await ctx.db.query(`SELECT starts_at, ends_at FROM slots WHERE id = $1`, [s[0]!.slot_id])).rows[0];
    await ctx.db.query(`INSERT INTO schedule_exceptions (doctor_id, starts_at, ends_at, reason) VALUES ('30000000-0000-4000-8000-000000000004', $1, $2, 'other')`,
      [startAt.starts_at, startAt.ends_at]);
    const { reconcileSchedule } = await import('../../src/modules/maintenance/schedule.js');
    const c = await ctx.pool.connect();
    try { await c.query('BEGIN'); await reconcileSchedule(c, { doctorId: '30000000-0000-4000-8000-000000000004' }, 'America/Santo_Domingo'); await c.query('COMMIT'); }
    finally { c.release(); }
    expect((await ctx.db.query(`SELECT status FROM advance_offers WHERE id = $1`, [off.id])).rows[0].status).toBe('invalidated');
    expect((await offerAction(t.B, off.id, 'accept')).statusCode).toBe(409);
    await ctx.db.query(`DELETE FROM schedule_exceptions WHERE reason = 'other' AND doctor_id = '30000000-0000-4000-8000-000000000004'`);
  });
});

describe('recordatorios en la bandeja', () => {
  it('publica solo recordatorios de citas vigentes con la versión esperada; nunca de versiones canceladas', async () => {
    const t = await login(ctx, 8);
    const [s1, s2] = await freeSlots(ctx, SERVICE.sosa, 2, 30);
    const keep = await book(ctx, t, s1!.slot_id);
    const drop = await book(ctx, await login(ctx, 9), s2!.slot_id);
    await cancel(await login(ctx, 9), drop.id);
    // Adelanta los recordatorios para que venzan ahora
    await ctx.db.query(`UPDATE outbox_jobs SET available_at = now() - interval '1 second' WHERE kind LIKE 'reminder.%' AND aggregate_id = ANY($1::uuid[])`, [[keep.id, drop.id]]);
    // n8n (simulado): reclama los comandos de recordatorio y los ejecuta en la API
    const SCHED = { authorization: `Bearer svc_${TEST_SERVICE_SECRET}` };
    const runReminders = async () => {
      const items = (await ctx.app.inject({ method: 'POST', url: `${P}/internal/commands/claim`, headers: SCHED, payload: { kinds: ['reminder.24h', 'reminder.1h'] } })).json().items;
      const out = [];
      for (const it of items) out.push((await ctx.app.inject({ method: 'POST', url: `${P}/internal/commands/${it.command_id}/reminder`, headers: SCHED,
        payload: { lease_token: it.lease_token } })).json());
      return out;
    };
    const r = await runReminders();
    expect(r.filter((x) => x.result.published).length).toBe(2); // 24 h y 1 h de la cita vigente
    const n = (await ctx.db.query(`SELECT appointment_id, kind FROM notifications WHERE kind LIKE 'reminder_%'`)).rows;
    expect(n.every((x) => x.appointment_id === keep.id)).toBe(true);
    expect(await runReminders()).toHaveLength(0);
  });
});

describe('calendario: cola durable, reintentos y convergencia', () => {
  it('sin vínculo habilitado: los trabajos se cierran como «no configurado» y no se simula sincronización', async () => {
    const t = await login(ctx, 10);
    const [s] = await freeSlots(ctx, SERVICE.mendez, 1, 40);
    const ap = await book(ctx, t, s!.slot_id);
    expect((await tick()).json().calendar_jobs_without_credentials).toBeGreaterThanOrEqual(1);
    const cs = (await ctx.db.query(`SELECT status, synced_version FROM calendar_sync WHERE appointment_id = $1`, [ap.id])).rows[0];
    expect(cs).toEqual({ status: 'disabled', synced_version: null });
  });

  it('con vínculo: create → update → cancel convergen; trabajo obsoleto reemplazado; fallos con backoff, dead y lease recuperable', async () => {
    await ctx.db.query(`INSERT INTO calendar_bindings (doctor_id, provider, external_calendar_id, enabled)
                        VALUES ('30000000-0000-4000-8000-000000000003', 'google', 'calendario-de-prueba@group.calendar.google.com', true)
                        ON CONFLICT (doctor_id) DO UPDATE SET enabled = true`);
    try {
      const t = await login(ctx, 11);
      const [s1, s2] = await freeSlots(ctx, SERVICE.sosa, 2, 50);
      const ap = await book(ctx, t, s1!.slot_id);
      const claim = async () => (await ctx.app.inject({ method: 'POST', url: `${P}/internal/jobs/claim`, headers: SVC, payload: { kinds: ['calendar.sync'] } })).json().items;

      // v1: crear. El evento no incluye nombre del paciente
      const [j1] = await claim();
      expect(j1.calendar).toMatchObject({ action: 'upsert', version: 1, event_id: expect.stringMatching(/^sc[0-9a-f]{32}$/) });
      const patientName = (await ctx.db.query(`SELECT p.full_name FROM appointments a JOIN patients p ON p.id = a.patient_id WHERE a.id = $1`, [ap.id])).rows[0].full_name;
      expect(JSON.stringify(j1)).not.toContain(patientName);
      expect(JSON.stringify(j1)).not.toContain(patientName.split(' ')[0]);
      // Reinicio de n8n sin ack: el lease vence y el trabajo se recupera
      await ctx.db.query(`UPDATE outbox_jobs SET lease_until = now() - interval '1 second' WHERE id = $1`, [j1.job_id]);
      const [j1b] = await claim();
      expect(j1b.job_id).toBe(j1.job_id);
      expect((await ctx.app.inject({ method: 'POST', url: `${P}/internal/jobs/${j1.job_id}/ack`, headers: SVC,
        payload: { lease_token: j1.lease_token, result: { version: 1 } } })).statusCode).toBe(409); // lease antiguo
      // Primer intento falla (timeout) → reintento con backoff
      const f = (await ctx.app.inject({ method: 'POST', url: `${P}/internal/jobs/${j1b.job_id}/fail`, headers: SVC,
        payload: { lease_token: j1b.lease_token, error: 'timeout de Google Calendar' } })).json();
      expect(f.status).toBe('pending');
      expect(f.retry_in_seconds).toBeGreaterThan(0);

      // Antes del reintento, la cita se reprograma (v2): el trabajo v1 queda reemplazado
      const p = (await prepare(ctx, t, { kind: 'reschedule', appointment_id: ap.id, expected_version: 1, new_slot_id: s2!.slot_id })).json();
      await confirm(ctx, t, p.intent_id, p.token);
      await ctx.db.query(`UPDATE outbox_jobs SET available_at = now() WHERE kind = 'calendar.sync'`);
      const [j2] = await claim();
      expect(j2.calendar).toMatchObject({ action: 'upsert', version: 2 });
      expect((await ctx.db.query(`SELECT result FROM outbox_jobs WHERE id = $1`, [j1.job_id])).rows[0].result).toEqual({ skipped: 'superseded' });
      await ctx.app.inject({ method: 'POST', url: `${P}/internal/jobs/${j2.job_id}/ack`, headers: SVC, payload: { lease_token: j2.lease_token, result: { version: 2 } } });
      expect((await ctx.db.query(`SELECT status, synced_version, desired_version FROM calendar_sync WHERE appointment_id = $1`, [ap.id])).rows[0])
        .toEqual({ status: 'synced', synced_version: 2, desired_version: 2 });

      // v3: cancelar → borrar; un ack tardío de una versión anterior no hace retroceder
      const x = (await prepare(ctx, t, { kind: 'cancellation', appointment_id: ap.id, expected_version: 2 })).json();
      await confirm(ctx, t, x.intent_id, x.token);
      const [j3] = await claim();
      expect(j3.calendar.action).toBe('delete');
      await ctx.app.inject({ method: 'POST', url: `${P}/internal/jobs/${j3.job_id}/ack`, headers: SVC, payload: { lease_token: j3.lease_token, result: { version: 3 } } });
      const cs = (await ctx.db.query(`SELECT status, synced_version FROM calendar_sync WHERE appointment_id = $1`, [ap.id])).rows[0];
      expect(cs).toEqual({ status: 'synced', synced_version: 3 });

      // Fallos repetidos → dead y calendar_sync failed (visible en el panel, reintento manual)
      const [s3] = await freeSlots(ctx, SERVICE.sosa, 1, 60);
      const ap2 = await book(ctx, t, s3!.slot_id);
      for (let i = 0; i < 5; i++) {
        await ctx.db.query(`UPDATE outbox_jobs SET available_at = now() WHERE aggregate_id = $1`, [ap2.id]);
        const [j] = await claim();
        await ctx.app.inject({ method: 'POST', url: `${P}/internal/jobs/${j.job_id}/fail`, headers: SVC, payload: { lease_token: j.lease_token, error: 'HTTP 500' } });
      }
      expect((await ctx.db.query(`SELECT status FROM outbox_jobs WHERE aggregate_id = $1 AND kind = 'calendar.sync'`, [ap2.id])).rows[0].status).toBe('dead');
      expect((await ctx.db.query(`SELECT status FROM calendar_sync WHERE appointment_id = $1`, [ap2.id])).rows[0].status).toBe('failed');
    } finally {
      await ctx.db.query(`UPDATE calendar_bindings SET enabled = false`);
    }
  });

  it('los endpoints internos exigen credencial de servicio', async () => {
    const t = await login(ctx, 12);
    expect((await ctx.app.inject({ method: 'POST', url: `${P}/internal/scheduler/tick`, headers: auth(t) })).statusCode).toBe(403);
    expect((await ctx.app.inject({ method: 'POST', url: `${P}/internal/jobs/claim`, payload: { kinds: ['calendar.sync'] } })).statusCode).toBe(401);
  });
});
