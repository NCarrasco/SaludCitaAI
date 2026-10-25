// Portada operativa del panel: hoy y próximas citas (fecha de ATENCIÓN), actividad reciente (fecha de OPERACIÓN),
// solicitudes de ayuda, disponibilidad y alertas accionables. Los datos personales (paciente, referencia) solo se
// incluyen para operator/admin; un viewer recibe cifras agregadas.
import type { Pool } from '../../db/pool.js';
import type { AdminRole } from '../../plugins/auth.js';
import { spanishLabel, toZonedIso } from '../../shared/time.js';

const OCCUPYING = `('booked','completed','no_show')`;

export interface DashFilter { date?: string; center_id?: string; specialty_id?: string; doctor_id?: string }

/**
 * Cada bloque declara a qué obedece (campo `scope` de la respuesta):
 * - fecha + filtros: indicadores del día, agenda del día, operaciones registradas ese día, horarios libres del día;
 * - solo filtros: próxima cita y próximas citas (desde ahora), actividad reciente, disponibilidad (7 días desde la fecha);
 * - todo el hospital: alertas y solicitudes de ayuda.
 */
export async function dashboard(pool: Pool, tz: string, role: AdminRole, f: DashFilter = {}) {
  const full = role !== 'viewer';
  const today = (await pool.query(`SELECT to_char((now() AT TIME ZONE $1)::date, 'YYYY-MM-DD') AS d`, [tz])).rows[0].d as string;
  const day = f.date ?? today;
  const B = `bounds AS (SELECT ($1::date)::timestamp AT TIME ZONE $2 AS t0, ($1::date + 1)::timestamp AT TIME ZONE $2 AS t1)`;
  // Servicios que cumplen los filtros ($3 centro, $4 especialidad, $5 médico)
  const SVC = `ds.id IN (SELECT id FROM doctor_services WHERE ($3::uuid IS NULL OR center_id = $3) AND ($4::uuid IS NULL OR specialty_id = $4)
                AND ($5::uuid IS NULL OR doctor_id = $5))`;
  const F = [f.center_id ?? null, f.specialty_id ?? null, f.doctor_id ?? null];

  const k = (await pool.query(`
    WITH ${B}
    SELECT
      count(*) FILTER (WHERE a.status IN ${OCCUPYING})::int AS total,
      count(*) FILTER (WHERE a.status = 'booked' AND a.starts_at > now())::int AS remaining,
      count(*) FILTER (WHERE a.status = 'completed')::int AS completed,
      count(*) FILTER (WHERE a.status = 'no_show')::int AS no_show,
      count(*) FILTER (WHERE a.status = 'booked' AND a.starts_at <= now())::int AS unmarked,
      count(*) FILTER (WHERE a.status = 'cancelled')::int AS cancelled
    FROM appointments a JOIN slots s ON s.id = a.slot_id JOIN doctor_services ds ON ds.id = s.doctor_service_id, bounds b
    WHERE a.starts_at >= b.t0 AND a.starts_at < b.t1 AND ${SVC}`, [day, tz, ...F])).rows[0];

  const slots = (await pool.query(`
    WITH ${B}
    SELECT count(*) FILTER (WHERE s.status = 'open')::int AS enabled,
           count(*) FILTER (WHERE s.status = 'open' AND EXISTS (SELECT 1 FROM appointments a WHERE a.slot_id = s.id AND a.status IN ${OCCUPYING}))::int AS occupied,
           count(*) FILTER (WHERE s.status = 'open' AND s.starts_at > now()
             AND NOT EXISTS (SELECT 1 FROM appointments a WHERE a.slot_id = s.id AND a.status IN ${OCCUPYING})
             AND NOT EXISTS (SELECT 1 FROM offer_rounds o WHERE o.slot_id = s.id AND o.status = 'open'))::int AS free_remaining
    FROM slots s JOIN doctor_services ds ON ds.id = s.doctor_service_id AND ds.active, bounds b
    WHERE s.starts_at >= b.t0 AND s.starts_at < b.t1 AND ${SVC}`, [day, tz, ...F])).rows[0];

  const ops = (await pool.query(`
    WITH ${B}
    SELECT count(*) FILTER (WHERE e.event_type = 'booked')::int AS booked, count(*) FILTER (WHERE e.event_type = 'cancelled')::int AS cancelled,
           count(*) FILTER (WHERE e.event_type = 'rescheduled')::int AS rescheduled, count(*) FILTER (WHERE e.event_type = 'advanced')::int AS advanced
    FROM appointment_events e JOIN appointments a ON a.id = e.appointment_id JOIN slots s ON s.id = a.slot_id
      JOIN doctor_services ds ON ds.id = s.doctor_service_id, bounds b
    WHERE e.occurred_at >= b.t0 AND e.occurred_at < b.t1 AND ${SVC}`, [day, tz, ...F])).rows[0];

  // Comparación con el MISMO día de la semana anterior (misma agenda semanal). Las operaciones registradas se comparan
  // hasta la misma hora si la fecha es hoy, para no enfrentar un día a medias con uno completo.
  const prev = (await pool.query(`
    WITH b AS (SELECT (($1::date - 7)::timestamp AT TIME ZONE $2) AS t0, (($1::date - 6)::timestamp AT TIME ZONE $2) AS t1,
                      CASE WHEN $6 THEN now() - interval '7 days' ELSE (($1::date - 6)::timestamp AT TIME ZONE $2) END AS cut)
    SELECT
      (SELECT count(*)::int FROM appointments a JOIN slots s ON s.id = a.slot_id JOIN doctor_services ds ON ds.id = s.doctor_service_id, b
        WHERE a.starts_at >= b.t0 AND a.starts_at < b.t1 AND a.status IN ${OCCUPYING} AND ${SVC}) AS agenda,
      (SELECT count(*)::int FROM appointment_events e JOIN appointments a ON a.id = e.appointment_id JOIN slots s ON s.id = a.slot_id
         JOIN doctor_services ds ON ds.id = s.doctor_service_id, b
        WHERE e.event_type = 'booked' AND e.occurred_at >= b.t0 AND e.occurred_at < least(b.t1, b.cut) AND ${SVC}) AS booked,
      (SELECT count(*)::int FROM appointment_events e JOIN appointments a ON a.id = e.appointment_id JOIN slots s ON s.id = a.slot_id
         JOIN doctor_services ds ON ds.id = s.doctor_service_id, b
        WHERE e.event_type = 'cancelled' AND e.occurred_at >= b.t0 AND e.occurred_at < least(b.t1, b.cut) AND ${SVC}) AS cancelled,
      to_char($1::date - 7, 'YYYY-MM-DD') AS date`, [day, tz, ...F, day === today])).rows[0];

  // Agenda de hoy (todas las citas con hora hoy, incluida la ya atendida) y próximas citas desde ahora
  const APPT = `SELECT a.id, a.booking_reference, a.status, a.starts_at, p.full_name, d.display_name AS doctor, sp.name AS specialty
                FROM appointments a JOIN slots s ON s.id = a.slot_id JOIN doctor_services ds ON ds.id = s.doctor_service_id
                JOIN doctors d ON d.id = ds.doctor_id JOIN specialties sp ON sp.id = ds.specialty_id JOIN patients p ON p.id = a.patient_id`;
  const todayRows = (await pool.query(`WITH ${B} ${APPT}, bounds b WHERE a.starts_at >= b.t0 AND a.starts_at < b.t1
                                       AND a.status IN ${OCCUPYING} AND ${SVC} ORDER BY a.starts_at, d.display_name`, [day, tz, ...F])).rows;
  // $1/$2 sin usar para conservar la numeración de los filtros
  const upcomingRows = (await pool.query(`${APPT} WHERE a.status = 'booked' AND a.starts_at > now() AND $1::text IS NOT NULL AND $2::text IS NOT NULL
                                          AND ${SVC} ORDER BY a.starts_at LIMIT 20`, [day, tz, ...F])).rows;
  const appt = (r: any) => ({
    starts_at: toZonedIso(r.starts_at, tz), label: spanishLabel(r.starts_at, tz), status: r.status, doctor: r.doctor, specialty: r.specialty,
    ...(full ? { id: r.id, reference: r.booking_reference, patient: r.full_name ?? null } : {}),
  });

  const upcomingByDay = (await pool.query(`
    SELECT to_char((a.starts_at AT TIME ZONE $1)::date, 'YYYY-MM-DD') AS date, count(*)::int AS n
    FROM appointments a JOIN slots s ON s.id = a.slot_id JOIN doctor_services ds ON ds.id = s.doctor_service_id
    WHERE a.status = 'booked' AND a.starts_at > now() AND a.starts_at < now() + interval '7 days' AND $2::text IS NOT NULL AND ${SVC}
    GROUP BY 1 ORDER BY 1`, [tz, day, ...F])).rows;

  const activity = (await pool.query(`
    SELECT e.event_type, e.occurred_at, e.from_starts_at, e.to_starts_at, a.id, a.booking_reference, p.full_name,
           d.display_name AS doctor, sp.name AS specialty
    FROM appointment_events e JOIN appointments a ON a.id = e.appointment_id JOIN patients p ON p.id = a.patient_id
    JOIN slots s ON s.id = a.slot_id JOIN doctor_services ds ON ds.id = s.doctor_service_id
    JOIN doctors d ON d.id = ds.doctor_id JOIN specialties sp ON sp.id = ds.specialty_id
    WHERE $1::text IS NOT NULL AND $2::text IS NOT NULL AND ${SVC}
    ORDER BY e.occurred_at DESC, e.id DESC LIMIT 30`, [day, tz, ...F])).rows.map((r) => ({
      kind: r.event_type, occurred_at: toZonedIso(r.occurred_at, tz), specialty: r.specialty, doctor: r.doctor,
      from_label: r.from_starts_at ? spanishLabel(r.from_starts_at, tz) : null, to_label: r.to_starts_at ? spanishLabel(r.to_starts_at, tz) : null,
      from_at: r.from_starts_at ? toZonedIso(r.from_starts_at, tz) : null, to_at: r.to_starts_at ? toZonedIso(r.to_starts_at, tz) : null,
      ...(full ? { id: r.id, reference: r.booking_reference, patient: r.full_name ?? null } : {}),
    }));

  const h = (await pool.query(`SELECT count(*)::int AS open, min(created_at) AS oldest FROM handoff_cases WHERE status = 'open'`)).rows[0];
  const handoffItems = full ? (await pool.query(`
    SELECT h.id, h.reference, h.reason, h.created_at, p.full_name FROM handoff_cases h JOIN patients p ON p.id = h.patient_id
    WHERE h.status = 'open' ORDER BY h.created_at LIMIT 5`)).rows.map((r) => ({
      id: r.id, reference: r.reference, reason: r.reason, created_at: toZonedIso(r.created_at, tz), patient: r.full_name ?? null })) : undefined;

  const availability = (await pool.query(`
    SELECT sp.name AS specialty,
           count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM appointments a WHERE a.slot_id = s.id AND a.status IN ${OCCUPYING})
                              AND NOT EXISTS (SELECT 1 FROM offer_rounds o WHERE o.slot_id = s.id AND o.status = 'open'))::int AS free,
           count(*) FILTER (WHERE EXISTS (SELECT 1 FROM appointments a WHERE a.slot_id = s.id AND a.status IN ${OCCUPYING}))::int AS occupied,
           count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM appointments a WHERE a.slot_id = s.id AND a.status IN ${OCCUPYING})
                              AND EXISTS (SELECT 1 FROM offer_rounds o WHERE o.slot_id = s.id AND o.status = 'open'))::int AS held,
           count(*)::int AS enabled
    FROM slots s JOIN doctor_services ds ON ds.id = s.doctor_service_id AND ds.active JOIN specialties sp ON sp.id = ds.specialty_id
    WHERE s.status = 'open' AND s.starts_at > greatest(now(), ($1::date)::timestamp AT TIME ZONE $2)
      AND s.starts_at < ($1::date + 7)::timestamp AT TIME ZONE $2 AND ${SVC}
    GROUP BY sp.name ORDER BY sp.name`, [day, tz, ...F])).rows;

  const a = (await pool.query(`
    SELECT
      (SELECT count(*)::int FROM appointments WHERE status = 'booked' AND starts_at <= now() AND starts_at > now() - interval '7 days') AS unmarked_7d,
      (SELECT count(*)::int FROM outbox_jobs WHERE status = 'dead') AS dead_jobs,
      (SELECT count(*)::int FROM outbox_jobs WHERE kind IN ('appointment.confirm','offer.answer') AND status IN ('pending','leased')
         AND created_at < now() - interval '60 seconds') AS stuck_orders,
      (SELECT count(*)::int FROM appointment_receipts r JOIN appointments ap ON ap.id = r.appointment_id
         WHERE r.status = 'failed' AND ap.status = 'booked') AS failed_receipts,
      (SELECT count(*)::int FROM advance_offers WHERE status = 'pending') AS pending_offers`)).rows[0];
  const from7 = (await pool.query(`SELECT to_char((now() AT TIME ZONE $1)::date - 7, 'YYYY-MM-DD') AS d`, [tz])).rows[0].d;
  const alerts = [
    a.unmarked_7d > 0 && { code: 'attendance_unmarked', severity: 'warn', count: a.unmarked_7d,
      text: `${a.unmarked_7d} cita(s) de los últimos 7 días ya empezaron y no tienen asistencia registrada`,
      action: { label: 'Registrar asistencia', page: 'citas', params: { status: 'booked', from: from7, to: day } } },
    h.open > 0 && { code: 'handoffs_open', severity: 'warn', count: h.open,
      text: `${h.open} solicitud(es) de ayuda sin resolver`, action: { label: 'Ver solicitudes', page: 'ayuda', params: {} } },
    a.stuck_orders > 0 && { code: 'orders_stuck', severity: 'bad', count: a.stuck_orders,
      text: `${a.stuck_orders} confirmación(es) en cola hace más de 1 minuto: n8n podría no estar procesando`,
      action: { label: 'Ver integraciones', page: 'sistema/integraciones', params: {} } },
    a.dead_jobs > 0 && { code: 'jobs_dead', severity: 'bad', count: a.dead_jobs,
      text: `${a.dead_jobs} trabajo(s) agotaron sus reintentos`, action: { label: 'Ver trabajos', page: 'sistema/trabajos', params: {} } },
    a.failed_receipts > 0 && { code: 'receipts_failed', severity: 'warn', count: a.failed_receipts,
      text: `${a.failed_receipts} comprobante(s) PDF no se generaron (la cita sigue confirmada)`, action: null },
  ].filter(Boolean);

  return {
    generated_at: toZonedIso(new Date(), tz), timezone: tz, today, date: day, is_today: day === today, scope: full ? 'full' : 'aggregate',
    filters: { date: day, center_id: f.center_id ?? null, specialty_id: f.specialty_id ?? null, doctor_id: f.doctor_id ?? null },
    kpis: { today_total: k.total, today_remaining: k.remaining, today_completed: k.completed, today_no_show: k.no_show,
            today_unmarked: k.unmarked, today_cancelled: k.cancelled, slots_enabled_today: slots.enabled, slots_free_remaining_today: slots.free_remaining,
            slots_occupied_today: slots.occupied, operations_today: ops, pending_offers: a.pending_offers },
    compare: { date: prev.date, same_time: day === today, agenda_total: prev.agenda, booked: prev.booked, cancelled: prev.cancelled },
    next: upcomingRows[0] ? appt(upcomingRows[0]) : null,
    agenda_today: full ? todayRows.map(appt) : undefined,
    agenda_today_by_hour: Object.values(todayRows.reduce((g: Record<string, { hour: string; total: number; completed: number; no_show: number; pending: number }>, r) => {
      const hh = toZonedIso(r.starts_at, tz).slice(11, 13);
      const x = (g[hh] ??= { hour: `${hh}:00`, total: 0, completed: 0, no_show: 0, pending: 0 });
      x.total++; if (r.status === 'completed') x.completed++; else if (r.status === 'no_show') x.no_show++; else x.pending++;
      return g;
    }, {})),
    upcoming: full ? upcomingRows.map(appt) : undefined,
    upcoming_by_day: upcomingByDay,
    activity,
    handoffs: { open: h.open, oldest_at: h.oldest ? toZonedIso(h.oldest, tz) : null, items: handoffItems },
    availability_7d: availability,
    alerts,
  };
}
