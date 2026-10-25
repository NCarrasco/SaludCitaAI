// Efectos secundarios durables, escritos en la MISMA transacción que la cita.
// Ninguno llama a servicios externos: dejan trabajos en outbox_jobs o avisos en la bandeja.

import type { PoolClient } from '../../db/pool.js';

/** ID de evento determinista válido para Google Calendar (base32hex: 0-9a-v, 5–1024 caracteres). */
export function calendarEventId(appointmentId: string): string {
  return `sc${appointmentId.replace(/-/g, '')}`;
}

/** Comando durable. dedupe_key garantiza que una confirmación repetida no duplique comandos. */
export async function enqueue(c: PoolClient, kind: string, aggregateId: string | null, dedupeKey: string, payload: object,
                              availableAt?: Date, correlationId?: string | null) {
  await c.query(
    `INSERT INTO outbox_jobs (kind, aggregate_id, dedupe_key, payload, available_at, correlation_id)
     VALUES ($1, $2, $3, $4, COALESCE($5, now()), $6) ON CONFLICT (dedupe_key) DO NOTHING`,
    [kind, aggregateId, dedupeKey, JSON.stringify(payload), availableAt ?? null, correlationId ?? null]);
}

/**
 * Comprobante PDF de la versión vigente de la cita: se registra como pendiente y se encarga a n8n (comando durable).
 * Los comprobantes de versiones anteriores quedan «superseded»; si la cita se cancela, quedan «void».
 */
export async function scheduleReceipt(c: PoolClient, appointmentId: string, version: number, correlationId: string, cancelled = false) {
  await c.query(`UPDATE appointment_receipts SET status = $3 WHERE appointment_id = $1 AND appointment_version < $2 AND status <> 'void'`,
    [appointmentId, version, cancelled ? 'void' : 'superseded']);
  if (cancelled) return;
  await c.query(
    `INSERT INTO appointment_receipts (appointment_id, appointment_version, receipt_number, correlation_id)
     VALUES ($1, $2, (SELECT coalesce(max(receipt_number), 0) + 1 FROM appointment_receipts WHERE appointment_id = $1), $3)
     ON CONFLICT (appointment_id, appointment_version) DO NOTHING`, [appointmentId, version, correlationId]);
  await enqueue(c, 'receipt.render', appointmentId, `receipt:${appointmentId}:v${version}`, { appointment_id: appointmentId, version }, undefined, correlationId);
}

export async function scheduleCalendarSync(c: PoolClient, appointmentId: string, doctorId: string, version: number, correlationId?: string) {
  await c.query(
    `INSERT INTO calendar_sync (appointment_id, binding_id, external_event_id, desired_version, status)
     SELECT $1, b.id, $3, $4, CASE WHEN b.enabled THEN 'pending' ELSE 'disabled' END
     FROM (SELECT $2::uuid AS doctor_id) x LEFT JOIN calendar_bindings b ON b.doctor_id = x.doctor_id
     ON CONFLICT (appointment_id) DO UPDATE
       SET desired_version = EXCLUDED.desired_version,
           status = CASE WHEN calendar_sync.status = 'disabled' THEN 'disabled' ELSE 'pending' END`,
    [appointmentId, doctorId, calendarEventId(appointmentId), version]);
  await enqueue(c, 'calendar.sync', appointmentId, `calendar:${appointmentId}:v${version}`, { appointment_id: appointmentId, version }, undefined, correlationId);
}

/** Recordatorios a 24 h y 1 h; solo los que aún están en el futuro. Anula los de versiones anteriores. */
export async function scheduleReminders(c: PoolClient, appointmentId: string, version: number, startsAt: Date | null, correlationId?: string) {
  await c.query(
    `UPDATE outbox_jobs SET status = 'cancelled', last_error = 'versión de cita reemplazada'
     WHERE aggregate_id = $1 AND kind LIKE 'reminder.%' AND status IN ('pending','leased')`, [appointmentId]);
  if (!startsAt) return;
  for (const [label, ms] of [['24h', 24 * 3600_000], ['1h', 3600_000]] as const) {
    const at = new Date(startsAt.getTime() - ms);
    if (at.getTime() > Date.now()) {
      await enqueue(c, `reminder.${label}`, appointmentId, `reminder:${appointmentId}:v${version}:${label}`,
        { appointment_id: appointmentId, version }, at, correlationId);
    }
  }
}

export async function publishNotification(c: PoolClient, patientId: string, appointmentId: string, kind: string,
                                   dedupeKey: string, title: string, body: string) {
  // La bandeja web es el canal: publicar = sent (no implica lectura; ver read_at)
  await c.query(
    `INSERT INTO notifications (patient_id, appointment_id, kind, title, body, dedupe_key, status, sent_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'sent', now()) ON CONFLICT (dedupe_key) DO NOTHING`,
    [patientId, appointmentId, kind, title, body, dedupeKey]);
}

export async function recordAnalytics(c: PoolClient, type: string, a: { id: string; patient_id: string; version: number },
                               doctorServiceId: string, correlationId: string, metadata: object) {
  await c.query(
    `INSERT INTO analytics_events (event_type, patient_id, doctor_service_id, appointment_id, correlation_id, dedupe_key, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (dedupe_key) DO NOTHING`,
    [type, a.patient_id, doctorServiceId, a.id, correlationId, `appt:${a.id}:v${a.version}:${type}`, JSON.stringify(metadata)]);
}

