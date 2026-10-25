import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  P, SERVICE, auth, book, confirm, freeSlots, login, prepare, resetAgenda, setupApp, teardown, type Ctx,
} from '../helpers/app.js';

let ctx: Ctx;
beforeAll(async () => { ctx = await setupApp(); });
afterAll(async () => { await teardown(ctx); });
beforeEach(async () => { await resetAgenda(ctx); });

const activeOnSlot = async (slotId: string) =>
  (await ctx.db.query(`SELECT count(*)::int n FROM appointments WHERE slot_id = $1 AND status = 'booked'`, [slotId])).rows[0].n;

describe('reserva', () => {
  it('prepara sin modificar la agenda y confirma creando cita, evento, aviso, calendario y recordatorios', async () => {
    const t = await login(ctx, 1);
    const [s] = await freeSlots(ctx, SERVICE.mendez, 1, 40);
    const p = await prepare(ctx, t, { kind: 'booking', slot_id: s!.slot_id, advance_opt_in: true });
    expect(p.statusCode).toBe(201);
    expect(p.json().holds_slot).toBe(false);
    expect(p.json().summary.slot.slot_id).toBe(s!.slot_id);
    expect(await activeOnSlot(s!.slot_id)).toBe(0);

    const c = await confirm(ctx, t, p.json().intent_id, p.json().token);
    expect(c.statusCode).toBe(200);
    const appt = c.json().appointment;
    expect(c.json().outcome).toBe('booked');
    expect(appt.booking_reference).toMatch(/^SC-[A-Z2-9]{6}$/);
    expect(appt.advance_opt_in).toBe(true);

    const ev = await ctx.db.query(`SELECT event_type, to_slot_id FROM appointment_events WHERE appointment_id = $1`, [appt.id]);
    expect(ev.rows).toEqual([{ event_type: 'booked', to_slot_id: s!.slot_id }]);
    const notif = await ctx.db.query(`SELECT kind, status FROM notifications WHERE appointment_id = $1`, [appt.id]);
    expect(notif.rows).toEqual([{ kind: 'booking_confirmed', status: 'sent' }]);
    const sync = await ctx.db.query(`SELECT desired_version, status, external_event_id FROM calendar_sync WHERE appointment_id = $1`, [appt.id]);
    expect(sync.rows[0].desired_version).toBe(1);
    expect(sync.rows[0].external_event_id).toMatch(/^[0-9a-v]{5,1024}$/);
    const jobs = await ctx.db.query(`SELECT kind FROM outbox_jobs WHERE aggregate_id = $1 ORDER BY kind`, [appt.id]);
    expect(jobs.rows.map((r) => r.kind)).toEqual(['calendar.sync', 'receipt.render', 'reminder.1h', 'reminder.24h']);

    const mine = await ctx.app.inject({ url: `${P}/appointments`, headers: auth(t) });
    expect(mine.json().items.map((a: { id: string }) => a.id)).toContain(appt.id);
    // El slot ya no aparece como disponible
    const still = await ctx.db.query(`SELECT 1 FROM reservable_slots WHERE slot_id = $1`, [s!.slot_id]);
    expect(still.rowCount).toBe(0);
  });

  it('criterio: 20 solicitudes concurrentes del mismo horario generan exactamente una cita activa', async () => {
    const [s] = await freeSlots(ctx, SERVICE.sosa, 1, 10);
    const tokens = await Promise.all(Array.from({ length: 20 }, (_, i) => login(ctx, i + 1)));
    const intents = await Promise.all(tokens.map((t) => prepare(ctx, t, { kind: 'booking', slot_id: s!.slot_id })));
    expect(intents.every((r) => r.statusCode === 201)).toBe(true);

    const results = await Promise.all(intents.map((r, i) => confirm(ctx, tokens[i]!, r.json().intent_id, r.json().token)));
    const codes = results.map((r) => r.statusCode);
    expect(codes.filter((c) => c === 200)).toHaveLength(1);
    expect(codes.filter((c) => c === 409)).toHaveLength(19);
    expect(results.filter((r) => r.statusCode === 409).every((r) => r.json().error.code === 'slot_unavailable')).toBe(true);
    expect(await activeOnSlot(s!.slot_id)).toBe(1);
    const events = await ctx.db.query(`SELECT count(*)::int n FROM appointment_events WHERE to_slot_id = $1`, [s!.slot_id]);
    expect(events.rows[0].n).toBe(1);
  });

  it('la misma intención confirmada 20 veces en paralelo con claves distintas produce una sola cita', async () => {
    const t = await login(ctx, 2);
    const [s] = await freeSlots(ctx, SERVICE.jimenez, 1, 5);
    const p = (await prepare(ctx, t, { kind: 'booking', slot_id: s!.slot_id })).json();
    const results = await Promise.all(Array.from({ length: 20 }, () => confirm(ctx, t, p.intent_id, p.token)));
    expect(results.every((r) => r.statusCode === 200)).toBe(true);
    expect(new Set(results.map((r) => r.json().appointment.id)).size).toBe(1);
    expect(await activeOnSlot(s!.slot_id)).toBe(1);
  });

  it('PostgreSQL rechaza por sí mismo dos citas ocupantes en el mismo slot', async () => {
    const [s] = await freeSlots(ctx, SERVICE.ortega, 1);
    await ctx.db.query(`INSERT INTO appointments (booking_reference, patient_id, slot_id, source_channel)
                        VALUES ('SC-AAAAA2', '60000000-0000-4000-8000-000000000005', $1, 'seed')`, [s!.slot_id]);
    await expect(ctx.db.query(`INSERT INTO appointments (booking_reference, patient_id, slot_id, source_channel)
                        VALUES ('SC-AAAAA3', '60000000-0000-4000-8000-000000000006', $1, 'seed')`, [s!.slot_id]))
      .rejects.toMatchObject({ code: '23505', constraint: 'appointments_slot_occupied_uq' });
  });

  it('un paciente no puede tener dos citas activas solapadas (API y restricción)', async () => {
    const t = await login(ctx, 3);
    // Méndez y Sosa atienden ambas por la mañana: buscar dos slots solapados de médicos distintos
    const r = await ctx.db.query(
      `SELECT a.slot_id AS a, b.slot_id AS b FROM reservable_slots a JOIN reservable_slots b
         ON a.doctor_id <> b.doctor_id AND tstzrange(a.starts_at, a.ends_at) && tstzrange(b.starts_at, b.ends_at)
       WHERE a.doctor_service_id = $1 AND b.doctor_service_id = $2 ORDER BY a.starts_at LIMIT 1`, [SERVICE.mendez, SERVICE.sosa]);
    const { a, b } = r.rows[0];
    await book(ctx, t, a);
    const p = await prepare(ctx, t, { kind: 'booking', slot_id: b });
    expect(p.statusCode).toBe(409);
    expect(p.json().error.code).toBe('patient_overlap');
    await expect(ctx.db.query(`INSERT INTO appointments (booking_reference, patient_id, slot_id, source_channel)
                               VALUES ('SC-BBBBB2', '60000000-0000-4000-8000-000000000003', $1, 'seed')`, [b]))
      .rejects.toMatchObject({ code: '23P01', constraint: 'appointments_patient_no_overlap' });
  });
});

describe('idempotencia y confirmaciones', () => {
  it('criterio: un reintento con la misma clave devuelve el mismo resultado', async () => {
    const t = await login(ctx, 4);
    const [s] = await freeSlots(ctx, SERVICE.pena, 1, 3);
    const p = (await prepare(ctx, t, { kind: 'booking', slot_id: s!.slot_id })).json();
    const key = randomUUID();
    const r1 = await confirm(ctx, t, p.intent_id, p.token, key);
    const r2 = await confirm(ctx, t, p.intent_id, p.token, key);
    expect(r1.statusCode).toBe(200);
    expect(r2.statusCode).toBe(200);
    expect(r2.json()).toEqual(r1.json());
    expect(r1.headers['idempotent-replayed']).toBe('false');
    expect(r2.headers['idempotent-replayed']).toBe('true');
  });

  it('la misma clave con otro cuerpo devuelve 409 y no ejecuta nada', async () => {
    const t = await login(ctx, 4);
    const [s1, s2] = await freeSlots(ctx, SERVICE.pena, 2, 10);
    const p1 = (await prepare(ctx, t, { kind: 'booking', slot_id: s1!.slot_id })).json();
    const key = randomUUID();
    expect((await confirm(ctx, t, p1.intent_id, p1.token, key)).statusCode).toBe(200);
    const p2 = (await prepare(ctx, t, { kind: 'booking', slot_id: s2!.slot_id })).json();
    const r = await confirm(ctx, t, p2.intent_id, p2.token, key);
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe('idempotency_key_reused');
    expect(await activeOnSlot(s2!.slot_id)).toBe(0);
  });

  it('exige Idempotency-Key', async () => {
    const t = await login(ctx, 4);
    const r = await ctx.app.inject({ method: 'POST', url: `${P}/action-intents/${randomUUID()}/submit`, headers: auth(t), payload: { token: 'int_xxxxxxxxxxxx' } });
    expect(r.statusCode).toBe(400);
  });

  it('criterio: una confirmación vencida no modifica la agenda (410) y el reintento devuelve lo mismo', async () => {
    const t = await login(ctx, 5);
    const [s] = await freeSlots(ctx, SERVICE.taveras, 1, 4);
    const p = (await prepare(ctx, t, { kind: 'booking', slot_id: s!.slot_id })).json();
    await ctx.db.query(`UPDATE action_intents SET expires_at = now() - interval '1 second' WHERE id = $1`, [p.intent_id]);
    const key = randomUUID();
    const r1 = await confirm(ctx, t, p.intent_id, p.token, key);
    const r2 = await confirm(ctx, t, p.intent_id, p.token, key);
    expect(r1.statusCode).toBe(410);
    expect(r1.json().error.code).toBe('intent_expired');
    expect(r2.statusCode).toBe(410);
    expect(await activeOnSlot(s!.slot_id)).toBe(0);
  });

  it('criterio: un botón antiguo (intención reemplazada) no modifica la agenda', async () => {
    const t = await login(ctx, 6);
    const [s1, s2] = await freeSlots(ctx, SERVICE.jimenez, 2, 20);
    const old = (await prepare(ctx, t, { kind: 'booking', slot_id: s1!.slot_id })).json();
    await prepare(ctx, t, { kind: 'booking', slot_id: s2!.slot_id }); // elige otro horario
    const r = await confirm(ctx, t, old.intent_id, old.token);
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe('intent_invalidated');
    expect(await activeOnSlot(s1!.slot_id)).toBe(0);
  });

  it('criterio: una cancelación preparada sobre una versión antigua no modifica la cita', async () => {
    const t = await login(ctx, 7);
    const [s1, s2] = await freeSlots(ctx, SERVICE.ortega, 2, 6);
    const appt = await book(ctx, t, s1!.slot_id);
    // El paciente prepara una cancelación (v1) pero antes reprograma (→ v2) desde otra pestaña
    const cancel = (await prepare(ctx, t, { kind: 'cancellation', appointment_id: appt.id, expected_version: 1 })).json();
    const resch = (await prepare(ctx, t, { kind: 'reschedule', appointment_id: appt.id, expected_version: 1, new_slot_id: s2!.slot_id })).json();
    await ctx.db.query(`UPDATE action_intents SET status = 'pending' WHERE id = $1`, [cancel.intent_id]); // ambas vigentes
    expect((await confirm(ctx, t, resch.intent_id, resch.token)).json().appointment.version).toBe(2);
    const r = await confirm(ctx, t, cancel.intent_id, cancel.token);
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe('appointment_version_mismatch');
    const now = await ctx.app.inject({ url: `${P}/appointments/${appt.id}`, headers: auth(t) });
    expect(now.json().appointment.status).toBe('booked');
    expect(now.json().appointment.slot.slot_id).toBe(s2!.slot_id);
  });

  it('un token de confirmación incorrecto devuelve 403', async () => {
    const t = await login(ctx, 8);
    const [s] = await freeSlots(ctx, SERVICE.mendez, 1, 60);
    const p = (await prepare(ctx, t, { kind: 'booking', slot_id: s!.slot_id })).json();
    const r = await confirm(ctx, t, p.intent_id, 'int_token_inventado_por_alguien');
    expect(r.statusCode).toBe(403);
    expect(await activeOnSlot(s!.slot_id)).toBe(0);
  });
});

describe('cancelación y reprogramación', () => {
  it('cancelar libera el horario, registra evento y repetir no duplica efectos', async () => {
    const t = await login(ctx, 9);
    const [s] = await freeSlots(ctx, SERVICE.sosa, 1, 30);
    const appt = await book(ctx, t, s!.slot_id);
    const p = (await prepare(ctx, t, { kind: 'cancellation', appointment_id: appt.id, expected_version: 1 })).json();
    const r = await confirm(ctx, t, p.intent_id, p.token);
    expect(r.json().outcome).toBe('cancelled');
    expect(r.json().appointment.status).toBe('cancelled');
    expect(r.json().appointment.version).toBe(2);
    expect((await ctx.db.query(`SELECT 1 FROM reservable_slots WHERE slot_id = $1`, [s!.slot_id])).rowCount).toBe(1);
    // Los recordatorios de la cita cancelada quedan anulados
    const pending = await ctx.db.query(`SELECT count(*)::int n FROM outbox_jobs WHERE aggregate_id = $1 AND kind LIKE 'reminder.%' AND status = 'pending'`, [appt.id]);
    expect(pending.rows[0].n).toBe(0);

    // Una segunda cancelación (otra intención) informa el estado actual sin nuevos eventos
    await ctx.db.query(`INSERT INTO action_intents (patient_id, kind, payload, appointment_id, appointment_version, token_hash, expires_at)
      SELECT patient_id, 'cancellation', jsonb_build_object('kind','cancellation','appointment_id',id,'expected_version',2), id, 2,
             sha256('int_segunda_cancelacion'::bytea), now() + interval '5 minutes' FROM appointments WHERE id = $1`, [appt.id]);
    const second = (await ctx.db.query(`SELECT id FROM action_intents WHERE token_hash = sha256('int_segunda_cancelacion'::bytea)`)).rows[0];
    const r2 = await confirm(ctx, t, second.id, 'int_segunda_cancelacion');
    expect(r2.json().outcome).toBe('already_cancelled');
    const evs = await ctx.db.query(`SELECT count(*)::int n FROM appointment_events WHERE appointment_id = $1`, [appt.id]);
    expect(evs.rows[0].n).toBe(2);
  });

  it('reprogramar conserva el ID, mueve el slot y libera el anterior', async () => {
    const t = await login(ctx, 10);
    const [s1, s2] = await freeSlots(ctx, SERVICE.taveras, 2, 20);
    const appt = await book(ctx, t, s1!.slot_id);
    const p = (await prepare(ctx, t, { kind: 'reschedule', appointment_id: appt.id, expected_version: 1, new_slot_id: s2!.slot_id })).json();
    const r = await confirm(ctx, t, p.intent_id, p.token);
    expect(r.statusCode).toBe(200);
    expect(r.json().appointment.id).toBe(appt.id);
    expect(r.json().appointment.slot.slot_id).toBe(s2!.slot_id);
    expect(await activeOnSlot(s1!.slot_id)).toBe(0);
    const ev = await ctx.db.query(`SELECT from_slot_id, to_slot_id FROM appointment_events WHERE appointment_id = $1 AND event_type = 'rescheduled'`, [appt.id]);
    expect(ev.rows).toEqual([{ from_slot_id: s1!.slot_id, to_slot_id: s2!.slot_id }]);
  });

  it('criterio: una reprogramación fallida conserva la reserva original', async () => {
    const t = await login(ctx, 11);
    const other = await login(ctx, 12);
    const [s1, s2] = await freeSlots(ctx, SERVICE.pena, 2, 30);
    const appt = await book(ctx, t, s1!.slot_id);
    const p = (await prepare(ctx, t, { kind: 'reschedule', appointment_id: appt.id, expected_version: 1, new_slot_id: s2!.slot_id })).json();
    await book(ctx, other, s2!.slot_id); // otro paciente ocupa el destino antes de confirmar
    const r = await confirm(ctx, t, p.intent_id, p.token);
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe('slot_unavailable');
    const now = (await ctx.app.inject({ url: `${P}/appointments/${appt.id}`, headers: auth(t) })).json().appointment;
    expect(now.status).toBe('booked');
    expect(now.version).toBe(1);
    expect(now.slot.slot_id).toBe(s1!.slot_id);
  });
});

describe('aislamiento entre pacientes', () => {
  it('criterio: un paciente no consulta ni modifica citas ajenas', async () => {
    const owner = await login(ctx, 13);
    const intruder = await login(ctx, 14);
    const [s] = await freeSlots(ctx, SERVICE.jimenez, 1, 40);
    const appt = await book(ctx, owner, s!.slot_id);

    expect((await ctx.app.inject({ url: `${P}/appointments/${appt.id}`, headers: auth(intruder) })).statusCode).toBe(404);
    const list = (await ctx.app.inject({ url: `${P}/appointments?scope=all`, headers: auth(intruder) })).json().items;
    expect(list.map((a: { id: string }) => a.id)).not.toContain(appt.id);
    const p = await prepare(ctx, intruder, { kind: 'cancellation', appointment_id: appt.id, expected_version: 1 });
    expect(p.statusCode).toBe(404);

    // Intención del dueño confirmada con la sesión de otro paciente (aunque conozca id y token)
    const own = (await prepare(ctx, owner, { kind: 'cancellation', appointment_id: appt.id, expected_version: 1 })).json();
    const r = await confirm(ctx, intruder, own.intent_id, own.token);
    expect(r.statusCode).toBe(404);
    const still = (await ctx.app.inject({ url: `${P}/appointments/${appt.id}`, headers: auth(owner) })).json().appointment;
    expect(still.status).toBe('booked');
  });
});

describe('restricciones de agenda', () => {
  it('PostgreSQL impide slots abiertos solapados del mismo médico', async () => {
    const [s] = await freeSlots(ctx, SERVICE.mendez, 1, 90);
    await expect(ctx.db.query(
      `INSERT INTO slots (doctor_service_id, doctor_id, starts_at, ends_at)
       SELECT doctor_service_id, doctor_id, starts_at + interval '10 minutes', ends_at + interval '10 minutes' FROM slots WHERE id = $1`,
      [s!.slot_id])).rejects.toMatchObject({ code: '23P01', constraint: 'slots_no_overlap' });
  });

  it('el médico del slot debe corresponder al servicio (FK compuesta)', async () => {
    await expect(ctx.db.query(
      `INSERT INTO slots (doctor_service_id, doctor_id, starts_at, ends_at)
       VALUES ($1, '30000000-0000-4000-8000-000000000002', now() + interval '400 days', now() + interval '400 days 20 minutes')`,
      [SERVICE.mendez])).rejects.toMatchObject({ code: '23503' });
  });
});

describe('historial', () => {
  it('appointment_events y analytics_events son de solo inserción', async () => {
    const t = await login(ctx, 15);
    const [s] = await freeSlots(ctx, SERVICE.mendez, 1, 80);
    const appt = await book(ctx, t, s!.slot_id);
    await expect(ctx.db.query(`UPDATE appointment_events SET event_type = 'cancelled' WHERE appointment_id = $1`, [appt.id]))
      .rejects.toMatchObject({ code: '23001' });
    await expect(ctx.db.query(`DELETE FROM analytics_events WHERE appointment_id = $1`, [appt.id]))
      .rejects.toMatchObject({ code: '23001' });
  });
});

describe('paginación de citas', () => {
  it('recorre las citas propias por cursor sin repetir ni omitir', async () => {
    const t = await login(ctx, 16);
    const slots = await freeSlots(ctx, SERVICE.taveras, 5, 40);
    for (const s of slots) await book(ctx, t, s.slot_id);
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const r: { items: { id: string }[]; next_cursor: string | null } = (await ctx.app.inject({
        url: `${P}/appointments?limit=2${cursor ? `&cursor=${cursor}` : ''}`, headers: auth(t) })).json();
      seen.push(...r.items.map((a) => a.id));
      cursor = r.next_cursor;
    } while (cursor);
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
  });
});
