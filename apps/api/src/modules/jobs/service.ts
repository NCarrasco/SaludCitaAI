// Cola durable (outbox_jobs) y planificador.
// - El planificador (n8n cada minuto → POST /internal/scheduler/tick) materializa vencimientos de ofertas,
//   encarga la limpieza diaria de invitados, cierra trabajos de calendario sin credenciales y amplía la agenda.
//   Los recordatorios y comprobantes son comandos durables (modules/commands) que ejecuta n8n.
// - Los trabajos externos (calendario) los reclama n8n con lease; se confirman o fallan con backoff y quedan
//   'dead' tras agotar intentos. Un lease vencido (reinicio de n8n) se puede reclamar de nuevo.

import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from '../../db/pool.js';
import { withTransaction } from '../../db/tx.js';
import { conflict, notFound } from '../../shared/errors.js';
import { period } from '../../shared/text.js';
import { spanishLabel } from '../../shared/time.js';
import { type OfferConfig, expireDueOffers } from '../offers/service.js';

const LEASE_SECONDS = 120;

export interface TickResult { expired_offers: number; commands_enqueued: number;
  calendar_jobs_without_credentials: number; recovered_leases: number; generated_slots: number }

export async function tick(pool: Pool, cfg: OfferConfig): Promise<TickResult> {
  const out: TickResult = { expired_offers: 0, commands_enqueued: 0, calendar_jobs_without_credentials: 0, recovered_leases: 0, generated_slots: 0 };
  // 1. Vencimientos de ofertas (cada uno puede emitir la oferta siguiente)
  for (;;) {
    const n = await withTransaction(pool, (c) => expireDueOffers(c, cfg, 25));
    out.expired_offers += n;
    if (n < 25) break;
  }
  // 2. Leases vencidos (proceso caído durante la ejecución)
  out.recovered_leases = (await pool.query(
    `UPDATE outbox_jobs SET status = 'pending', lease_token = NULL, lease_until = NULL, last_error = coalesce(last_error, 'lease vencido')
     WHERE status = 'leased' AND lease_until < now()`)).rowCount ?? 0;
  // 3. Recordatorios: ya no se publican aquí; son comandos durables que ejecuta n8n (workflow «Comandos durables»).
  //    Limpieza diaria de sesiones invitadas: se encarga un comando por día (idempotente por fecha).
  out.commands_enqueued = (await pool.query(
    `INSERT INTO outbox_jobs (kind, dedupe_key, payload) VALUES ('maintenance.guest_cleanup', 'guest_cleanup:' || (now() AT TIME ZONE $1)::date, '{}')
     ON CONFLICT (dedupe_key) DO NOTHING`, [cfg.tz])).rowCount ?? 0;
  // 4. Calendario sin vínculo habilitado (sin credenciales): no se simula la sincronización
  out.calendar_jobs_without_credentials = await withTransaction(pool, async (c) => {
    const r = await c.query(
      `UPDATE outbox_jobs j SET status = 'done', done_at = now(), result = '{"skipped":"calendar_not_configured"}'
       FROM appointments a JOIN slots s ON s.id = a.slot_id
       WHERE j.kind = 'calendar.sync' AND j.status = 'pending' AND a.id = j.aggregate_id
         AND NOT EXISTS (SELECT 1 FROM calendar_bindings b WHERE b.doctor_id = s.doctor_id AND b.enabled)
       RETURNING j.aggregate_id`);
    if (r.rowCount) {
      await c.query(`UPDATE calendar_sync SET status = 'disabled', last_error = 'calendario no configurado (faltan credenciales)'
                     WHERE appointment_id = ANY($1::uuid[])`, [r.rows.map((x) => x.aggregate_id)]);
    }
    return r.rowCount ?? 0;
  });
  // 5. Agenda: mantener 30 días generados (idempotente; solo si falta el último día)
  const need = (await pool.query(
    `SELECT coalesce(max(starts_at), now()) < now() + interval '29 days' AS need FROM slots`)).rows[0].need;
  if (need) out.generated_slots = (await pool.query(`SELECT generate_slots((now() AT TIME ZONE $1)::date, 30) AS n`, [cfg.tz])).rows[0].n;
  return out;
}

// ---------------------------------------------------------------------------
// Trabajos externos: calendario
// ---------------------------------------------------------------------------

export async function claimJobs(pool: Pool, kinds: string[], limit: number, tz: string) {
  return withTransaction(pool, async (c) => {
    // Un trabajo de calendario obsoleto (versión anterior a la deseada) se cierra como reemplazado
    await c.query(
      `UPDATE outbox_jobs j SET status = 'done', done_at = now(), result = '{"skipped":"superseded"}'
       FROM calendar_sync cs WHERE j.kind = 'calendar.sync' AND j.status = 'pending' AND cs.appointment_id = j.aggregate_id
         AND (j.payload->>'version')::int < cs.desired_version`);
    const rows = (await c.query(
      `SELECT j.id, j.kind, j.aggregate_id, j.payload, j.attempts FROM outbox_jobs j
       WHERE j.kind = ANY($1::text[]) AND j.available_at <= now()
         AND (j.status = 'pending' OR (j.status = 'leased' AND j.lease_until < now()))
         AND NOT EXISTS (SELECT 1 FROM outbox_jobs o WHERE o.aggregate_id = j.aggregate_id AND o.id <> j.id
                         AND o.status = 'leased' AND o.lease_until >= now())
       ORDER BY j.available_at LIMIT $2 FOR UPDATE SKIP LOCKED`, [kinds, limit])).rows;
    const out = [];
    for (const j of rows) {
      const lease = randomUUID();
      await c.query(`UPDATE outbox_jobs SET status = 'leased', lease_token = $2, lease_until = now() + make_interval(secs => $3),
                       attempts = attempts + 1 WHERE id = $1`, [j.id, lease, LEASE_SECONDS]);
      out.push({ job_id: j.id, kind: j.kind, lease_token: lease, attempt: j.attempts + 1, ...(await describe(c, j, tz)) });
    }
    return out;
  });
}

/** Estado deseado del evento de calendario: se calcula al reclamar con el estado VIGENTE de la cita. */
async function describe(c: PoolClient, j: { kind: string; aggregate_id: string; payload: { version: number } }, tz: string) {
  if (j.kind !== 'calendar.sync') return { payload: j.payload };
  const a = (await c.query(
    `SELECT a.id, a.status, a.version, a.booking_reference, s.starts_at, s.ends_at, sp.name AS specialty, ce.name AS center,
            cs.external_event_id, b.external_calendar_id
     FROM appointments a JOIN slots s ON s.id = a.slot_id JOIN doctor_services ds ON ds.id = s.doctor_service_id
     JOIN specialties sp ON sp.id = ds.specialty_id JOIN centers ce ON ce.id = ds.center_id
     JOIN calendar_sync cs ON cs.appointment_id = a.id LEFT JOIN calendar_bindings b ON b.id = cs.binding_id
     WHERE a.id = $1`, [j.aggregate_id])).rows[0];
  return {
    calendar: {
      action: a.status === 'cancelled' ? 'delete' : 'upsert',
      calendar_id: a.external_calendar_id, event_id: a.external_event_id, version: a.version,
      // Sin nombre del paciente: solo referencia administrativa
      event: { summary: `Cita ${a.booking_reference} · ${a.specialty}`, description: `Cita de demostración (datos ficticios). Referencia ${a.booking_reference}.`,
               location: a.center, start: { dateTime: a.starts_at.toISOString(), timeZone: tz }, end: { dateTime: a.ends_at.toISOString(), timeZone: tz } },
    },
  };
}

async function lockLeased(c: PoolClient, id: string, lease: string) {
  const j = (await c.query(`SELECT id, kind, aggregate_id, payload, status, lease_token, attempts, max_attempts FROM outbox_jobs WHERE id = $1 FOR UPDATE`, [id])).rows[0];
  if (!j) throw notFound('Trabajo');
  if (j.status !== 'leased' || j.lease_token !== lease) throw conflict('lease_lost', 'El lease del trabajo ya no es válido');
  return j;
}

export async function ackJob(pool: Pool, id: string, lease: string, result: { version?: number; external_event_id?: string; action?: string }) {
  return withTransaction(pool, async (c) => {
    const j = await lockLeased(c, id, lease);
    await c.query(`UPDATE outbox_jobs SET status = 'done', done_at = now(), result = $2, lease_token = NULL, lease_until = NULL WHERE id = $1`,
      [id, JSON.stringify(result)]);
    if (j.kind === 'calendar.sync' && result.version !== undefined) {
      // Converge al estado más reciente: nunca retrocede synced_version
      await c.query(
        `UPDATE calendar_sync SET synced_version = GREATEST(coalesce(synced_version, 0), $2), last_synced_at = now(), last_error = NULL,
           status = CASE WHEN GREATEST(coalesce(synced_version, 0), $2) >= desired_version THEN 'synced' ELSE 'pending' END
         WHERE appointment_id = $1`, [j.aggregate_id, result.version]);
    }
    return { job_id: id, status: 'done' };
  });
}

export async function failJob(pool: Pool, id: string, lease: string, error: string) {
  return withTransaction(pool, async (c) => {
    const j = await lockLeased(c, id, lease);
    const dead = j.attempts >= j.max_attempts;
    // Backoff exponencial con jitter: 30 s, 60 s, 120 s… (máx. 30 min)
    const delay = Math.min(1800, 30 * 2 ** (j.attempts - 1)) * (0.8 + Math.random() * 0.4);
    await c.query(
      `UPDATE outbox_jobs SET status = $2, last_error = $3, lease_token = NULL, lease_until = NULL,
         available_at = CASE WHEN $2 = 'pending' THEN now() + make_interval(secs => $4) ELSE available_at END WHERE id = $1`,
      [id, dead ? 'dead' : 'pending', error.slice(0, 1000), delay]);
    if (j.kind === 'calendar.sync') {
      await c.query(`UPDATE calendar_sync SET status = $2, last_error = $3 WHERE appointment_id = $1`,
        [j.aggregate_id, dead ? 'failed' : 'pending', error.slice(0, 1000)]);
    }
    return { job_id: id, status: dead ? 'dead' : 'pending', retry_in_seconds: dead ? null : Math.round(delay) };
  });
}
