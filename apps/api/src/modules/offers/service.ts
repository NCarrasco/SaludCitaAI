// Ofertas secuenciales de adelanto con cascada.
//
// Reglas (especificación §5):
// - Un horario liberado abre una ronda; en cada ronda hay como máximo UNA oferta pendiente.
// - Candidatos: citas booked posteriores del MISMO servicio, con advance_opt_in, sin conflicto horario,
//   ordenadas por inicio actual, booked_at e id. Cada cita se intenta como mucho una vez por ronda.
// - La oferta solo se emite si queda la ventana completa antes del inicio del horario; si no, la ronda
//   se cierra y el horario vuelve a la reserva pública.
// - Aceptar mueve la cita (misma ID) al horario ofrecido y abre una ronda nueva para el horario anterior
//   (cascada). Rechazo, vencimiento o invalidación pasan al siguiente candidato.
// - El tiempo del servidor (clock_timestamp bajo bloqueo) decide la carrera entre aceptación y vencimiento.

import { randomUUID } from 'node:crypto';
import type { PoolClient } from '../../db/pool.js';
import { newToken, tokenHash } from '../../shared/crypto.js';
import { conflict, notFound } from '../../shared/errors.js';
import { period } from '../../shared/text.js';
import { spanishLabel } from '../../shared/time.js';
import { publishNotification, recordAnalytics, scheduleCalendarSync, scheduleReceipt, scheduleReminders } from '../appointments/effects.js';

export interface OfferConfig { windowSeconds: number; demoMode: boolean; tz: string }

/**
 * Resultado de aceptar/rechazar. Los fallos que cambian estado (vencida, invalidada) se devuelven en lugar de
 * lanzarse: así la transición (cerrar la oferta y ofrecer al siguiente) se confirma junto con la respuesta.
 */
export type OfferResult =
  | { ok: true; body: { offer_id: string; status: string; appointment_id?: string; cascade_round_id?: string | null } }
  | { ok: false; status: 409 | 410; code: string; message: string };
const failure = (status: 409 | 410, code: string, message: string): OfferResult => ({ ok: false, status, code, message });

const OCCUPYING = `('booked','completed','no_show')`;

type Trigger = 'cancelled' | 'rescheduled' | 'advanced';

/** Abre una ronda para un horario recién liberado (en la transacción que lo libera). */
export async function startRound(c: PoolClient, slotId: string, trigger: Trigger, cfg: OfferConfig, parentRoundId: string | null = null) {
  const s = (await c.query(
    `SELECT s.id, s.status, s.starts_at, (ds.active AND d.active) AS active,
            EXISTS (SELECT 1 FROM appointments a WHERE a.slot_id = s.id AND a.status IN ${OCCUPYING}) AS occupied,
            EXISTS (SELECT 1 FROM offer_rounds r WHERE r.slot_id = s.id AND r.status = 'open') AS has_round
     FROM slots s JOIN doctor_services ds ON ds.id = s.doctor_service_id JOIN doctors d ON d.id = s.doctor_id
     WHERE s.id = $1`, [slotId])).rows[0];
  if (!s || s.status !== 'open' || !s.active || s.occupied || s.has_round) return null;
  const round = (await c.query(
    `INSERT INTO offer_rounds (slot_id, parent_round_id, trigger_event, window_seconds, demo_mode)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`, [slotId, parentRoundId, trigger, cfg.windowSeconds, cfg.demoMode])).rows[0];
  // Sin ventana completa antes del inicio: no se oferta; el horario queda para reserva directa
  if ((s.starts_at as Date).getTime() - Date.now() < cfg.windowSeconds * 1000) {
    await closeRound(c, round.id, 'closed', 'too_close_to_start');
    return round.id as string;
  }
  await offerNext(c, round.id, cfg);
  return round.id as string;
}

async function closeRound(c: PoolClient, roundId: string, status: 'completed' | 'exhausted' | 'closed', reason: string) {
  await c.query(`UPDATE offer_rounds SET status = $2, close_reason = $3, closed_at = now() WHERE id = $1 AND status = 'open'`,
    [roundId, status, reason]);
}

/** Emite la oferta al siguiente candidato elegible o agota la ronda. */
export async function offerNext(c: PoolClient, roundId: string, cfg: OfferConfig) {
  const r = (await c.query(
    `SELECT r.id, r.slot_id, r.status, r.window_seconds, r.demo_mode, s.starts_at, s.ends_at, s.doctor_service_id
     FROM offer_rounds r JOIN slots s ON s.id = r.slot_id WHERE r.id = $1 FOR UPDATE OF r`, [roundId])).rows[0];
  if (!r || r.status !== 'open') return null;
  if ((await c.query(`SELECT 1 FROM advance_offers WHERE round_id = $1 AND status = 'pending'`, [roundId])).rowCount) return null;
  if ((r.starts_at as Date).getTime() - Date.now() < r.window_seconds * 1000) {
    await closeRound(c, roundId, 'closed', 'too_close_to_start');
    return null;
  }
  const cand = (await c.query(
    `SELECT a.id, a.patient_id, a.version, a.slot_id, a.starts_at
     FROM appointments a JOIN slots s ON s.id = a.slot_id JOIN patients p ON p.id = a.patient_id
     WHERE s.doctor_service_id = $2 AND a.status = 'booked' AND a.advance_opt_in AND p.active
       AND a.starts_at > $3 AND a.starts_at > now()
       AND NOT EXISTS (SELECT 1 FROM advance_offers o WHERE o.round_id = $1 AND o.appointment_id = a.id)
       AND NOT EXISTS (SELECT 1 FROM advance_offers o WHERE o.appointment_id = a.id AND o.status = 'pending')
       AND NOT EXISTS (SELECT 1 FROM appointments x WHERE x.patient_id = a.patient_id AND x.status = 'booked' AND x.id <> a.id
                       AND tstzrange(x.starts_at, x.ends_at) && tstzrange($3, $4))
     ORDER BY a.starts_at, a.booked_at, a.id LIMIT 1`, [roundId, r.doctor_service_id, r.starts_at, r.ends_at])).rows[0];
  if (!cand) {
    await closeRound(c, roundId, 'exhausted', 'no_candidates');
    return null;
  }
  const rank = Number((await c.query('SELECT count(*) FROM advance_offers WHERE round_id = $1', [roundId])).rows[0].count) + 1;
  const offer = (await c.query(
    `INSERT INTO advance_offers (round_id, appointment_id, original_slot_id, appointment_version, candidate_rank, token_hash, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, now() + make_interval(secs => $7)) RETURNING id, expires_at`,
    [roundId, cand.id, cand.slot_id, cand.version, rank, tokenHash(newToken('ofr')), r.window_seconds])).rows[0];
  const doctor = (await c.query('SELECT d.display_name FROM slots s JOIN doctors d ON d.id = s.doctor_id WHERE s.id = $1', [r.slot_id])).rows[0].display_name;
  const demo = r.demo_mode ? ` (modo demostración: ${Math.round(r.window_seconds / 60)} min para responder)` : '';
  await c.query(
    `INSERT INTO notifications (patient_id, appointment_id, offer_id, kind, title, body, dedupe_key, status, sent_at)
     VALUES ($1, $2, $3, 'advance_offer', $4, $5, $6, 'sent', now()) ON CONFLICT (dedupe_key) DO NOTHING`,
    [cand.patient_id, cand.id, offer.id, 'Horario disponible antes de tu cita',
     `Se liberó un horario con ${doctor} el ${period(spanishLabel(r.starts_at, cfg.tz))} Puedes aceptarlo hasta el ` +
     `${period(spanishLabel(offer.expires_at, cfg.tz))}${demo} Tu cita actual del ${spanishLabel(cand.starts_at, cfg.tz)} se conserva ` +
     'si no aceptas.', `offer:${offer.id}`]);
  await c.query(
    `INSERT INTO analytics_events (event_type, patient_id, doctor_service_id, appointment_id, dedupe_key, metadata)
     VALUES ('offer_sent', $1, $2, $3, $4, $5) ON CONFLICT (dedupe_key) DO NOTHING`,
    [cand.patient_id, r.doctor_service_id, cand.id, `offer:${offer.id}:sent`, JSON.stringify({ round_id: roundId, rank, demo_mode: r.demo_mode })]);
  return offer.id as string;
}

/** Cierra una oferta pendiente con el estado indicado y pasa al siguiente candidato. */
export async function closeOfferAndAdvance(c: PoolClient, offerId: string, status: 'rejected' | 'expired' | 'invalidated', reason: string, cfg: OfferConfig) {
  const o = (await c.query(
    `UPDATE advance_offers SET status = $2, responded_at = now(), close_reason = $3 WHERE id = $1 AND status = 'pending'
     RETURNING round_id, appointment_id`, [offerId, status, reason])).rows[0];
  if (!o) return;
  if (status === 'expired') {
    const p = (await c.query('SELECT patient_id FROM appointments WHERE id = $1', [o.appointment_id])).rows[0];
    await c.query(
      `INSERT INTO notifications (patient_id, appointment_id, offer_id, kind, title, body, dedupe_key, status, sent_at)
       VALUES ($1, $2, $3, 'offer_expired', 'Oferta vencida', 'La oferta para adelantar tu cita venció sin respuesta. Tu cita original se mantiene.',
               $4, 'sent', now()) ON CONFLICT (dedupe_key) DO NOTHING`, [p.patient_id, o.appointment_id, offerId, `offer:${offerId}:expired`]);
  }
  await offerNext(c, o.round_id, cfg);
}

/** Invalida ofertas pendientes de una cita que cambió o se canceló (misma transacción). */
export async function invalidateOffersForAppointment(c: PoolClient, appointmentId: string, cfg: OfferConfig) {
  const rows = (await c.query(`SELECT id FROM advance_offers WHERE appointment_id = $1 AND status = 'pending' FOR UPDATE`, [appointmentId])).rows;
  for (const r of rows) await closeOfferAndAdvance(c, r.id, 'invalidated', 'appointment_changed', cfg);
}

/** Materializa vencimientos. Devuelve cuántas ofertas vencieron. */
export async function expireDueOffers(c: PoolClient, cfg: OfferConfig, limit = 50): Promise<number> {
  const due = (await c.query(
    `SELECT o.id FROM advance_offers o WHERE o.status = 'pending' AND o.expires_at <= clock_timestamp()
       -- respondida a tiempo y en cola en n8n: la decide esa orden (o su plazo de 120 s), no el vencimiento
       AND NOT EXISTS (SELECT 1 FROM outbox_jobs j WHERE j.dedupe_key = 'offer:' || o.id || ':answer' AND j.status IN ('pending','leased'))
     ORDER BY o.expires_at LIMIT $1 FOR UPDATE OF o SKIP LOCKED`, [limit])).rows;
  for (const d of due) await closeOfferAndAdvance(c, d.id, 'expired', 'no_response', cfg);
  return due.length;
}

/** Respuesta ejecutada por n8n: plazo evaluado en el momento en que el paciente respondió y correlation_id de la orden. */
export interface AnswerOpts { at?: Date; correlationId?: string }

export async function rejectOffer(c: PoolClient, patientId: string, offerId: string, cfg: OfferConfig, opts: AnswerOpts = {}): Promise<OfferResult> {
  await c.query('SELECT id FROM patients WHERE id = $1 FOR UPDATE', [patientId]);
  const o = await lockOwnOffer(c, patientId, offerId, opts.at);
  if (o.status === 'expired') return failure(410, 'offer_expired', 'La oferta ya venció');
  if (o.status !== 'pending') return { ok: true, body: { offer_id: offerId, status: o.status } };
  if (o.expired) {
    await closeOfferAndAdvance(c, offerId, 'expired', 'no_response', cfg);
    return failure(410, 'offer_expired', 'La oferta ya venció');
  }
  await closeOfferAndAdvance(c, offerId, 'rejected', 'patient_rejected', cfg);
  return { ok: true, body: { offer_id: offerId, status: 'rejected' } };
}

/** `at`: momento en que el paciente respondió (orden ejecutada después por n8n); por defecto, ahora. */
export async function lockOwnOffer(c: PoolClient, patientId: string, offerId: string, at?: Date) {
  const o = (await c.query(
    `SELECT o.id, o.round_id, o.appointment_id, o.appointment_version, o.status,
            o.expires_at <= COALESCE($3::timestamptz, clock_timestamp()) AS expired
     FROM advance_offers o JOIN appointments a ON a.id = o.appointment_id
     WHERE o.id = $1 AND a.patient_id = $2 FOR UPDATE OF o`, [offerId, patientId, at ?? null])).rows[0];
  if (!o) throw notFound('Oferta');
  return o;
}

/** Acepta una oferta: mueve la cita al horario ofrecido y abre la cascada para el horario anterior. */
export async function acceptOffer(c: PoolClient, patientId: string, offerId: string, cfg: OfferConfig, opts: AnswerOpts = {}): Promise<OfferResult> {
  await c.query('SELECT id FROM patients WHERE id = $1 FOR UPDATE', [patientId]);
  const o = await lockOwnOffer(c, patientId, offerId, opts.at);
  if (o.status === 'accepted') return { ok: true, body: { offer_id: offerId, status: 'accepted', appointment_id: o.appointment_id } };
  if (o.status === 'expired') return failure(410, 'offer_expired', 'La oferta venció antes de aceptarla; tu cita original se mantiene');
  if (o.status !== 'pending') throw conflict('offer_not_pending', 'La oferta ya no está disponible', { status: o.status });
  if (o.expired) {
    // Carrera con el vencimiento: el plazo se comprueba bajo bloqueo con la hora del servidor
    await closeOfferAndAdvance(c, offerId, 'expired', 'no_response', cfg);
    return failure(410, 'offer_expired', 'La oferta venció antes de aceptarla; tu cita original se mantiene');
  }
  const round = (await c.query(`SELECT id, slot_id, status FROM offer_rounds WHERE id = $1 FOR UPDATE`, [o.round_id])).rows[0];
  const appt = (await c.query(`SELECT id, patient_id, slot_id, status, version, starts_at FROM appointments WHERE id = $1 FOR UPDATE`,
    [o.appointment_id])).rows[0];
  if (round.status !== 'open' || appt.status !== 'booked' || appt.version !== o.appointment_version) {
    await closeOfferAndAdvance(c, offerId, 'invalidated', 'state_changed', cfg);
    return failure(409, 'offer_invalidated', 'Tu cita o el horario cambiaron; la oferta ya no es válida');
  }
  for (const id of [appt.slot_id, round.slot_id].sort()) await c.query('SELECT id FROM slots WHERE id = $1 FOR UPDATE', [id]);
  const target = (await c.query(
    `SELECT s.id, s.status, s.starts_at, s.doctor_id, s.doctor_service_id,
            EXISTS (SELECT 1 FROM appointments a WHERE a.slot_id = s.id AND a.status IN ${OCCUPYING}) AS occupied
     FROM slots s WHERE s.id = $1`, [round.slot_id])).rows[0];
  const overlap = (await c.query(
    `SELECT 1 FROM appointments x, slots s WHERE s.id = $3 AND x.patient_id = $1 AND x.status = 'booked' AND x.id <> $2
       AND tstzrange(x.starts_at, x.ends_at) && tstzrange(s.starts_at, s.ends_at)`, [patientId, appt.id, round.slot_id])).rowCount;
  if (target.status !== 'open' || target.occupied || target.starts_at.getTime() <= Date.now() || overlap) {
    await closeOfferAndAdvance(c, offerId, 'invalidated', 'slot_unavailable', cfg);
    return failure(409, 'offer_invalidated', 'El horario ya no está disponible; tu cita original se mantiene');
  }

  const from = (await c.query('SELECT id, starts_at, doctor_service_id FROM slots WHERE id = $1', [appt.slot_id])).rows[0];
  const upd = (await c.query(`UPDATE appointments SET slot_id = $2, version = version + 1 WHERE id = $1
                              RETURNING id, patient_id, version, starts_at`, [appt.id, round.slot_id])).rows[0];
  const corr = opts.correlationId ?? randomUUID();
  await c.query(
    `INSERT INTO appointment_events (appointment_id, event_type, appointment_version, from_slot_id, to_slot_id, from_starts_at, to_starts_at,
                                     status_before, status_after, actor_type, actor_id, correlation_id)
     VALUES ($1, 'advanced', $2, $3, $4, $5, $6, 'booked', 'booked', 'patient', $7, $8)`,
    [appt.id, upd.version, from.id, target.id, from.starts_at, target.starts_at, patientId, corr]);
  await c.query(`UPDATE advance_offers SET status = 'accepted', responded_at = now(), close_reason = 'accepted' WHERE id = $1`, [offerId]);
  await closeRound(c, round.id, 'completed', 'accepted');
  await recordAnalytics(c, 'appointment_advanced', upd, target.doctor_service_id, corr,
    { offer_id: offerId, advance_minutes: (from.starts_at.getTime() - target.starts_at.getTime()) / 60_000 });
  await scheduleCalendarSync(c, appt.id, target.doctor_id, upd.version, corr);
  await scheduleReminders(c, appt.id, upd.version, target.starts_at, corr);
  await scheduleReceipt(c, appt.id, upd.version, corr);
  const ref = (await c.query('SELECT booking_reference FROM appointments WHERE id = $1', [appt.id])).rows[0].booking_reference;
  await publishNotification(c, patientId, appt.id, 'advance_accepted', `notif:${appt.id}:v${upd.version}:advanced`, 'Cita adelantada',
    period(`Tu cita ${ref} se adelantó al ${spanishLabel(target.starts_at, cfg.tz)}`));
  // Cascada: el horario anterior abre una ronda nueva
  const next = await startRound(c, from.id, 'advanced', cfg, round.id);
  return { ok: true, body: { offer_id: offerId, status: 'accepted', appointment_id: appt.id, cascade_round_id: next } };
}
