import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from 'typebox';
import type { Pool } from '../../db/pool.js';
import { adminOf, requireAdmin } from '../../plugins/auth.js';
import { LocalDate, Uuid, errorResponses } from '../../shared/schemas.js';
import { AdminCookieSecurity } from '../auth/admin-routes.js';
import { dashboard } from './dashboard.js';
import type { LiveClient, LiveHub } from './hub.js';

const MAX_STREAMS_PER_SESSION = 4;

export const liveRoutes: FastifyPluginAsyncTypebox<{ pool: Pool; tz: string; hub: LiveHub | null; heartbeatMs?: number }> =
  async (app, { pool, tz, hub, heartbeatMs = 20_000 }) => {
  const tag = { tags: ['Panel: operación en vivo'], security: AdminCookieSecurity };

  app.get('/admin/dashboard', {
    preHandler: requireAdmin('viewer'),
    schema: { ...tag, operationId: 'getAdminDashboard',
      summary: 'Portada operativa: hoy y próximas citas, actividad reciente, solicitudes de ayuda, disponibilidad y alertas',
      description: 'Citas por fecha de atención y operaciones por fecha en que ocurrieron. Paciente y referencia solo para operator/admin; ' +
        'un viewer recibe cifras agregadas (scope = aggregate). `date` (por defecto, hoy) y los filtros afectan a indicadores, agenda y ' +
        'operaciones del día; próximas citas y actividad usan solo los filtros; alertas y solicitudes son de todo el hospital.',
      querystring: Type.Object({ date: Type.Optional(LocalDate), center_id: Type.Optional(Uuid), specialty_id: Type.Optional(Uuid), doctor_id: Type.Optional(Uuid) }),
      response: { 200: Type.Record(Type.String(), Type.Unknown()), ...errorResponses(400, 401, 403) } },
  }, async (req) => dashboard(pool, tz, adminOf(req).role, req.query));

  app.get('/admin/events', {
    preHandler: requireAdmin('viewer'),
    schema: { ...tag, operationId: 'streamAdminEvents',
      summary: 'Eventos en vivo (Server-Sent Events): avisos de invalidación tras cada cambio confirmado',
      description: 'Eventos: hello, change {topic, kind, at[, id]}, resync (volver a consultar todo), degraded, session-ended. ' +
        'Sin datos personales: el panel vuelve a pedir los datos a los endpoints autorizados. Latido cada 20 s.',
      response: { ...errorResponses(401, 403, 429, 503) } },
  }, async (req, reply) => {
    const admin = adminOf(req);
    if (!hub) return reply.code(503).send({ error: { code: 'live_disabled', message: 'Actualización en vivo desactivada', details: {} }, request_id: req.id });
    if (hub.countForSession(admin.sessionId) >= MAX_STREAMS_PER_SESSION) {
      return reply.code(429).send({ error: { code: 'too_many_streams', message: 'Demasiadas conexiones en vivo para esta sesión', details: {} }, request_id: req.id });
    }
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive',
                         'x-accel-buffering': 'no', 'x-request-id': req.id });
    let open = true;
    const write = (chunk: string) => { if (open) res.write(chunk); };
    const client: LiveClient = {
      role: admin.role, sessionId: admin.sessionId,
      send: (event, data) => write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
      end: () => { if (open) { open = false; res.end(); } },
    };
    write('retry: 3000\n\n');
    client.send('hello', { status: hub.status, at: new Date().toISOString(), heartbeat_ms: heartbeatMs });
    hub.add(client);
    // Latido: mantiene la conexión y comprueba que la sesión sigue vigente (cerrar sesión corta la suscripción)
    const beat = setInterval(async () => {
      const ok = (await pool.query(`SELECT 1 FROM admin_sessions WHERE id = $1 AND revoked_at IS NULL AND expires_at > now()`,
        [admin.sessionId]).catch(() => ({ rowCount: 1 }))).rowCount;
      if (!ok) { client.send('session-ended', {}); cleanup(); return; }
      write(`: latido ${new Date().toISOString()}\n\n`);
    }, heartbeatMs);
    beat.unref();
    const cleanup = () => { clearInterval(beat); hub.remove(client); client.end(); };
    req.raw.on('close', cleanup);
  });
};
