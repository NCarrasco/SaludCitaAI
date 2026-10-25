// Reconciliación de la agenda tras cambios administrativos (reglas, ausencias, servicios).
// Nunca cancela ni mueve citas: los slots libres que dejan de estar cubiertos se bloquean y las
// citas afectadas se devuelven como conflictos para gestión explícita del personal.

import type { PoolClient } from '../../db/pool.js';
import { spanishLabel } from '../../shared/time.js';

export interface ScheduleConflict {
  appointment_id: string; booking_reference: string; starts_at: string; label: string;
  doctor: string; patient_name: string | null; reason: 'outside_rules' | 'doctor_absence' | 'service_inactive';
}

export interface ScheduleImpact {
  blocked_free_slots: number;     // slots futuros libres que se bloquean
  reopened_slots: number;         // slots futuros bloqueados que vuelven a estar disponibles
  generated_slots: number;        // slots nuevos creados por las reglas vigentes (30 días)
  conflicts: ScheduleConflict[];  // citas reservadas que ya no encajan; NO se modifican
}

const OCCUPYING = `('booked','completed','no_show')`;

/** Reconciliación para los servicios del médico indicado (o de un servicio concreto). */
export async function reconcileSchedule(c: PoolClient, scope: { doctorId: string }, tz: string): Promise<ScheduleImpact> {
  // 1. Slots futuros abiertos que ya no encajan: fuera de reglas, en ausencia o servicio inactivo
  const affected = (await c.query(
    `SELECT s.id, s.starts_at,
            CASE WHEN NOT ds.active THEN 'service_inactive'
                 WHEN EXISTS (SELECT 1 FROM schedule_exceptions e WHERE e.doctor_id = s.doctor_id
                              AND tstzrange(e.starts_at, e.ends_at) && tstzrange(s.starts_at, s.ends_at)) THEN 'doctor_absence'
                 ELSE 'outside_rules' END AS reason,
            (SELECT a.id FROM appointments a WHERE a.slot_id = s.id AND a.status IN ${OCCUPYING}) AS appointment_id
     FROM slots s JOIN doctor_services ds ON ds.id = s.doctor_service_id
     WHERE s.doctor_id = $1 AND s.status = 'open' AND s.starts_at > now()
       AND (NOT ds.active OR NOT slot_covered_by_rules(s.id)
            OR EXISTS (SELECT 1 FROM schedule_exceptions e WHERE e.doctor_id = s.doctor_id
                       AND tstzrange(e.starts_at, e.ends_at) && tstzrange(s.starts_at, s.ends_at))
            -- duración distinta a la vigente del servicio: solo se reemplazan los slots libres
            OR ((s.ends_at - s.starts_at) <> ds.slot_minutes * interval '1 minute'
                AND NOT EXISTS (SELECT 1 FROM appointments a WHERE a.slot_id = s.id AND a.status IN ${OCCUPYING})))
     FOR UPDATE OF s`, [scope.doctorId])).rows;
  const free = affected.filter((r) => !r.appointment_id).map((r) => r.id);
  if (free.length) {
    // Un slot libre retenido por una ronda de ofertas abierta también se bloquea; la ronda se cierra
    await c.query(`UPDATE advance_offers SET status = 'invalidated', responded_at = now(), close_reason = 'slot_blocked'
                   WHERE status = 'pending' AND round_id IN (SELECT id FROM offer_rounds WHERE slot_id = ANY($1::uuid[]) AND status = 'open')`, [free]);
    await c.query(`UPDATE offer_rounds SET status = 'closed', close_reason = 'slot_blocked', closed_at = now()
                   WHERE slot_id = ANY($1::uuid[]) AND status = 'open'`, [free]);
    await c.query(`UPDATE slots SET status = 'blocked' WHERE id = ANY($1::uuid[])`, [free]);
  }
  const conflictIds = affected.filter((r) => r.appointment_id).map((r) => r.appointment_id);
  const reasons = new Map(affected.filter((r) => r.appointment_id).map((r) => [r.appointment_id, r.reason]));
  const conflicts: ScheduleConflict[] = conflictIds.length ? (await c.query(
    `SELECT a.id, a.booking_reference, a.starts_at, d.display_name AS doctor, p.full_name
     FROM appointments a JOIN slots s ON s.id = a.slot_id JOIN doctors d ON d.id = s.doctor_id JOIN patients p ON p.id = a.patient_id
     WHERE a.id = ANY($1::uuid[]) ORDER BY a.starts_at`, [conflictIds])).rows.map((r) => ({
    appointment_id: r.id, booking_reference: r.booking_reference, starts_at: (r.starts_at as Date).toISOString(),
    label: spanishLabel(r.starts_at, tz), doctor: r.doctor, patient_name: r.full_name, reason: reasons.get(r.id),
  })) : [];

  // 2. Slots futuros bloqueados que vuelven a estar cubiertos y sin ausencia (p. ej., al retirar una ausencia)
  const reopened = await c.query(
    `UPDATE slots s SET status = 'open'
     WHERE s.doctor_id = $1 AND s.status = 'blocked' AND s.starts_at > now()
       AND slot_covered_by_rules(s.id)
       AND NOT EXISTS (SELECT 1 FROM schedule_exceptions e WHERE e.doctor_id = s.doctor_id
                       AND tstzrange(e.starts_at, e.ends_at) && tstzrange(s.starts_at, s.ends_at))
       AND NOT EXISTS (SELECT 1 FROM slots o WHERE o.doctor_id = s.doctor_id AND o.status = 'open' AND o.id <> s.id
                       AND tstzrange(o.starts_at, o.ends_at) && tstzrange(s.starts_at, s.ends_at))
       AND (SELECT ds.slot_minutes FROM doctor_services ds WHERE ds.id = s.doctor_service_id) * interval '1 minute' = s.ends_at - s.starts_at`,
    [scope.doctorId]);

  // 3. Generación idempotente de los próximos 30 días con las reglas vigentes
  const gen = await c.query(`SELECT generate_slots((now() AT TIME ZONE $1)::date, 30) AS n`, [tz]);
  return { blocked_free_slots: free.length, reopened_slots: reopened.rowCount ?? 0, generated_slots: gen.rows[0].n, conflicts };
}

/** Citas futuras reservadas de un conjunto de servicios (impacto informativo de una desactivación). */
export async function futureBookedCount(c: PoolClient, where: string, params: unknown[]): Promise<number> {
  const r = await c.query(
    `SELECT count(*)::int n FROM appointments a JOIN slots s ON s.id = a.slot_id JOIN doctor_services ds ON ds.id = s.doctor_service_id
     WHERE a.status = 'booked' AND a.starts_at > now() AND ${where}`, params);
  return r.rows[0].n;
}
