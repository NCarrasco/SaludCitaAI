// Comandos durables orquestados por n8n (incremento C).
// n8n reclama comandos con lease, los enruta por tipo (ramas explícitas) y llama al endpoint de cada tipo.
// La API ejecuta el trabajo dentro de una transacción (identidad, permisos y reglas siguen en la API) y lo
// marca hecho en la MISMA transacción: si n8n cae a mitad, el lease vence y el comando se reclama de nuevo.
// Repetir la ejecución con el mismo lease devuelve el mismo resultado (idempotente).

import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { Pool, PoolClient } from '../../db/pool.js';
import { withTransaction } from '../../db/tx.js';
import { tokenHash } from '../../shared/crypto.js';
import { ApiError, conflict, forbidden, gone, notFound } from '../../shared/errors.js';
import { period } from '../../shared/text.js';
import { spanishLabel } from '../../shared/time.js';
import { enqueue } from '../appointments/effects.js';
import { confirmIntent } from '../appointments/service.js';
import { type OfferConfig, acceptOffer, closeOfferAndAdvance, lockOwnOffer, rejectOffer } from '../offers/service.js';
import { renderReceipt } from '../receipts/service.js';

export const COMMAND_KINDS = ['appointment.confirm', 'offer.answer', 'reminder.24h', 'reminder.1h', 'receipt.render', 'maintenance.guest_cleanup'] as const;
export type CommandKind = (typeof COMMAND_KINDS)[number];
const LEASE_SECONDS = 120;
/** Una orden de confirmación que n8n no ejecuta en este plazo se descarta sin cambios (el paciente lo ve y puede repetir). */
export const CONFIRM_DEADLINE_SECONDS = 120;

export interface GuestCleanupPolicy { abandonedAfterDays: number; sessionRetentionDays: number }

export async function claimCommands(pool: Pool, kinds: string[], limit: number) {
  return withTransaction(pool, async (c) => {
    const rows = (await c.query(
      `SELECT id, kind, aggregate_id, payload, attempts, correlation_id FROM outbox_jobs
       WHERE kind = ANY($1::text[]) AND available_at <= now()
         AND (status = 'pending' OR (status = 'leased' AND lease_until < now()))
       ORDER BY available_at LIMIT $2 FOR UPDATE SKIP LOCKED`, [kinds, limit])).rows;
    const out = [];
    for (const j of rows) {
      const lease = randomUUID();
      await c.query(`UPDATE outbox_jobs SET status = 'leased', lease_token = $2, lease_until = now() + make_interval(secs => $3),
                       attempts = attempts + 1, updated_at = now() WHERE id = $1`, [j.id, lease, LEASE_SECONDS]);
      out.push({ command_id: j.id as string, kind: j.kind as string, lease_token: lease, attempt: j.attempts + 1,
                 correlation_id: (j.correlation_id ?? null) as string | null, aggregate_id: (j.aggregate_id ?? null) as string | null, payload: j.payload });
    }
    return out;
  });
}

async function lockForExecution(c: PoolClient, id: string, lease: string, kinds: readonly string[]) {
  const j = (await c.query(`SELECT id, kind, aggregate_id, payload, status, lease_token, attempts, max_attempts, result, correlation_id
                            FROM outbox_jobs WHERE id = $1 FOR UPDATE`, [id])).rows[0];
  if (!j) throw notFound('Comando');
  if (!kinds.includes(j.kind)) throw conflict('wrong_command_kind', `Este endpoint no ejecuta comandos «${j.kind}»`);
  if (j.status === 'done' && j.lease_token === lease) return { j, done: true };       // reintento idempotente
  if (j.status !== 'leased' || j.lease_token !== lease) throw conflict('lease_lost', 'El lease del comando ya no es válido');
  return { j, done: false };
}

async function finish(c: PoolClient, id: string, result: object) {
  await c.query(`UPDATE outbox_jobs SET status = 'done', done_at = now(), result = $2, lease_until = NULL, updated_at = now() WHERE id = $1`,
    [id, JSON.stringify(result)]);
}

/** Recordatorio en la bandeja: solo si la cita sigue reservada, con la versión esperada y aún no empezó. */
export async function executeReminder(pool: Pool, id: string, lease: string, tz: string) {
  return withTransaction(pool, async (c) => {
    const { j, done } = await lockForExecution(c, id, lease, ['reminder.24h', 'reminder.1h']);
    if (done) return { command_id: id, status: 'done', correlation_id: j.correlation_id, result: j.result };
    const a = (await c.query(
      `SELECT a.id, a.patient_id, a.status, a.version, a.starts_at, a.booking_reference, d.display_name AS doctor
       FROM appointments a JOIN slots s ON s.id = a.slot_id JOIN doctors d ON d.id = s.doctor_id WHERE a.id = $1 FOR UPDATE OF a`, [j.aggregate_id])).rows[0];
    const valid = a && a.status === 'booked' && a.version === j.payload.version && a.starts_at.getTime() > Date.now();
    let result: object = { skipped: 'appointment_changed_or_started' };
    if (valid) {
      const label = j.kind === 'reminder.24h' ? '24h' : '1h';
      const ins = await c.query(
        `INSERT INTO notifications (patient_id, appointment_id, kind, title, body, dedupe_key, status, sent_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'sent', now()) ON CONFLICT (dedupe_key) DO NOTHING RETURNING id`,
        [a.patient_id, a.id, `reminder_${label}`, label === '24h' ? 'Recordatorio: tu cita es mañana' : 'Recordatorio: tu cita es en una hora',
         period(`Cita ${a.booking_reference} con ${a.doctor} el ${spanishLabel(a.starts_at, tz)}`) + ' Si no puedes asistir, cancélala desde el asistente.',
         `reminder:${a.id}:v${a.version}:${label}`]);
      result = { published: ins.rowCount === 1, notification_id: ins.rows[0]?.id ?? null };
    }
    await finish(c, id, result);
    if (!valid) await c.query(`UPDATE outbox_jobs SET status = 'cancelled' WHERE id = $1`, [id]);
    return { command_id: id, status: valid ? 'done' : 'cancelled', correlation_id: j.correlation_id, result };
  });
}

/** Comprobante PDF de la versión indicada (datos verificados en el momento de generar). */
export async function executeReceipt(pool: Pool, id: string, lease: string, tz: string) {
  return withTransaction(pool, async (c) => {
    const { j, done } = await lockForExecution(c, id, lease, ['receipt.render']);
    if (done) return { command_id: id, status: 'done', correlation_id: j.correlation_id, result: j.result };
    const r = await renderReceipt(c, j.aggregate_id, j.payload.version, tz);
    await finish(c, id, r);
    return { command_id: id, status: 'done', correlation_id: j.correlation_id, result: r };
  });
}

/**
 * Limpieza de sesiones invitadas. NUNCA borra citas, mensajes ni avisos y no impide recuperar el acceso:
 * - borra sesiones caducadas o revocadas hace más de N días (no sirven para entrar);
 * - marca como caducados los códigos de recuperación vencidos;
 * - elimina solo invitados abandonados y VACÍOS: sin citas, sin conversación, sin avisos, sin perfil,
 *   sin código de recuperación vigente y sin sesión vigente, creados hace más de N días.
 */
export async function executeGuestCleanup(pool: Pool, id: string, lease: string, policy: GuestCleanupPolicy) {
  return withTransaction(pool, async (c) => {
    const { j, done } = await lockForExecution(c, id, lease, ['maintenance.guest_cleanup']);
    if (done) return { command_id: id, status: 'done', correlation_id: j.correlation_id, result: j.result };
    const sessions = await c.query(
      `DELETE FROM patient_sessions WHERE (expires_at < now() - make_interval(days => $1)) OR (revoked_at < now() - make_interval(days => $1))`,
      [policy.sessionRetentionDays]);
    const codes = await c.query(
      `UPDATE patient_recovery_codes SET revoked_at = now(), revoke_reason = 'expired' WHERE revoked_at IS NULL AND expires_at < now()`);
    const empty = (await c.query(
      `SELECT p.id FROM patients p
       WHERE p.kind = 'guest' AND p.created_at < now() - make_interval(days => $1) AND p.full_name IS NULL AND p.birth_date IS NULL
         AND NOT EXISTS (SELECT 1 FROM appointments a WHERE a.patient_id = p.id)
         AND NOT EXISTS (SELECT 1 FROM channel_identities ci WHERE ci.patient_id = p.id)
         AND NOT EXISTS (SELECT 1 FROM notifications n WHERE n.patient_id = p.id)
         AND NOT EXISTS (SELECT 1 FROM action_intents i WHERE i.patient_id = p.id)
         AND NOT EXISTS (SELECT 1 FROM patient_recovery_codes r WHERE r.patient_id = p.id AND r.revoked_at IS NULL AND r.expires_at > now())
         AND NOT EXISTS (SELECT 1 FROM patient_sessions s WHERE s.patient_id = p.id AND s.revoked_at IS NULL AND s.expires_at > now())
       FOR UPDATE OF p SKIP LOCKED LIMIT 500`, [policy.abandonedAfterDays])).rows.map((r) => r.id);
    if (empty.length) {
      await c.query(`DELETE FROM patient_sessions WHERE patient_id = ANY($1::uuid[])`, [empty]);
      await c.query(`DELETE FROM patient_recovery_codes WHERE patient_id = ANY($1::uuid[])`, [empty]);
      await c.query(`DELETE FROM patients WHERE id = ANY($1::uuid[])`, [empty]);
    }
    const result = { sessions_deleted: sessions.rowCount ?? 0, codes_expired: codes.rowCount ?? 0, empty_guests_deleted: empty.length,
                     policy };
    await finish(c, id, result);
    return { command_id: id, status: 'done', correlation_id: j.correlation_id, result };
  });
}

/** Fallo informado por n8n: reintento con backoff exponencial y jitter; «dead» al agotar intentos. */
export async function failCommand(pool: Pool, id: string, lease: string, error: string) {
  return withTransaction(pool, async (c) => {
    const j = (await c.query(`SELECT id, kind, aggregate_id, payload, status, lease_token, attempts, max_attempts FROM outbox_jobs WHERE id = $1 FOR UPDATE`, [id])).rows[0];
    if (!j) throw notFound('Comando');
    if (j.status !== 'leased' || j.lease_token !== lease) throw conflict('lease_lost', 'El lease del comando ya no es válido');
    const dead = j.attempts >= j.max_attempts;
    const delay = Math.min(1800, 30 * 2 ** (j.attempts - 1)) * (0.8 + Math.random() * 0.4);
    await c.query(
      `UPDATE outbox_jobs SET status = $2, last_error = $3, lease_token = NULL, lease_until = NULL, updated_at = now(),
         available_at = CASE WHEN $2 = 'pending' THEN now() + make_interval(secs => $4) ELSE available_at END WHERE id = $1`,
      [id, dead ? 'dead' : 'pending', error.slice(0, 1000), delay]);
    // Comprobante: la cita sigue confirmada; el paciente ve «no se pudo generar» y puede reintentar
    if (j.kind === 'receipt.render') {
      await c.query(`UPDATE appointment_receipts SET status = $3, last_error = $4
                     WHERE appointment_id = $1 AND appointment_version = $2 AND status IN ('pending','failed')`,
        [j.aggregate_id, j.payload.version, dead ? 'failed' : 'pending', error.slice(0, 500)]);
    }
    return { command_id: id, status: dead ? 'dead' : 'pending', retry_in_seconds: dead ? null : Math.round(delay) };
  });
}

// ---------------------------------------------------------------------------
// Operaciones del paciente orquestadas por n8n: confirmar (appointment.confirm) y responder adelantos (offer.answer)
//
// Orden de bloqueo único para evitar interbloqueos:  comando (outbox_jobs) → paciente → intención/oferta → cita → slots.
// - El ejecutor bloquea el comando (lease) y después llama a la lógica de agenda, que sigue ese orden.
// - Las consultas de estado NO toman bloqueos de escritura; el vencimiento por plazo es un UPDATE atómico sobre el
//   comando (solo si sigue «pending») y, después, sobre la intención: comando → intención, el mismo orden.
// - El envío de la orden bloquea la intención/oferta e INSERTA el comando (no bloquea un comando existente).
// ---------------------------------------------------------------------------

const TIMEOUT_ERROR = { code: 'orchestration_timeout', status: 410,
  message: 'La operación no se procesó a tiempo y no se hizo ningún cambio. Vuelve a elegir el horario o la opción para intentarlo de nuevo.' };
const FAILED_ERROR = { code: 'orchestration_failed', status: 503,
  message: 'No se pudo procesar la operación y no se hizo ningún cambio. Vuelve a elegir el horario o la opción para intentarlo de nuevo.' };

/** Vence (atómicamente) un comando aún no reclamado cuyo plazo pasó. Devuelve el estado REAL tras el intento. */
async function expireIfDue(c: PoolClient | Pool, commandId: string): Promise<void> {
  await c.query(
    `UPDATE outbox_jobs SET status = 'cancelled', last_error = 'deadline', updated_at = now()
     WHERE id = $1 AND status = 'pending' AND (payload->>'deadline')::timestamptz < now()`, [commandId]);
}

/** Estado público de un comando a partir de su fila (re-leída después de cualquier intento de vencimiento). */
function orderState(j: { status: string; result: any }) {
  if (j.status === 'pending') return { status: 'queued' as const };
  if (j.status === 'leased') return { status: 'running' as const };
  if (j.status === 'done' && j.result?.ok) return { status: 'done' as const, result: j.result.result };
  if (j.status === 'done' && j.result?.error) {
    return { status: j.result.error.code === 'orchestration_timeout' ? 'expired' as const : 'failed' as const, error: j.result.error };
  }
  if (j.status === 'cancelled') return { status: 'expired' as const, error: TIMEOUT_ERROR };
  return { status: 'failed' as const, error: FAILED_ERROR };       // dead: todos los intentos fallaron (cada uno sin cambios)
}

/**
 * El paciente pulsa «Confirmar»: se comprueba token, dueño y vigencia y se ENCARGA el comando (no se toca la agenda).
 * Una intención solo tiene UNA orden: repetir el envío (misma u otra clave) devuelve esa orden, en el estado que tenga.
 * Una orden vencida, cancelada o fallida no se puede revivir: para reintentar hay que preparar una intención nueva.
 */
export async function submitConfirmation(c: PoolClient, patientId: string, intentId: string, token: string) {
  const i = (await c.query(
    `SELECT id, status, token_hash, submitted_at, command_id, correlation_id, expires_at <= clock_timestamp() AS expired
     FROM action_intents WHERE id = $1 AND patient_id = $2 FOR UPDATE`, [intentId, patientId])).rows[0];
  if (!i) throw notFound('Intención');
  const presented = tokenHash(token);
  if (presented.length !== i.token_hash.length || !timingSafeEqual(presented, i.token_hash)) {
    throw forbidden('El token de confirmación no corresponde a esta operación');
  }
  if (i.submitted_at) return { status: 'queued', intent_id: intentId, command_id: i.command_id as string, correlation_id: i.correlation_id as string };
  if (i.status === 'invalidated') throw conflict('intent_invalidated', 'Esta confirmación fue reemplazada por otra operación más reciente');
  if (i.status !== 'pending' || i.expired) throw gone('intent_expired', 'La confirmación caducó; vuelve a consultar disponibilidad');
  const correlationId = randomUUID();
  await enqueue(c, 'appointment.confirm', intentId, `confirm:${intentId}`,
    { intent_id: intentId, patient_id: patientId, deadline: new Date(Date.now() + CONFIRM_DEADLINE_SECONDS * 1000).toISOString() },
    undefined, correlationId);
  const cmd = (await c.query(`SELECT id FROM outbox_jobs WHERE dedupe_key = $1`, [`confirm:${intentId}`])).rows[0];
  await c.query(`UPDATE action_intents SET submitted_at = now(), command_id = $2, correlation_id = $3 WHERE id = $1`, [intentId, cmd.id, correlationId]);
  return { status: 'queued', intent_id: intentId, command_id: cmd.id as string, correlation_id: correlationId };
}

/** Estado de la orden para el paciente: queued · running · confirmed · failed · expired. Sin bloqueos de escritura. */
export async function confirmationStatus(pool: Pool, patientId: string, intentId: string) {
  const i = (await pool.query(`SELECT command_id, correlation_id, submitted_at FROM action_intents WHERE id = $1 AND patient_id = $2`,
    [intentId, patientId])).rows[0];
  if (!i) throw notFound('Intención');
  if (!i.submitted_at) throw conflict('not_submitted', 'Esta operación aún no se ha enviado a confirmar');
  await expireIfDue(pool, i.command_id);
  // El intento de vencimiento solo cambia el comando si seguía «pending»; se informa SIEMPRE el estado real re-leído
  const j = (await pool.query(`SELECT status, result, attempts FROM outbox_jobs WHERE id = $1`, [i.command_id])).rows[0];
  if (j.status === 'cancelled') {
    await pool.query(`UPDATE action_intents SET status = 'expired' WHERE id = $1 AND status = 'pending'`, [intentId]);
  }
  const st = orderState(j);
  return { intent_id: intentId, command_id: i.command_id as string, correlation_id: i.correlation_id as string, attempts: j.attempts as number,
           ...st, status: st.status === 'done' ? 'confirmed' : st.status };
}

/**
 * n8n ejecuta la orden. La API comprueba el vínculo comando ↔ intención ↔ paciente y revalida agenda y versión en su
 * transacción. Un rechazo de negocio (horario ocupado, versión cambiada, caducada, plazo vencido) es un RESULTADO
 * terminal sin cambios y la intención queda cerrada: no se reintenta ni se puede revivir.
 */
export async function executeConfirm(pool: Pool, id: string, lease: string, tz: string, offers: OfferConfig) {
  return withTransaction(pool, async (c) => {
    const { j, done } = await lockForExecution(c, id, lease, ['appointment.confirm']);
    if (done) return { command_id: id, status: 'done', correlation_id: j.correlation_id, result: j.result };
    if (j.aggregate_id !== j.payload.intent_id) throw conflict('order_mismatch', 'El comando no corresponde a la intención');
    let result: { ok?: true; result?: unknown; error?: { code: string; status: number; message: string } };
    if (!(Date.parse(j.payload.deadline) >= Date.now())) {
      result = { error: TIMEOUT_ERROR };
    } else {
      await c.query('SAVEPOINT confirm_exec');
      try {
        const r = await confirmIntent(c, j.payload.intent_id, { commandId: id, patientId: j.payload.patient_id, correlationId: j.correlation_id }, tz, offers);
        result = { ok: true, result: r };
      } catch (e) {
        if (!(e instanceof ApiError) || e.status >= 500) throw e;   // fallo técnico → n8n registra el fallo y se reintenta
        await c.query('ROLLBACK TO SAVEPOINT confirm_exec');
        result = { error: { code: e.code, status: e.status, message: e.message } };
      }
    }
    if (result.error) {
      await c.query(`UPDATE action_intents SET status = $2 WHERE id = $1 AND status = 'pending'`,
        [j.payload.intent_id, result.error.status === 410 ? 'expired' : 'invalidated']);
    }
    await finish(c, id, result);
    return { command_id: id, status: 'done', correlation_id: j.correlation_id, result };
  });
}

/** El paciente pulsa «Aceptar» o «Rechazar»: se comprueba dueño y vigencia y se encarga la orden (la cita no se mueve). */
export async function submitOfferAnswer(c: PoolClient, patientId: string, offerId: string, action: 'accept' | 'reject', offers: OfferConfig)
  : Promise<{ ok: true; body: object } | { ok: false; status: 409 | 410; code: string; message: string }> {
  await c.query('SELECT id FROM patients WHERE id = $1 FOR UPDATE', [patientId]);       // paciente → oferta (mismo orden)
  const o = await lockOwnOffer(c, patientId, offerId);
  const prev = (await c.query(`SELECT id, payload, correlation_id FROM outbox_jobs WHERE dedupe_key = $1`, [`offer:${offerId}:answer`])).rows[0];
  if (prev) {
    if (prev.payload.action !== action) return { ok: false, status: 409, code: 'offer_answer_in_progress', message: 'Ya respondiste a esta oferta' };
    return { ok: true, body: { status: 'queued', offer_id: offerId, action, command_id: prev.id as string, correlation_id: prev.correlation_id as string } };
  }
  if (o.status === 'expired') return { ok: false, status: 410, code: 'offer_expired', message: 'La oferta ya venció; tu cita original se mantiene' };
  if (o.status !== 'pending') return { ok: false, status: 409, code: 'offer_not_pending', message: 'La oferta ya no está disponible' };
  if (o.expired) {
    // Respondió tarde: se materializa el vencimiento AQUÍ (bajo el bloqueo de la oferta) y pasa al siguiente candidato
    await closeOfferAndAdvance(c, offerId, 'expired', 'no_response', offers);
    return { ok: false, status: 410, code: 'offer_expired', message: 'La oferta ya venció; tu cita original se mantiene' };
  }
  const correlationId = randomUUID();
  const now = Date.now();
  await enqueue(c, 'offer.answer', offerId, `offer:${offerId}:answer`, { offer_id: offerId, patient_id: patientId, action,
    requested_at: new Date(now).toISOString(), deadline: new Date(now + CONFIRM_DEADLINE_SECONDS * 1000).toISOString() }, undefined, correlationId);
  const cmd = (await c.query(`SELECT id FROM outbox_jobs WHERE dedupe_key = $1`, [`offer:${offerId}:answer`])).rows[0];
  return { ok: true, body: { status: 'queued', offer_id: offerId, action, command_id: cmd.id as string, correlation_id: correlationId } };
}

/** Estado de la respuesta a un adelanto. Sin bloqueos de escritura (la propiedad se comprueba con una lectura). */
export async function offerAnswerStatus(pool: Pool, patientId: string, offerId: string) {
  const own = (await pool.query(`SELECT 1 FROM advance_offers o JOIN appointments a ON a.id = o.appointment_id WHERE o.id = $1 AND a.patient_id = $2`,
    [offerId, patientId])).rowCount;
  if (!own) throw notFound('Oferta');
  const key = `offer:${offerId}:answer`;
  const first = (await pool.query(`SELECT id FROM outbox_jobs WHERE dedupe_key = $1`, [key])).rows[0];
  if (!first) throw conflict('not_submitted', 'Aún no respondiste a esta oferta');
  await expireIfDue(pool, first.id);
  const j = (await pool.query(`SELECT id, status, result, payload, attempts, correlation_id FROM outbox_jobs WHERE id = $1`, [first.id])).rows[0];
  return { offer_id: offerId, action: j.payload.action as string, command_id: j.id as string, correlation_id: j.correlation_id as string,
           attempts: j.attempts as number, ...orderState(j) };
}

export async function executeOfferAnswer(pool: Pool, id: string, lease: string, offers: OfferConfig) {
  return withTransaction(pool, async (c) => {
    const { j, done } = await lockForExecution(c, id, lease, ['offer.answer']);
    if (done) return { command_id: id, status: 'done', correlation_id: j.correlation_id, result: j.result };
    if (j.aggregate_id !== j.payload.offer_id || !['accept', 'reject'].includes(j.payload.action)) {
      throw conflict('order_mismatch', 'El comando no corresponde a la oferta');
    }
    let result: object;
    if (!(Date.parse(j.payload.deadline) >= Date.now())) {
      result = { error: TIMEOUT_ERROR };
    } else {
      await c.query('SAVEPOINT offer_exec');
      try {
        // acceptOffer/rejectOffer bloquean paciente → oferta y comprueban que la oferta es de ESE paciente
        const opts = { at: new Date(j.payload.requested_at), correlationId: j.correlation_id };
        const r = j.payload.action === 'accept'
          ? await acceptOffer(c, j.payload.patient_id, j.payload.offer_id, offers, opts)
          : await rejectOffer(c, j.payload.patient_id, j.payload.offer_id, offers, opts);
        result = r.ok ? { ok: true, result: r.body } : { error: { code: r.code, status: r.status, message: r.message } };
      } catch (e) {
        if (!(e instanceof ApiError) || e.status >= 500) throw e;
        await c.query('ROLLBACK TO SAVEPOINT offer_exec');
        result = { error: { code: e.code, status: e.status, message: e.message } };
      }
    }
    await finish(c, id, result);
    return { command_id: id, status: 'done', correlation_id: j.correlation_id, result };
  });
}
