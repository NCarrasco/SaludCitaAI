import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from 'typebox';
import type { Pool } from '../../db/pool.js';

export const healthRoutes: FastifyPluginAsyncTypebox<{ pool: Pool }> = async (app, { pool }) => {
  app.get('/health/live', {
    schema: { tags: ['Salud'], operationId: 'getHealthLive', security: [], summary: 'Proceso vivo', response: { 200: Type.Object({ status: Type.Literal('ok') }) } },
  }, async () => ({ status: 'ok' as const }));

  app.get('/health/ready', {
    schema: {
      tags: ['Salud'], operationId: 'getHealthReady', security: [], summary: 'Listo para atender (conexión a PostgreSQL y migraciones aplicadas)',
      response: {
        200: Type.Object({ status: Type.Literal('ready') }),
        503: Type.Object({ status: Type.Literal('unavailable') }),
      },
    },
  }, async (_req, reply) => {
    try {
      await pool.query("SELECT 1 FROM schema_migrations WHERE version = '0001'");
      return { status: 'ready' as const };
    } catch {
      return reply.code(503).send({ status: 'unavailable' as const });
    }
  });
};
