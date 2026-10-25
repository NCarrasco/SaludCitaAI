// Consultas de estadísticas. Cada indicador tiene una definición única (docs/estadisticas.md) y se
// calcula exclusivamente desde tablas persistidas: appointment_events, appointments, slots,
// advance_offers, offer_rounds, analytics_events, messages, handoff_cases.
//
// Parámetros comunes de todas las consultas:
//   $1 from (fecha local AAAA-MM-DD, incluida)   $2 to (fecha local, excluida)   $3 zona horaria
//   $4 center_id   $5 doctor_id   $6 specialty_id   (nulos = sin filtro)

import type { Pool } from '../../db/pool.js';

export interface StatsFilters {
  from: string; to: string; tz: string;
  center_id?: string | null; doctor_id?: string | null; specialty_id?: string | null;
}

const P = (f: StatsFilters) => [f.from, f.to, f.tz, f.center_id ?? null, f.doctor_id ?? null, f.specialty_id ?? null];

// Intervalo [desde, hasta) en instantes y servicios que cumplen los filtros
const BASE = `
  bounds AS (SELECT ($1::date)::timestamp AT TIME ZONE $3 AS t0, ($2::date)::timestamp AT TIME ZONE $3 AS t1),
  svc AS (SELECT ds.id FROM doctor_services ds
          WHERE ($4::uuid IS NULL OR ds.center_id = $4) AND ($5::uuid IS NULL OR ds.doctor_id = $5)
            AND ($6::uuid IS NULL OR ds.specialty_id = $6))`;

// Slot de referencia de cada evento: destino para reservas/cambios; origen para cancelaciones;
// slot actual de la cita para asistencia.
const EVENTS = `
  ev AS (
    SELECT e.event_type, e.occurred_at, e.from_starts_at, e.to_starts_at, e.from_slot_id, e.to_slot_id, s.doctor_service_id
    FROM appointment_events e
    CROSS JOIN bounds b
    JOIN slots s ON s.id = COALESCE(CASE WHEN e.event_type = 'cancelled' THEN e.from_slot_id ELSE e.to_slot_id END,
                                    (SELECT a.slot_id FROM appointments a WHERE a.id = e.appointment_id))
    WHERE e.occurred_at >= b.t0 AND e.occurred_at < b.t1 AND s.doctor_service_id IN (SELECT id FROM svc))`;

const OCCUPYING = `('booked','completed','no_show')`;

export async function summary(pool: Pool, f: StatsFilters) {
  const searchFiltered = Boolean(f.center_id || f.doctor_id || f.specialty_id);
  const r = await pool.query(`
    WITH ${BASE}, ${EVENTS},
    searches AS (
      SELECT count(*)::int AS n FROM analytics_events a, bounds b
      WHERE a.event_type = 'availability_search' AND a.occurred_at >= b.t0 AND a.occurred_at < b.t1
        AND (NOT $7::boolean OR a.doctor_service_id IN (SELECT id FROM svc)
             OR ($6::uuid IS NOT NULL AND $4::uuid IS NULL AND $5::uuid IS NULL AND a.doctor_service_id IS NULL AND a.metadata->>'specialty_id' = $6::text))),
    agenda AS (
      SELECT a.status, count(*)::int AS n FROM appointments a JOIN slots s ON s.id = a.slot_id, bounds b
      WHERE a.starts_at >= b.t0 AND a.starts_at < b.t1 AND s.doctor_service_id IN (SELECT id FROM svc) GROUP BY a.status),
    occ AS (
      SELECT count(*) FILTER (WHERE s.status = 'open')::int AS enabled,
             count(*) FILTER (WHERE s.status = 'open' AND EXISTS (SELECT 1 FROM appointments a WHERE a.slot_id = s.id AND a.status IN ${OCCUPYING}))::int AS occupied,
             count(*) FILTER (WHERE s.status = 'open' AND EXISTS (SELECT 1 FROM offer_rounds o WHERE o.slot_id = s.id AND o.status = 'open')
                              AND NOT EXISTS (SELECT 1 FROM appointments a WHERE a.slot_id = s.id AND a.status IN ${OCCUPYING}))::int AS held_by_offer,
             count(*) FILTER (WHERE s.status = 'blocked')::int AS blocked
      FROM slots s, bounds b WHERE s.starts_at >= b.t0 AND s.starts_at < b.t1 AND s.doctor_service_id IN (SELECT id FROM svc)),
    att AS (
      SELECT count(*) FILTER (WHERE a.status = 'completed')::int AS completed,
             count(*) FILTER (WHERE a.status = 'no_show')::int AS no_show,
             count(*) FILTER (WHERE a.status = 'booked')::int AS unmarked
      FROM appointments a JOIN slots s ON s.id = a.slot_id, bounds b
      WHERE a.starts_at >= b.t0 AND a.starts_at < b.t1 AND a.starts_at <= now() AND s.doctor_service_id IN (SELECT id FROM svc))
    SELECT
      (SELECT n FROM searches) AS searches,
      (SELECT count(*) FILTER (WHERE event_type = 'booked') FROM ev)::int AS bookings,
      (SELECT count(*) FILTER (WHERE event_type = 'cancelled') FROM ev)::int AS cancellations,
      (SELECT count(*) FILTER (WHERE event_type = 'rescheduled') FROM ev)::int AS reschedules,
      (SELECT count(*) FILTER (WHERE event_type = 'advanced') FROM ev)::int AS advances,
      (SELECT coalesce(jsonb_object_agg(status, n), '{}') FROM agenda) AS agenda,
      (SELECT row_to_json(occ) FROM occ) AS occupancy,
      (SELECT row_to_json(att) FROM att) AS attendance`, [...P(f), searchFiltered]);
  const x = r.rows[0];
  const occ = x.occupancy;
  const att = x.attendance;
  return {
    searches: x.searches,
    operations: { bookings: x.bookings, cancellations: x.cancellations, reschedules: x.reschedules, advances: x.advances },
    agenda_by_status: { booked: 0, cancelled: 0, completed: 0, no_show: 0, ...x.agenda },
    occupancy: { occupied: occ.occupied, enabled: occ.enabled, rate: ratio(occ.occupied, occ.enabled),
                 held_by_offer: occ.held_by_offer, blocked: occ.blocked },
    attendance: { completed: att.completed, no_show: att.no_show, unmarked: att.unmarked,
                  rate: ratio(att.completed, att.completed + att.no_show) },
  };
}

export async function timeseries(pool: Pool, f: StatsFilters) {
  const r = await pool.query(`
    WITH ${BASE}, ${EVENTS},
    days AS (SELECT d::date AS day FROM generate_series($1::date, $2::date - 1, interval '1 day') d),
    ev_day AS (SELECT (occurred_at AT TIME ZONE $3)::date AS day, event_type, count(*)::int AS n FROM ev GROUP BY 1, 2),
    srch AS (SELECT (a.occurred_at AT TIME ZONE $3)::date AS day, count(*)::int AS n FROM analytics_events a, bounds b
             WHERE a.event_type = 'availability_search' AND a.occurred_at >= b.t0 AND a.occurred_at < b.t1
               AND (NOT $7::boolean OR a.doctor_service_id IN (SELECT id FROM svc)
                    OR ($6::uuid IS NOT NULL AND $4::uuid IS NULL AND $5::uuid IS NULL AND a.doctor_service_id IS NULL AND a.metadata->>'specialty_id' = $6::text))
             GROUP BY 1),
    sl AS (SELECT (s.starts_at AT TIME ZONE $3)::date AS day,
                  count(*) FILTER (WHERE s.status = 'open')::int AS enabled,
                  count(*) FILTER (WHERE s.status = 'open' AND EXISTS (SELECT 1 FROM appointments a WHERE a.slot_id = s.id AND a.status IN ${OCCUPYING}))::int AS occupied
           FROM slots s, bounds b WHERE s.starts_at >= b.t0 AND s.starts_at < b.t1 AND s.doctor_service_id IN (SELECT id FROM svc) GROUP BY 1)
    SELECT to_char(d.day, 'YYYY-MM-DD') AS date,
           coalesce((SELECT n FROM srch WHERE srch.day = d.day), 0) AS searches,
           coalesce((SELECT n FROM ev_day WHERE ev_day.day = d.day AND event_type = 'booked'), 0) AS bookings,
           coalesce((SELECT n FROM ev_day WHERE ev_day.day = d.day AND event_type = 'cancelled'), 0) AS cancellations,
           coalesce((SELECT n FROM ev_day WHERE ev_day.day = d.day AND event_type = 'rescheduled'), 0) AS reschedules,
           coalesce((SELECT n FROM ev_day WHERE ev_day.day = d.day AND event_type = 'advanced'), 0) AS advances,
           coalesce(sl.enabled, 0) AS slots_enabled, coalesce(sl.occupied, 0) AS slots_occupied
    FROM days d LEFT JOIN sl ON sl.day = d.day ORDER BY d.day`,
    [...P(f), Boolean(f.center_id || f.doctor_id || f.specialty_id)]);
  return r.rows.map((x) => ({ ...x, occupancy_rate: ratio(x.slots_occupied, x.slots_enabled) }));
}

/** Agrupación por médico o especialidad: operaciones por fecha de operación y ocupación por fecha del slot. */
export async function grouped(pool: Pool, f: StatsFilters, by: 'doctor' | 'specialty') {
  const key = by === 'doctor' ? 'ds.doctor_id' : 'ds.specialty_id';
  const nameSql = by === 'doctor' ? '(SELECT display_name FROM doctors WHERE id = g.key)' : '(SELECT name FROM specialties WHERE id = g.key)';
  const r = await pool.query(`
    WITH ${BASE}, ${EVENTS},
    g AS (SELECT DISTINCT ${key} AS key FROM doctor_services ds WHERE ds.id IN (SELECT id FROM svc)),
    e AS (SELECT ${key} AS key, ev.event_type, count(*)::int AS n FROM ev JOIN doctor_services ds ON ds.id = ev.doctor_service_id GROUP BY 1, 2),
    sl AS (SELECT ${key} AS key,
                  count(*) FILTER (WHERE s.status = 'open')::int AS enabled,
                  count(*) FILTER (WHERE s.status = 'open' AND EXISTS (SELECT 1 FROM appointments a WHERE a.slot_id = s.id AND a.status IN ${OCCUPYING}))::int AS occupied
           FROM slots s JOIN doctor_services ds ON ds.id = s.doctor_service_id, bounds b
           WHERE s.starts_at >= b.t0 AND s.starts_at < b.t1 AND s.doctor_service_id IN (SELECT id FROM svc) GROUP BY 1),
    at AS (SELECT ${key} AS key,
                  count(*) FILTER (WHERE a.status = 'completed')::int AS completed,
                  count(*) FILTER (WHERE a.status = 'no_show')::int AS no_show
           FROM appointments a JOIN slots s ON s.id = a.slot_id JOIN doctor_services ds ON ds.id = s.doctor_service_id, bounds b
           WHERE a.starts_at >= b.t0 AND a.starts_at < b.t1 AND a.starts_at <= now() AND s.doctor_service_id IN (SELECT id FROM svc) GROUP BY 1)
    SELECT g.key AS id, ${nameSql} AS name,
           coalesce((SELECT n FROM e WHERE e.key = g.key AND event_type = 'booked'), 0) AS bookings,
           coalesce((SELECT n FROM e WHERE e.key = g.key AND event_type = 'cancelled'), 0) AS cancellations,
           coalesce((SELECT n FROM e WHERE e.key = g.key AND event_type = 'rescheduled'), 0) AS reschedules,
           coalesce((SELECT n FROM e WHERE e.key = g.key AND event_type = 'advanced'), 0) AS advances,
           coalesce(sl.enabled, 0) AS slots_enabled, coalesce(sl.occupied, 0) AS slots_occupied,
           coalesce(at.completed, 0) AS completed, coalesce(at.no_show, 0) AS no_show
    FROM g LEFT JOIN sl ON sl.key = g.key LEFT JOIN at ON at.key = g.key
    ORDER BY bookings DESC, name`, P(f));
  return r.rows.map((x) => ({ ...x, occupancy_rate: ratio(x.slots_occupied, x.slots_enabled),
                              attendance_rate: ratio(x.completed, x.completed + x.no_show) }));
}

/** Ocupación por día de la semana (ISO 1 = lunes) y hora local de inicio del slot. */
export async function occupancyBuckets(pool: Pool, f: StatsFilters) {
  const r = await pool.query(`
    WITH ${BASE}
    SELECT extract(isodow FROM s.starts_at AT TIME ZONE $3)::int AS weekday,
           extract(hour FROM s.starts_at AT TIME ZONE $3)::int AS hour,
           count(*) FILTER (WHERE s.status = 'open')::int AS enabled,
           count(*) FILTER (WHERE s.status = 'open' AND EXISTS (SELECT 1 FROM appointments a WHERE a.slot_id = s.id AND a.status IN ${OCCUPYING}))::int AS occupied,
           count(*) FILTER (WHERE s.status = 'open' AND EXISTS (SELECT 1 FROM offer_rounds o WHERE o.slot_id = s.id AND o.status = 'open'))::int AS held_by_offer
    FROM slots s, bounds b
    WHERE s.starts_at >= b.t0 AND s.starts_at < b.t1 AND s.doctor_service_id IN (SELECT id FROM svc)
    GROUP BY 1, 2 ORDER BY 1, 2`, P(f));
  return r.rows.map((x) => ({ ...x, rate: ratio(x.occupied, x.enabled) }));
}

export async function offers(pool: Pool, f: StatsFilters) {
  const r = await pool.query(`
    WITH ${BASE},
    o AS (SELECT ao.status FROM advance_offers ao JOIN offer_rounds r ON r.id = ao.round_id JOIN slots s ON s.id = r.slot_id, bounds b
          WHERE ao.offered_at >= b.t0 AND ao.offered_at < b.t1 AND s.doctor_service_id IN (SELECT id FROM svc)),
    rounds AS (SELECT r.status FROM offer_rounds r JOIN slots s ON s.id = r.slot_id, bounds b
               WHERE r.created_at >= b.t0 AND r.created_at < b.t1 AND s.doctor_service_id IN (SELECT id FROM svc)),
    adv AS (SELECT extract(epoch FROM (e.from_starts_at - e.to_starts_at)) / 60 AS minutes
            FROM appointment_events e JOIN slots s ON s.id = e.to_slot_id, bounds b
            WHERE e.event_type = 'advanced' AND e.occurred_at >= b.t0 AND e.occurred_at < b.t1
              AND s.doctor_service_id IN (SELECT id FROM svc)),
    -- Slots liberados antes de su inicio por cancelación, reprogramación o adelanto
    freed AS (SELECT e.from_slot_id AS slot_id, min(e.occurred_at) AS freed_at
              FROM appointment_events e JOIN slots s ON s.id = e.from_slot_id, bounds b
              WHERE e.event_type IN ('cancelled','rescheduled','advanced') AND e.occurred_at >= b.t0 AND e.occurred_at < b.t1
                AND e.occurred_at < s.starts_at AND s.doctor_service_id IN (SELECT id FROM svc)
              GROUP BY 1),
    recovered AS (SELECT f.slot_id FROM freed f JOIN slots s ON s.id = f.slot_id
                  WHERE EXISTS (SELECT 1 FROM appointment_events e2 WHERE e2.to_slot_id = f.slot_id
                                AND e2.event_type IN ('booked','rescheduled','advanced')
                                AND e2.occurred_at > f.freed_at AND e2.occurred_at < s.starts_at))
    SELECT (SELECT coalesce(jsonb_object_agg(status, n), '{}') FROM (SELECT status, count(*)::int n FROM o GROUP BY 1) t) AS offers,
           (SELECT coalesce(jsonb_object_agg(status, n), '{}') FROM (SELECT status, count(*)::int n FROM rounds GROUP BY 1) t) AS rounds,
           (SELECT count(*)::int FROM adv) AS adv_n,
           (SELECT round(avg(minutes)::numeric, 1) FROM adv) AS adv_mean,
           (SELECT round((percentile_cont(0.5) WITHIN GROUP (ORDER BY minutes))::numeric, 1) FROM adv) AS adv_median,
           (SELECT count(*)::int FROM freed) AS freed, (SELECT count(*)::int FROM recovered) AS recovered`, P(f));
  const x = r.rows[0];
  const o = { pending: 0, accepted: 0, rejected: 0, expired: 0, invalidated: 0, delivery_failed: 0, ...x.offers };
  return {
    offers_by_status: o,
    acceptance_rate: ratio(o.accepted, o.accepted + o.rejected + o.expired),
    rounds_by_status: { open: 0, completed: 0, exhausted: 0, closed: 0, ...x.rounds },
    advance_minutes: { n: x.adv_n, mean: x.adv_mean === null ? null : Number(x.adv_mean), median: x.adv_median === null ? null : Number(x.adv_median) },
    recovery: { recovered_slots: x.recovered, freed_eligible_slots: x.freed, rate: ratio(x.recovered, x.freed) },
  };
}

/** Calidad del asistente. No admite filtros de médico/especialidad (las conversaciones no se atribuyen a un servicio). */
export async function conversation(pool: Pool, f: StatsFilters) {
  const r = await pool.query(`
    WITH bounds AS (SELECT ($1::date)::timestamp AT TIME ZONE $3 AS t0, ($2::date)::timestamp AT TIME ZONE $3 AS t1),
    m AS (SELECT m.* FROM messages m, bounds b WHERE m.direction = 'outbound' AND m.created_at >= b.t0 AND m.created_at < b.t1)
    SELECT
      (SELECT count(*)::int FROM m) AS replies,
      (SELECT coalesce(jsonb_object_agg(mode, n), '{}') FROM (SELECT coalesce(mode, 'desconocido') mode, count(*)::int n FROM m GROUP BY 1) t) AS by_mode,
      (SELECT count(*)::int FROM m WHERE (payload->>'clarification')::boolean IS TRUE
                                          OR payload ?| array['date_choices','specialty_choices','appointment_choices','suggestions']) AS clarifications,
      (SELECT count(*)::int FROM m WHERE intent = 'llm_error') AS llm_errors,
      (SELECT coalesce(jsonb_object_agg(intent, n), '{}') FROM (SELECT intent, count(*)::int n FROM m WHERE mode = 'ai' GROUP BY 1) t) AS ai_by_intent,
      (SELECT count(*)::int FROM m WHERE latency_ms IS NOT NULL) AS latency_n,
      (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY latency_ms) FROM m WHERE latency_ms IS NOT NULL) AS latency_p50,
      (SELECT percentile_cont(0.9) WITHIN GROUP (ORDER BY latency_ms) FROM m WHERE latency_ms IS NOT NULL) AS latency_p90,
      (SELECT coalesce(sum(prompt_tokens), 0)::int FROM m) AS prompt_tokens,
      (SELECT coalesce(sum(completion_tokens), 0)::int FROM m) AS completion_tokens,
      (SELECT count(*)::int FROM handoff_cases h, bounds b WHERE h.created_at >= b.t0 AND h.created_at < b.t1) AS handoffs`, P(f).slice(0, 3));
  const x = r.rows[0];
  return {
    replies: x.replies, by_mode: { ai: 0, deterministic: 0, fallback_menu: 0, system: 0, ...x.by_mode },
    clarifications: x.clarifications, llm_errors: x.llm_errors, ai_by_intent: x.ai_by_intent, handoffs: x.handoffs,
    model_latency_ms: { n: x.latency_n, p50: x.latency_p50 === null ? null : Math.round(x.latency_p50),
                        p90: x.latency_p90 === null ? null : Math.round(x.latency_p90) },
    tokens: { prompt: x.prompt_tokens, completion: x.completion_tokens },
  };
}

function ratio(num: number, den: number): number | null {
  return den > 0 ? Math.round((num / den) * 10000) / 10000 : null;
}
