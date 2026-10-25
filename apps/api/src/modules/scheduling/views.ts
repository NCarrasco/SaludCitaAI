import type { Pool, PoolClient } from '../../db/pool.js';
import type { AppointmentViewT, SlotViewT } from '../../shared/schemas.js';
import { spanishLabel, toZonedIso } from '../../shared/time.js';

type Q = Pick<Pool | PoolClient, 'query'>;

// Columnas comunes para construir SlotView (alias s = slots)
export const SLOT_COLUMNS = `
  s.id AS slot_id, s.doctor_service_id, s.starts_at, s.ends_at,
  d.id AS doctor_id, d.display_name AS doctor_name,
  sp.id AS specialty_id, sp.name AS specialty_name,
  c.id AS center_id, c.name AS center_name, c.address AS center_address, c.timezone AS center_tz,
  ds.consultation_kind, ds.patient_instructions`;

export const SLOT_JOINS = `
  JOIN doctor_services ds ON ds.id = s.doctor_service_id
  JOIN doctors d ON d.id = s.doctor_id
  JOIN specialties sp ON sp.id = ds.specialty_id
  JOIN centers c ON c.id = ds.center_id`;

export function toSlotView(r: Record<string, any>, tz: string): SlotViewT {
  const zone = r.center_tz ?? tz;
  return {
    slot_id: r.slot_id,
    doctor_service_id: r.doctor_service_id,
    starts_at: toZonedIso(r.starts_at, zone),
    ends_at: toZonedIso(r.ends_at, zone),
    label: spanishLabel(r.starts_at, zone),
    timezone: zone,
    doctor: { id: r.doctor_id, display_name: r.doctor_name },
    specialty: { id: r.specialty_id, name: r.specialty_name },
    center: { id: r.center_id, name: r.center_name, address: r.center_address },
    consultation_kind: r.consultation_kind,
    patient_instructions: r.patient_instructions,
  };
}

export async function getSlotView(q: Q, slotId: string, tz: string): Promise<SlotViewT | undefined> {
  const r = await q.query(`SELECT ${SLOT_COLUMNS} FROM slots s ${SLOT_JOINS} WHERE s.id = $1`, [slotId]);
  return r.rows[0] ? toSlotView(r.rows[0], tz) : undefined;
}

export const APPOINTMENT_COLUMNS = `
  a.id, a.booking_reference, a.status, a.version, a.advance_opt_in, a.booked_at, a.cancelled_at,
  a.cancellation_reason_code, ${SLOT_COLUMNS}`;

export function toAppointmentView(r: Record<string, any>, tz: string): AppointmentViewT {
  const zone = r.center_tz ?? tz;
  return {
    id: r.id,
    booking_reference: r.booking_reference,
    status: r.status,
    version: r.version,
    advance_opt_in: r.advance_opt_in,
    booked_at: toZonedIso(r.booked_at, zone),
    cancelled_at: r.cancelled_at ? toZonedIso(r.cancelled_at, zone) : null,
    cancellation_reason_code: r.cancellation_reason_code,
    slot: toSlotView(r, tz),
  };
}

/** Cita del paciente indicado; undefined si no existe o pertenece a otro paciente. */
export async function getOwnAppointment(q: Q, patientId: string, appointmentId: string, tz: string) {
  const r = await q.query(
    `SELECT ${APPOINTMENT_COLUMNS} FROM appointments a JOIN slots s ON s.id = a.slot_id ${SLOT_JOINS}
     WHERE a.id = $1 AND a.patient_id = $2`, [appointmentId, patientId]);
  return r.rows[0] ? toAppointmentView(r.rows[0], tz) : undefined;
}
