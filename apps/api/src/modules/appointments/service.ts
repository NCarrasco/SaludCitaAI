import type { Pool, PoolClient } from '../../db/pool.js';
import { bookingReference, newToken, tokenHash } from '../../shared/crypto.js';
import { ApiError, conflict, forbidden, gone, notFound } from '../../shared/errors.js';
import type { AppointmentViewT, SlotViewT } from '../../shared/schemas.js';
import { toZonedIso } from '../../shared/time.js';
import { period } from '../../shared/text.js';
import { getOwnAppointment, getSlotView } from '../scheduling/views.js';
import { type OfferConfig, invalidateOffersForAppointment, startRound } from '../offers/service.js';
import { publishNotification, recordAnalytics, scheduleCalendarSync, scheduleReceipt, scheduleReminders } from './effects.js';
export { calendarEventId } from './effects.js';

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------
export type CancellationReason = 'patient_request' | 'provider_unavailable' | 'scheduling_error' | 'other';

export type IntentInput =
  | { kind: 'booking'; slot_id: string; advance_opt_in?: boolean }
  | { kind: 'cancellation'; appointment_id: string; expected_version: number; reason_code?: CancellationReason }
  | { kind: 'reschedule'; appointment_id: string; expected_version: number; new_slot_id: string };

export interface Actor { patientId: string; channel: 'gradio' | 'api' }

export interface PreparedIntent {
  intent_id: string;
  kind: IntentInput['kind'];
  token: string;
  expires_at: string;
  holds_slot: false;
  summary: { slot?: SlotViewT; appointment?: AppointmentViewT; new_slot?: SlotViewT };
}

export interface ConfirmResult {
  intent_id: string;
  kind: IntentInput['kind'];
  outcome: 'booked' | 'cancelled' | 'already_cancelled' | 'rescheduled';
  appointment: AppointmentViewT;
}

const OCCUPYING = `('booked','completed','no_show')`;

// ---------------------------------------------------------------------------
// Validaciones comunes
// ---------------------------------------------------------------------------

/** Explica por qué un slot no es reservable ahora mismo. Devuelve null si lo es. */
async function slotUnavailableReason(c: Pick<PoolClient, 'query'>, slotId: string): Promise<string | null> {
  const r = await c.query(
    `SELECT s.status, s.starts_at,
            (ds.active AND d.active AND ce.active AND sp.active) AS service_active,
            s.starts_at < clock_timestamp() + make_interval(mins => ds.min_notice_minutes) AS too_soon,
            s.starts_at >= clock_timestamp() + make_interval(days => ds.booking_horizon_days) AS beyond_horizon,
            EXISTS (SELECT 1 FROM appointments a WHERE a.slot_id = s.id AND a.status IN ${OCCUPYING}) AS occupied,
            EXISTS (SELECT 1 FROM offer_rounds o WHERE o.slot_id = s.id AND o.status = 'open') AS held_by_offer
     FROM slots s
     JOIN doctor_services ds ON ds.id = s.doctor_service_id
     JOIN doctors d ON d.id = s.doctor_id
     JOIN centers ce ON ce.id = ds.center_id
     JOIN specialties sp ON sp.id = ds.specialty_id
     WHERE s.id = $1`, [slotId]);
  const s = r.rows[0];
  if (!s) return 'not_found';
  if (s.status !== 'open') return 'blocked';
  if (!s.service_active) return 'service_inactive';
  if (s.too_soon) return 'too_soon';
  if (s.beyond_horizon) return 'beyond_horizon';
  if (s.occupied) return 'occupied';
  if (s.held_by_offer) return 'held_by_offer';
  return null;
}

const SLOT_REASON_TEXT: Record<string, string> = {
  not_found: 'El horario no existe',
  blocked: 'El horario fue bloqueado por la agenda del médico',
  service_inactive: 'El servicio no está disponible',
  too_soon: 'El horario está demasiado próximo para reservarlo',
  beyond_horizon: 'El horario está fuera del periodo reservable',
  occupied: 'El horario ya está reservado',
  held_by_offer: 'El horario está ofrecido temporalmente a otro paciente',
};

async function assertSlotReservable(c: Pick<PoolClient, 'query'>, slotId: string) {
  const reason = await slotUnavailableReason(c, slotId);
  if (reason === 'not_found') throw notFound('Horario');
  if (reason) throw conflict('slot_unavailable', SLOT_REASON_TEXT[reason]!, { reason });
}

/** Rechaza si el paciente ya tiene otra cita activa que se solapa con el slot. */
async function assertNoPatientOverlap(c: Pick<PoolClient, 'query'>, patientId: string, slotId: string, excludeAppointmentId?: string) {
  const r = await c.query(
    `SELECT a.booking_reference FROM appointments a, slots s
     WHERE s.id = $2 AND a.patient_id = $1 AND a.status = 'booked'
       AND ($3::uuid IS NULL OR a.id <> $3)
       AND tstzrange(a.starts_at, a.ends_at, '[)') && tstzrange(s.starts_at, s.ends_at, '[)')`,
    [patientId, slotId, excludeAppointmentId ?? null]);
  if (r.rows[0]) {
    throw conflict('patient_overlap', 'Ya tienes otra cita activa en ese horario',
      { booking_reference: r.rows[0].booking_reference });
  }
}

interface ApptRow { id: string; patient_id: string; slot_id: string; status: string; version: number; starts_at: Date; advance_opt_in: boolean }

function assertModifiable(a: ApptRow, expectedVersion: number) {
  if (a.status !== 'booked') {
    throw conflict('appointment_not_active', 'La cita no está activa', { status: a.status });
  }
  if (a.version !== expectedVersion) {
    throw conflict('appointment_version_mismatch', 'La cita cambió desde que se preparó la operación',
      { current_version: a.version, expected_version: expectedVersion });
  }
  if (a.starts_at.getTime() <= Date.now()) {
    throw conflict('appointment_started', 'La cita ya comenzó; no se puede modificar por este canal');
  }
}

async function loadOwnAppointment(c: Pick<PoolClient, 'query'>, patientId: string, id: string, lock: boolean): Promise<ApptRow> {
  const r = await c.query(
    `SELECT id, patient_id, slot_id, status, version, starts_at, advance_opt_in FROM appointments
     WHERE id = $1 AND patient_id = $2 ${lock ? 'FOR UPDATE' : ''}`, [id, patientId]);
  if (!r.rows[0]) throw notFound('Cita'); // las citas ajenas son invisibles: 404, no 403
  return r.rows[0];
}

// ---------------------------------------------------------------------------
// Preparación de intenciones
// ---------------------------------------------------------------------------

export async function prepareIntent(pool: Pool, actor: Actor, input: IntentInput, opts: { ttlSeconds: number; tz: string; conversationId?: string })
  : Promise<PreparedIntent> {
  const { patientId } = actor;
  const summary: PreparedIntent['summary'] = {};
  let appointmentId: string | null = null;
  let appointmentVersion: number | null = null;
  let slotId: string | null = null;

  if (input.kind === 'booking') {
    const prof = (await pool.query('SELECT full_name, birth_date, phone, email FROM patients WHERE id = $1', [patientId])).rows[0];
    if (!prof?.full_name || !prof?.birth_date || !(prof?.phone || prof?.email)) {
      throw conflict('profile_required', 'Para reservar necesitamos tu nombre, fecha de nacimiento y un teléfono o correo de contacto (datos ficticios en esta demostración)',
        { missing: [...(prof?.full_name ? [] : ['full_name']), ...(prof?.birth_date ? [] : ['birth_date']), ...(prof?.phone || prof?.email ? [] : ['contact'])] });
    }
    await assertSlotReservable(pool, input.slot_id);
    await assertNoPatientOverlap(pool, patientId, input.slot_id);
    slotId = input.slot_id;
    summary.slot = await getSlotView(pool, input.slot_id, opts.tz);
  } else {
    const a = await loadOwnAppointment(pool, patientId, input.appointment_id, false);
    assertModifiable(a, input.expected_version);
    appointmentId = a.id;
    appointmentVersion = a.version;
    summary.appointment = await getOwnAppointment(pool, patientId, a.id, opts.tz);
    if (input.kind === 'reschedule') {
      if (input.new_slot_id === a.slot_id) throw conflict('same_slot', 'El nuevo horario es el mismo que el actual');
      await assertSlotReservable(pool, input.new_slot_id);
      await assertNoPatientOverlap(pool, patientId, input.new_slot_id, a.id);
      slotId = input.new_slot_id;
      summary.new_slot = await getSlotView(pool, input.new_slot_id, opts.tz);
    }
  }

  const token = newToken('int');
  const r = await pool.connect();
  try {
    await r.query('BEGIN');
    // Elegir otra operación invalida las intenciones pendientes anteriores del paciente
    // (las ya enviadas a n8n no se invalidan: están en curso)
    await r.query(`UPDATE action_intents SET status = 'invalidated' WHERE patient_id = $1 AND status = 'pending' AND submitted_at IS NULL`, [patientId]);
    const ins = await r.query(
      `INSERT INTO action_intents (patient_id, conversation_id, kind, payload, appointment_id, appointment_version, slot_id,
                                   token_hash, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now() + make_interval(secs => $9))
       RETURNING id, expires_at`,
      [patientId, opts.conversationId ?? null, input.kind, JSON.stringify(input), appointmentId, appointmentVersion, slotId,
       tokenHash(token), opts.ttlSeconds]);
    await r.query('COMMIT');
    return {
      intent_id: ins.rows[0].id, kind: input.kind, token,
      expires_at: toZonedIso(ins.rows[0].expires_at, opts.tz), holds_slot: false, summary,
    };
  } catch (e) {
    await r.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    r.release();
  }
}

async function slotInfo(c: PoolClient, slotId: string) {
  const r = await c.query('SELECT id, doctor_id, doctor_service_id, starts_at FROM slots WHERE id = $1', [slotId]);
  return r.rows[0] as { id: string; doctor_id: string; doctor_service_id: string; starts_at: Date };
}

// ---------------------------------------------------------------------------
// Confirmación (transaccional; el llamador gestiona idempotencia y transacción)
// ---------------------------------------------------------------------------

/** Orden durable que n8n está ejecutando (comando appointment.confirm con lease válido, ya bloqueado por el llamador). */
export interface ConfirmOrder { commandId: string; patientId: string; correlationId: string }

/**
 * Ejecuta una intención confirmada por el paciente. SOLO la llama el ejecutor interno del comando durable
 * appointment.confirm (n8n): no hay ruta del paciente que ejecute la operación directamente. El token se comprobó al
 * registrar la orden; aquí se comprueba el vínculo intención ↔ comando ↔ paciente y la caducidad en el momento del envío.
 * Orden de bloqueo estable: comando (llamador) → paciente → intención → cita → slots (por id).
 */
export async function confirmIntent(c: PoolClient, intentId: string, order: ConfirmOrder, tz: string, offers: OfferConfig): Promise<ConfirmResult> {
  const actor: Actor = { patientId: order.patientId, channel: 'api' };
  const p = await c.query('SELECT id FROM patients WHERE id = $1 AND active FOR UPDATE', [order.patientId]);
  if (!p.rows[0]) throw forbidden('Paciente inactivo');

  const intent = (await c.query(
    `SELECT id, patient_id, kind, payload, status, result, command_id, submitted_at,
            submitted_at IS NOT NULL AND submitted_at > expires_at AS expired
     FROM action_intents WHERE id = $1 FOR UPDATE`, [intentId])).rows[0];
  if (!intent || intent.patient_id !== order.patientId) throw notFound('Intención');
  if (!intent.submitted_at || intent.command_id !== order.commandId) {
    throw conflict('order_mismatch', 'Esta orden no corresponde a la intención indicada');
  }
  if (intent.status === 'consumed') return intent.result as ConfirmResult; // misma orden ejecutada de nuevo: mismo resultado
  if (intent.status === 'invalidated') throw conflict('intent_invalidated', 'Esta confirmación fue reemplazada por otra operación más reciente');
  if (intent.status === 'expired' || intent.expired) {
    throw gone('intent_expired', 'La confirmación caducó; vuelve a consultar disponibilidad');
  }

  const input = intent.payload as IntentInput;
  let result: ConfirmResult;
  switch (input.kind) {
    case 'booking': result = await doBooking(c, actor, intent.id, input, order.correlationId, tz); break;
    case 'cancellation': result = await doCancellation(c, actor, intent.id, input, order.correlationId, tz, offers); break;
    case 'reschedule': result = await doReschedule(c, actor, intent.id, input, order.correlationId, tz, offers); break;
  }

  await c.query(`UPDATE action_intents SET status = 'consumed', consumed_at = now(), result = $2 WHERE id = $1`,
    [intent.id, JSON.stringify(result)]);
  return result;
}

async function doBooking(c: PoolClient, actor: Actor, intentId: string, input: Extract<IntentInput, { kind: 'booking' }>,
                         correlationId: string, tz: string): Promise<ConfirmResult> {
  const lock = await c.query('SELECT id FROM slots WHERE id = $1 FOR UPDATE', [input.slot_id]);
  if (!lock.rows[0]) throw notFound('Horario');
  await assertSlotReservable(c, input.slot_id);
  await assertNoPatientOverlap(c, actor.patientId, input.slot_id);

  let appt: ApptRow | undefined;
  for (let i = 0; i < 5 && !appt; i++) {
    const ref = bookingReference();
    const r = await c.query(
      `INSERT INTO appointments (booking_reference, patient_id, slot_id, advance_opt_in, source_channel)
       SELECT $1, $2, $3, $4, $5 WHERE NOT EXISTS (SELECT 1 FROM appointments WHERE booking_reference = $1)
       RETURNING id, patient_id, slot_id, status, version, starts_at, advance_opt_in`,
      [ref, actor.patientId, input.slot_id, input.advance_opt_in ?? false, actor.channel]);
    appt = r.rows[0];
  }
  if (!appt) throw new Error('No se pudo generar una referencia de cita única');

  const slot = await slotInfo(c, input.slot_id);
  await c.query(
    `INSERT INTO appointment_events (appointment_id, event_type, appointment_version, to_slot_id, to_starts_at,
                                     status_after, actor_type, actor_id, correlation_id)
     VALUES ($1, 'booked', $2, $3, $4, 'booked', 'patient', $5, $6)`,
    [appt.id, appt.version, slot.id, slot.starts_at, actor.patientId, correlationId]);
  await recordAnalytics(c, 'appointment_booked', appt, slot.doctor_service_id, correlationId,
    { source_channel: actor.channel, intent_id: intentId, advance_opt_in: appt.advance_opt_in });
  await scheduleCalendarSync(c, appt.id, slot.doctor_id, appt.version, correlationId);
  await scheduleReminders(c, appt.id, appt.version, slot.starts_at, correlationId);
  await scheduleReceipt(c, appt.id, appt.version, correlationId);

  const view = (await getOwnAppointment(c, actor.patientId, appt.id, tz))!;
  await publishNotification(c, actor.patientId, appt.id, 'booking_confirmed', `notif:${appt.id}:v${appt.version}:booked`,
    'Cita confirmada', period(`Tu cita ${view.booking_reference} con ${view.slot.doctor.display_name} quedó confirmada para el ${view.slot.label}`));
  return { intent_id: intentId, kind: 'booking', outcome: 'booked', appointment: view };
}

async function doCancellation(c: PoolClient, actor: Actor, intentId: string, input: Extract<IntentInput, { kind: 'cancellation' }>,
                              correlationId: string, tz: string, offers: OfferConfig): Promise<ConfirmResult> {
  const a = await loadOwnAppointment(c, actor.patientId, input.appointment_id, true);
  if (a.status === 'cancelled') {
    // Repetir una cancelación devuelve el estado actual sin duplicar eventos ni avisos
    const view = (await getOwnAppointment(c, actor.patientId, a.id, tz))!;
    return { intent_id: intentId, kind: 'cancellation', outcome: 'already_cancelled', appointment: view };
  }
  assertModifiable(a, input.expected_version);
  await c.query('SELECT id FROM slots WHERE id = $1 FOR UPDATE', [a.slot_id]);

  const u = await c.query(
    `UPDATE appointments SET status = 'cancelled', version = version + 1, cancelled_at = now(),
            cancellation_reason_code = $2, cancelled_by_type = 'patient'
     WHERE id = $1 RETURNING id, patient_id, slot_id, status, version, starts_at, advance_opt_in`,
    [a.id, input.reason_code ?? 'patient_request']);
  const upd: ApptRow = u.rows[0];
  const slot = await slotInfo(c, a.slot_id);
  await c.query(
    `INSERT INTO appointment_events (appointment_id, event_type, appointment_version, from_slot_id, from_starts_at,
                                     status_before, status_after, reason_code, actor_type, actor_id, correlation_id)
     VALUES ($1, 'cancelled', $2, $3, $4, 'booked', 'cancelled', $5, 'patient', $6, $7)`,
    [a.id, upd.version, slot.id, slot.starts_at, input.reason_code ?? 'patient_request', actor.patientId, correlationId]);
  await recordAnalytics(c, 'appointment_cancelled', upd, slot.doctor_service_id, correlationId,
    { reason_code: input.reason_code ?? 'patient_request', hours_before_start: (slot.starts_at.getTime() - Date.now()) / 3600_000 });
  await scheduleCalendarSync(c, a.id, slot.doctor_id, upd.version, correlationId);
  await scheduleReminders(c, a.id, upd.version, null, correlationId);
  await scheduleReceipt(c, a.id, upd.version, correlationId, true);
  // Una oferta pendiente para ESTA cita deja de ser válida; el horario liberado abre una ronda de ofertas
  await invalidateOffersForAppointment(c, a.id, offers);
  await startRound(c, slot.id, 'cancelled', offers);

  const view = (await getOwnAppointment(c, actor.patientId, a.id, tz))!;
  await publishNotification(c, actor.patientId, a.id, 'appointment_cancelled', `notif:${a.id}:v${upd.version}:cancelled`,
    'Cita cancelada', period(`Tu cita ${view.booking_reference} del ${view.slot.label} fue cancelada`));
  return { intent_id: intentId, kind: 'cancellation', outcome: 'cancelled', appointment: view };
}

async function doReschedule(c: PoolClient, actor: Actor, intentId: string, input: Extract<IntentInput, { kind: 'reschedule' }>,
                            correlationId: string, tz: string, offers: OfferConfig): Promise<ConfirmResult> {
  const a = await loadOwnAppointment(c, actor.patientId, input.appointment_id, true);
  assertModifiable(a, input.expected_version);
  if (input.new_slot_id === a.slot_id) throw conflict('same_slot', 'El nuevo horario es el mismo que el actual');
  // Ambos slots en orden de id para evitar interbloqueos
  const ordered = [a.slot_id, input.new_slot_id].sort();
  for (const id of ordered) {
    const r = await c.query('SELECT id FROM slots WHERE id = $1 FOR UPDATE', [id]);
    if (!r.rows[0]) throw notFound('Horario');
  }
  await assertSlotReservable(c, input.new_slot_id);
  await assertNoPatientOverlap(c, actor.patientId, input.new_slot_id, a.id);

  const from = await slotInfo(c, a.slot_id);
  const to = await slotInfo(c, input.new_slot_id);
  // Misma cita (mismo ID), nuevo slot y nueva versión. Si algo falla, la transacción conserva la original.
  const u = await c.query(
    `UPDATE appointments SET slot_id = $2, version = version + 1 WHERE id = $1
     RETURNING id, patient_id, slot_id, status, version, starts_at, advance_opt_in`, [a.id, input.new_slot_id]);
  const upd: ApptRow = u.rows[0];
  await c.query(
    `INSERT INTO appointment_events (appointment_id, event_type, appointment_version, from_slot_id, to_slot_id,
                                     from_starts_at, to_starts_at, status_before, status_after, actor_type, actor_id, correlation_id)
     VALUES ($1, 'rescheduled', $2, $3, $4, $5, $6, 'booked', 'booked', 'patient', $7, $8)`,
    [a.id, upd.version, from.id, to.id, from.starts_at, to.starts_at, actor.patientId, correlationId]);
  await recordAnalytics(c, 'appointment_rescheduled', upd, to.doctor_service_id, correlationId,
    { from_doctor_service_id: from.doctor_service_id, shift_minutes: (to.starts_at.getTime() - from.starts_at.getTime()) / 60_000 });
  await scheduleCalendarSync(c, a.id, to.doctor_id, upd.version, correlationId);
  await scheduleReminders(c, a.id, upd.version, to.starts_at, correlationId);
  await scheduleReceipt(c, a.id, upd.version, correlationId);
  await invalidateOffersForAppointment(c, a.id, offers);
  await startRound(c, from.id, 'rescheduled', offers);

  const view = (await getOwnAppointment(c, actor.patientId, a.id, tz))!;
  await publishNotification(c, actor.patientId, a.id, 'appointment_rescheduled', `notif:${a.id}:v${upd.version}:rescheduled`,
    'Cita reprogramada', period(`Tu cita ${view.booking_reference} se movió al ${view.slot.label} con ${view.slot.doctor.display_name}`));
  return { intent_id: intentId, kind: 'reschedule', outcome: 'rescheduled', appointment: view };
}

export function isApiError(e: unknown): e is ApiError { return e instanceof ApiError; }
