import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from 'typebox';
import type { Pool } from '../../db/pool.js';
import { patientOf, requirePatient } from '../../plugins/auth.js';
import { notFound } from '../../shared/errors.js';
import { BearerSecurity, DateTime, Uuid, errorResponses } from '../../shared/schemas.js';
import { toZonedIso } from '../../shared/time.js';

const Notification = Type.Object({
  id: Uuid, kind: Type.String(), title: Type.String(), body: Type.String(),
  appointment_id: Type.Union([Uuid, Type.Null()]), offer_id: Type.Union([Uuid, Type.Null()]),
  sent_at: Type.Union([DateTime, Type.Null()], { description: 'Publicado en la bandeja web (no implica lectura)' }),
  read_at: Type.Union([DateTime, Type.Null()]),
}, { $id: 'Notification', title: 'Notification' });

export const notificationRoutes: FastifyPluginAsyncTypebox<{ pool: Pool; tz: string }> = async (app, { pool, tz }) => {
  app.addSchema(Notification);
  const view = (r: any) => ({ ...r, sent_at: r.sent_at ? toZonedIso(r.sent_at, tz) : null, read_at: r.read_at ? toZonedIso(r.read_at, tz) : null });

  app.get('/notifications', {
    preHandler: requirePatient,
    schema: {
      operationId: 'listMyNotifications', tags: ['Avisos'], security: BearerSecurity,
      summary: 'Bandeja de avisos del paciente (no leídos primero), paginada. Sin push, SMS ni correo en el MVP.',
      description: 'Excluye los avisos archivados. total = avisos que cumplen el filtro (para «Mostrar más»).',
      querystring: Type.Object({
        unread_only: Type.Optional(Type.Boolean()),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 30 })),
        offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 10000, default: 0 })),
      }),
      response: { 200: Type.Object({ unread: Type.Integer(), total: Type.Integer(), items: Type.Array(Type.Ref('Notification')) }), ...errorResponses(400, 401, 403) },
    },
  }, async (req) => {
    const { patientId } = patientOf(req);
    const unreadOnly = req.query.unread_only ?? false;
    const r = await pool.query(
      `SELECT id, kind, title, body, appointment_id, offer_id, sent_at, read_at FROM notifications
       WHERE patient_id = $1 AND status = 'sent' AND archived_at IS NULL AND ($2::boolean IS NOT TRUE OR read_at IS NULL)
       ORDER BY (read_at IS NULL) DESC, created_at DESC, id LIMIT $3 OFFSET $4`,
      [patientId, unreadOnly, req.query.limit ?? 30, req.query.offset ?? 0]);
    const c = (await pool.query(
      `SELECT count(*) FILTER (WHERE read_at IS NULL)::int AS unread,
              count(*) FILTER (WHERE $2::boolean IS NOT TRUE OR read_at IS NULL)::int AS total
       FROM notifications WHERE patient_id = $1 AND status = 'sent' AND archived_at IS NULL`, [patientId, unreadOnly])).rows[0];
    return { unread: c.unread, total: c.total, items: r.rows.map(view) as any };
  });

  app.post('/notifications/:id/archive', {
    preHandler: requirePatient,
    schema: {
      operationId: 'archiveNotification', tags: ['Avisos'], security: BearerSecurity,
      summary: 'Quita un aviso propio de la bandeja (lo archiva y lo marca como leído; no se borra). Idempotente',
      params: Type.Object({ id: Uuid }),
      response: { 200: Type.Object({ archived: Type.Boolean() }), ...errorResponses(400, 401, 403, 404) },
    },
  }, async (req) => {
    const r = await pool.query(
      `UPDATE notifications SET archived_at = COALESCE(archived_at, now()), read_at = COALESCE(read_at, now())
       WHERE id = $1 AND patient_id = $2 AND status = 'sent' RETURNING id`, [req.params.id, patientOf(req).patientId]);
    if (!r.rows[0]) throw notFound('Aviso');
    return { archived: true };
  });

  app.post('/notifications/read-all', {
    preHandler: requirePatient,
    schema: {
      operationId: 'markAllNotificationsRead', tags: ['Avisos'], security: BearerSecurity,
      summary: 'Marca como leídos todos los avisos propios',
      response: { 200: Type.Object({ updated: Type.Integer() }), ...errorResponses(401, 403) },
    },
  }, async (req) => {
    const r = await pool.query(`UPDATE notifications SET read_at = now() WHERE patient_id = $1 AND status = 'sent' AND read_at IS NULL`,
      [patientOf(req).patientId]);
    return { updated: r.rowCount ?? 0 };
  });

  app.post('/notifications/:id/read', {
    preHandler: requirePatient,
    schema: {
      operationId: 'markNotificationRead', tags: ['Avisos'], security: BearerSecurity,
      summary: 'Marca un aviso propio como leído (idempotente)',
      params: Type.Object({ id: Uuid }),
      response: { 200: Type.Object({ notification: Type.Ref('Notification') }), ...errorResponses(400, 401, 403, 404) },
    },
  }, async (req) => {
    const r = await pool.query(
      `UPDATE notifications SET read_at = COALESCE(read_at, now()) WHERE id = $1 AND patient_id = $2 AND status = 'sent'
       RETURNING id, kind, title, body, appointment_id, offer_id, sent_at, read_at`, [req.params.id, patientOf(req).patientId]);
    if (!r.rows[0]) throw notFound('Aviso');
    return { notification: view(r.rows[0]) };
  });
};
