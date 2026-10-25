import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { randomUUID } from 'node:crypto';
import { Type } from 'typebox';
import type { Pool } from '../../db/pool.js';
import { withTransaction } from '../../db/tx.js';
import { adminOf, requireAdmin } from '../../plugins/auth.js';
import { conflict, notFound } from '../../shared/errors.js';
import { idempotent, requireIdempotencyKey } from '../../shared/idempotency.js';
import { DateTime, Uuid, errorResponses } from '../../shared/schemas.js';
import { spanishLabel, toZonedIso } from '../../shared/time.js';
import { AdminCookieSecurity } from '../auth/admin-routes.js';

const iso = (d: Date | null, tz: string) => (d ? toZonedIso(d, tz) : null);

export const adminRoutes: FastifyPluginAsyncTypebox<{ pool: Pool; tz: string; ollamaUrl: string; ollamaModel: string }> =
  async (app, { pool, tz, ollamaUrl, ollamaModel }) => {
    // --- Traspasos al personal (operator) ---
    const Handoff = Type.Object({
      id: Uuid, reference: Type.Union([Type.String(), Type.Null()]), status: Type.String(), reason: Type.String(),
      patient: Type.Object({ id: Uuid, full_name: Type.Union([Type.String(), Type.Null()]),
        phone: Type.Union([Type.String(), Type.Null()]), email: Type.Union([Type.String(), Type.Null()]) }),
      created_at: DateTime, resolved_at: Type.Union([DateTime, Type.Null()]),
      resolution_note: Type.Union([Type.String(), Type.Null()], { description: 'Qué hizo el personal (se envía al paciente si patient_notified)' }),
      patient_notified: Type.Boolean({ description: 'El paciente recibió el aviso en la bandeja «Avisos» del chat' }),
      resolved_by: Type.Union([Type.String(), Type.Null()], { description: 'Nombre o correo de quien la resolvió' }),
    });
    const HANDOFF_SQL = `SELECT h.id, h.reference, h.status, h.reason, h.created_at, h.resolved_at, h.resolution_note, h.patient_notified, h.conversation_id,
        p.id AS patient_id, p.full_name, p.phone, p.email, COALESCE(u.display_name, u.email) AS resolved_by
      FROM handoff_cases h JOIN patients p ON p.id = h.patient_id LEFT JOIN admin_users u ON u.id = h.resolved_by`;
    const handoffView = (h: any) => ({ id: h.id, reference: h.reference, status: h.status, reason: h.reason,
      patient: { id: h.patient_id, full_name: h.full_name, phone: h.phone ?? null, email: h.email ?? null },
      created_at: iso(h.created_at, tz)!, resolved_at: iso(h.resolved_at, tz),
      resolution_note: h.resolution_note ?? null, patient_notified: Boolean(h.patient_notified), resolved_by: h.resolved_by ?? null });

    app.get('/handoffs', {
      preHandler: requireAdmin('operator'),
      schema: {
        operationId: 'listHandoffs', tags: ['Administración: operación'], security: AdminCookieSecurity,
        summary: 'Solicitudes de ayuda creadas desde el asistente (incluye el nombre ficticio del paciente; rol operator)',
        querystring: Type.Object({ status: Type.Optional(Type.Union([Type.Literal('open'), Type.Literal('resolved')])),
                                   limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 50 })) }),
        response: { 200: Type.Object({ items: Type.Array(Handoff) }), ...errorResponses(400, 401, 403) },
      },
    }, async (req) => {
      const r = await pool.query(`${HANDOFF_SQL} WHERE ($1::text IS NULL OR h.status = $1)
         ORDER BY CASE WHEN h.status = 'resolved' THEN h.resolved_at END DESC NULLS LAST, h.created_at DESC LIMIT $2`,
        [req.query.status ?? null, req.query.limit ?? 50]);
      return { items: r.rows.map(handoffView) };
    });

    app.get('/handoffs/:id', {
      preHandler: requireAdmin('operator'),
      schema: {
        operationId: 'getHandoff', tags: ['Administración: operación'], security: AdminCookieSecurity,
        summary: 'Detalle de una solicitud: últimos mensajes del paciente con el asistente antes de pedir ayuda y sus próximas citas',
        params: Type.Object({ id: Uuid }),
        response: { 200: Type.Object({ ...Handoff.properties,
          messages: Type.Array(Type.Object({ from: Type.Union([Type.Literal('patient'), Type.Literal('assistant')]), text: Type.String(), at: DateTime })),
          appointments: Type.Array(Type.Object({ id: Uuid, booking_reference: Type.String(), starts_at: DateTime, specialty: Type.String(), doctor: Type.String() })),
        }), ...errorResponses(401, 403, 404) },
      },
    }, async (req) => {
      const h = (await pool.query(`${HANDOFF_SQL} WHERE h.id = $1`, [req.params.id])).rows[0];
      if (!h) throw notFound('Solicitud');
      // Contexto: los 12 últimos mensajes de esa conversación hasta el momento de la solicitud (más 1 minuto: su propia respuesta)
      const msgs = h.conversation_id ? (await pool.query(
        `SELECT direction, content, created_at FROM (SELECT direction, content, created_at FROM messages
           WHERE conversation_id = $1 AND created_at <= $2::timestamptz + interval '1 minute'
           ORDER BY created_at DESC, direction = 'outbound' DESC LIMIT 12) m ORDER BY created_at, direction = 'outbound'`,
        [h.conversation_id, h.created_at])).rows : [];
      const appts = (await pool.query(
        `SELECT a.id, a.booking_reference, a.starts_at, sp.name AS specialty, d.display_name AS doctor
         FROM appointments a JOIN slots s ON s.id = a.slot_id JOIN doctor_services ds ON ds.id = s.doctor_service_id
         JOIN specialties sp ON sp.id = ds.specialty_id JOIN doctors d ON d.id = s.doctor_id
         WHERE a.patient_id = $1 AND a.status = 'booked' AND a.starts_at > now() ORDER BY a.starts_at LIMIT 10`, [h.patient_id])).rows;
      return { ...handoffView(h),
        messages: msgs.map((m) => ({ from: m.direction === 'inbound' ? 'patient' as const : 'assistant' as const, text: m.content, at: iso(m.created_at, tz)! })),
        appointments: appts.map((a) => ({ id: a.id, booking_reference: a.booking_reference, starts_at: iso(a.starts_at, tz)!, specialty: a.specialty, doctor: a.doctor })) };
    });

    app.patch('/handoffs/:id', {
      preHandler: requireAdmin('operator'),
      schema: {
        operationId: 'resolveHandoff', tags: ['Administración: operación'], security: AdminCookieSecurity,
        summary: 'Marca una solicitud de ayuda como resuelta, con una nota opcional de lo que se hizo. Si notify_patient (por defecto ' +
          'sí), el paciente recibe un aviso en la bandeja «Avisos» del chat. Idempotente: resolverla otra vez no cambia nada ni repite el aviso.',
        params: Type.Object({ id: Uuid }),
        body: Type.Object({ status: Type.Literal('resolved'), note: Type.Optional(Type.String({ maxLength: 500 })),
                            notify_patient: Type.Optional(Type.Boolean({ default: true })) }, { additionalProperties: false }),
        response: { 200: Handoff, ...errorResponses(400, 401, 403, 404) },
      },
    }, async (req) => {
      const note = req.body.note?.trim() || null;
      const notify = req.body.notify_patient ?? true;
      const id = await withTransaction(pool, async (c) => {
        const cur = (await c.query(`SELECT id, patient_id, reference, status, created_at FROM handoff_cases WHERE id = $1 FOR UPDATE`, [req.params.id])).rows[0];
        if (!cur) throw notFound('Solicitud');
        if (cur.status === 'resolved') return cur.id as string; // ya resuelta: sin cambios ni aviso repetido
        await c.query(
          `UPDATE handoff_cases SET status = 'resolved', resolved_at = now(), resolved_by = $2, resolution_note = $3, patient_notified = $4, updated_at = now()
           WHERE id = $1`, [cur.id, adminOf(req).adminUserId, note, notify]);
        if (notify) {
          const ref = cur.reference ? ` ${cur.reference}` : '';
          const body = `Tu solicitud de ayuda${ref} del ${spanishLabel(cur.created_at, tz)} fue atendida por el personal.` +
            (note ? ` Nota del personal: ${note}` : ' Si necesitas algo más, escríbele a Salu o pide de nuevo hablar con el personal.');
          await c.query(
            `INSERT INTO notifications (patient_id, kind, title, body, dedupe_key, status, sent_at)
             VALUES ($1, 'handoff_update', 'El personal atendió tu solicitud', $2, $3, 'sent', now()) ON CONFLICT (dedupe_key) DO NOTHING`,
            [cur.patient_id, body, `handoff:${cur.id}:resolved`]);
        }
        return cur.id as string;
      });
      return handoffView((await pool.query(`${HANDOFF_SQL} WHERE h.id = $1`, [id])).rows[0]);
    });

    // --- Asistencia (operator): solo tras el inicio de la cita ---
    app.post('/appointments/:id/attendance', {
      preHandler: requireAdmin('operator'),
      schema: {
        operationId: 'markAttendance', tags: ['Administración: operación'], security: AdminCookieSecurity,
        summary: 'Registra asistencia (completed) o inasistencia (no_show) de una cita ya iniciada',
        description: 'Requiere Idempotency-Key y X-CSRF-Token. Valida la versión esperada; el bot nunca acredita asistencia.',
        params: Type.Object({ id: Uuid }),
        headers: Type.Object({ 'idempotency-key': Type.String({ minLength: 8, maxLength: 200 }) }),
        body: Type.Object({ status: Type.Union([Type.Literal('completed'), Type.Literal('no_show')]), expected_version: Type.Integer({ minimum: 1 }) },
          { additionalProperties: false }),
        response: {
          200: Type.Object({ appointment_id: Uuid, status: Type.String(), version: Type.Integer() }),
          ...errorResponses(400, 401, 403, 404, 409),
        },
      },
    }, async (req, reply) => {
      const admin = adminOf(req);
      const key = requireIdempotencyKey(req.headers['idempotency-key']);
      const res = await withTransaction(pool, (c) => idempotent(c, {
        principalId: admin.id, route: 'POST /appointments/:id/attendance', key, request: { id: req.params.id, body: req.body },
      }, async () => {
        const a = (await c.query(`SELECT id, patient_id, slot_id, status, version, starts_at FROM appointments WHERE id = $1 FOR UPDATE`,
          [req.params.id])).rows[0];
        if (!a) throw notFound('Cita');
        if (a.status !== 'booked') throw conflict('appointment_not_active', 'Solo se registra asistencia de citas reservadas', { status: a.status });
        if (a.version !== req.body.expected_version) throw conflict('appointment_version_mismatch', 'La cita cambió', { current_version: a.version });
        if (a.starts_at.getTime() > Date.now()) throw conflict('appointment_not_started', 'La cita todavía no ha comenzado');
        const u = (await c.query(`UPDATE appointments SET status = $2, version = version + 1 WHERE id = $1 RETURNING status, version`,
          [a.id, req.body.status])).rows[0];
        const corr = randomUUID();
        await c.query(
          `INSERT INTO appointment_events (appointment_id, event_type, appointment_version, to_slot_id, to_starts_at, status_before, status_after,
                                           actor_type, actor_id, correlation_id)
           VALUES ($1, $2, $3, $4, $5, 'booked', $2, 'operator', $6, $7)`,
          [a.id, req.body.status, u.version, a.slot_id, a.starts_at, admin.adminUserId, corr]);
        const ds = (await c.query('SELECT doctor_service_id FROM slots WHERE id = $1', [a.slot_id])).rows[0].doctor_service_id;
        await c.query(
          `INSERT INTO analytics_events (event_type, patient_id, doctor_service_id, appointment_id, correlation_id, dedupe_key, metadata)
           VALUES ($1, $2, $3, $4, $5, $6, '{}') ON CONFLICT (dedupe_key) DO NOTHING`,
          [`attendance_${req.body.status}`, a.patient_id, ds, a.id, corr, `appt:${a.id}:v${u.version}:attendance`]);
        return { status: 200, body: { appointment_id: a.id, status: u.status, version: u.version } };
      }));
      reply.header('idempotent-replayed', String(res.replayed));
      return reply.code(res.status as 200).send(res.status >= 400 ? { ...(res.body as object), request_id: req.id } as any : res.body as any);
    });

    // --- Cola durable e integraciones ---
    const Job = Type.Object({
      id: Uuid, kind: Type.String(), status: Type.String(), attempts: Type.Integer(), max_attempts: Type.Integer(),
      aggregate_id: Type.Union([Uuid, Type.Null()]), available_at: DateTime, last_error: Type.Union([Type.String(), Type.Null()]),
      updated_at: DateTime,
    });

    app.get('/admin/jobs', {
      preHandler: requireAdmin('admin'),
      schema: {
        operationId: 'listJobs', tags: ['Administración: operación'], security: AdminCookieSecurity,
        summary: 'Trabajos de la cola durable (sin payloads ni secretos)',
        querystring: Type.Object({
          status: Type.Optional(Type.Union(['pending', 'leased', 'done', 'dead', 'cancelled'].map((s) => Type.Literal(s)))),
          kind: Type.Optional(Type.String({ maxLength: 60 })),
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 50 })),
        }),
        response: { 200: Type.Object({ items: Type.Array(Job) }), ...errorResponses(400, 401, 403) },
      },
    }, async (req) => {
      const r = await pool.query(
        `SELECT id, kind, status, attempts, max_attempts, aggregate_id, available_at, left(last_error, 500) AS last_error, updated_at
         FROM outbox_jobs WHERE ($1::text IS NULL OR status = $1) AND ($2::text IS NULL OR kind = $2)
         ORDER BY updated_at DESC LIMIT $3`, [req.query.status ?? null, req.query.kind ?? null, req.query.limit ?? 50]);
      return { items: r.rows.map((j) => ({ ...j, available_at: iso(j.available_at, tz)!, updated_at: iso(j.updated_at, tz)! })) };
    });

    app.post('/admin/jobs/:id/retry', {
      preHandler: requireAdmin('admin'),
      schema: {
        operationId: 'retryJob', tags: ['Administración: operación'], security: AdminCookieSecurity,
        summary: 'Reintenta un trabajo en estado dead (requiere X-CSRF-Token)',
        params: Type.Object({ id: Uuid }),
        response: { 200: Type.Object({ id: Uuid, status: Type.String() }), ...errorResponses(400, 401, 403, 404, 409) },
      },
    }, async (req) => {
      const r = await pool.query(
        `UPDATE outbox_jobs SET status = 'pending', attempts = 0, available_at = now(), lease_until = NULL, lease_token = NULL
         WHERE id = $1 AND status = 'dead' RETURNING id, status`, [req.params.id]);
      if (r.rows[0]) return r.rows[0];
      const exists = (await pool.query('SELECT status FROM outbox_jobs WHERE id = $1', [req.params.id])).rows[0];
      if (!exists) throw notFound('Trabajo');
      throw conflict('job_not_dead', 'Solo se reintentan trabajos en estado dead', { status: exists.status });
    });

    app.get('/admin/integrations', {
      preHandler: requireAdmin('admin'),
      schema: {
        operationId: 'getIntegrations', tags: ['Administración: operación'], security: AdminCookieSecurity,
        summary: 'Estado de dependencias e integraciones, comprobado en el momento (sin secretos)',
        response: {
          200: Type.Object({
            checked_at: DateTime,
            database: Type.Object({ status: Type.String() }),
            model: Type.Object({ status: Type.String(), configured_model: Type.String(), model_present: Type.Union([Type.Boolean(), Type.Null()]) }),
            calendar: Type.Object({ status: Type.String(), enabled_bindings: Type.Integer(), sync_by_status: Type.Record(Type.String(), Type.Integer()) }),
            outbox_by_status: Type.Record(Type.String(), Type.Integer()),
            conversation_updates_by_status: Type.Record(Type.String(), Type.Integer()),
          }),
          ...errorResponses(401, 403),
        },
      },
    }, async () => {
      const agg = async (sql: string) => Object.fromEntries((await pool.query(sql)).rows.map((r) => [r.status, r.n]));
      let model = { status: 'unreachable', configured_model: ollamaModel, model_present: null as boolean | null };
      try {
        const r = await fetch(`${ollamaUrl.replace(/\/$/, '')}/api/tags`, { signal: AbortSignal.timeout(2000) });
        const tags = (await r.json()) as { models?: { name: string }[] };
        const present = Boolean(tags.models?.some((m) => m.name === ollamaModel || m.name === `${ollamaModel}:latest`));
        model = { status: r.ok ? (present ? 'ok' : 'model_missing') : 'error', configured_model: ollamaModel, model_present: present };
      } catch { /* inalcanzable: se informa tal cual */ }
      const bindings = Number((await pool.query('SELECT count(*) FROM calendar_bindings WHERE enabled')).rows[0].count);
      return {
        checked_at: toZonedIso(new Date(), tz),
        database: { status: 'ok' },
        model,
        calendar: { status: bindings > 0 ? 'configured' : 'pending_credentials', enabled_bindings: bindings,
                    sync_by_status: await agg('SELECT status, count(*)::int n FROM calendar_sync GROUP BY 1') },
        outbox_by_status: await agg('SELECT status, count(*)::int n FROM outbox_jobs GROUP BY 1'),
        conversation_updates_by_status: await agg('SELECT status, count(*)::int n FROM inbound_updates GROUP BY 1'),
      };
    });
  };
