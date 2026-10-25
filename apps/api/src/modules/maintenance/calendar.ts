// Vínculos de calendario por médico (espejo unidireccional hacia Google Calendar).
// Habilitar un vínculo reprograma la sincronización de las citas futuras del médico; deshabilitarlo
// hace que el planificador cierre los trabajos como «calendario no configurado».

import type { PoolClient } from '../../db/pool.js';
import { calendarEventId } from '../appointments/effects.js';

export const CALENDAR_ID_RE = /^[A-Za-z0-9._%+-]{1,200}@(group\.calendar\.google\.com|gmail\.com|[A-Za-z0-9.-]+\.[A-Za-z]{2,})$|^primary$/;

export async function setBinding(c: PoolClient, doctorId: string, externalCalendarId: string, enabled: boolean) {
  const doc = (await c.query('SELECT id FROM doctors WHERE id = $1', [doctorId])).rows[0];
  if (!doc) return null;
  const before = (await c.query('SELECT * FROM calendar_bindings WHERE doctor_id = $1 FOR UPDATE', [doctorId])).rows[0] ?? null;
  const b = (await c.query(
    `INSERT INTO calendar_bindings (doctor_id, provider, external_calendar_id, enabled) VALUES ($1, 'google', $2, $3)
     ON CONFLICT (doctor_id) DO UPDATE SET external_calendar_id = EXCLUDED.external_calendar_id, enabled = EXCLUDED.enabled
     RETURNING *`, [doctorId, externalCalendarId, enabled])).rows[0];
  let requeued = 0;
  if (enabled) {
    // Citas futuras reservadas del médico: vincular y encolar sincronización con su versión vigente
    const appts = (await c.query(
      `SELECT a.id, a.version FROM appointments a JOIN slots s ON s.id = a.slot_id
       WHERE s.doctor_id = $1 AND a.status = 'booked' AND a.starts_at > now()`, [doctorId])).rows;
    const stamp = Date.now();
    for (const a of appts) {
      await c.query(
        `INSERT INTO calendar_sync (appointment_id, binding_id, external_event_id, desired_version, status)
         VALUES ($1, $2, $3, $4, 'pending')
         ON CONFLICT (appointment_id) DO UPDATE SET binding_id = EXCLUDED.binding_id, desired_version = GREATEST(calendar_sync.desired_version, EXCLUDED.desired_version),
           status = 'pending', last_error = NULL`, [a.id, b.id, calendarEventId(a.id), a.version]);
      await c.query(
        `INSERT INTO outbox_jobs (kind, aggregate_id, dedupe_key, payload) VALUES ('calendar.sync', $1, $2, $3)
         ON CONFLICT (dedupe_key) DO NOTHING`, [a.id, `calendar:${a.id}:v${a.version}:bind:${stamp}`, JSON.stringify({ appointment_id: a.id, version: a.version })]);
      requeued++;
    }
  }
  return { before, binding: b, requeued_appointments: requeued };
}
