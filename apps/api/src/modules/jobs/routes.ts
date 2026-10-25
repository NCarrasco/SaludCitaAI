import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from 'typebox';
import type { Pool } from '../../db/pool.js';
import { requireServiceScope } from '../../plugins/auth.js';
import { BearerSecurity, Uuid, errorResponses } from '../../shared/schemas.js';
import type { OfferConfig } from '../offers/service.js';
import { ackJob, claimJobs, failJob, tick } from './service.js';

export const jobRoutes: FastifyPluginAsyncTypebox<{ pool: Pool; offers: OfferConfig }> = async (app, { pool, offers }) => {
  const tag = { tags: ['Interno (n8n)'], security: BearerSecurity };

  app.post('/internal/scheduler/tick', {
    preHandler: requireServiceScope('scheduler'),
    schema: { ...tag, operationId: 'schedulerTick',
      summary: 'Planificador (cada minuto): vence ofertas y emite las siguientes, recupera leases, encarga la limpieza diaria, amplía la agenda',
      description: 'Idempotente: cada paso usa bloqueos y estados persistidos; repetirlo no duplica avisos ni ofertas.',
      response: { 200: Type.Object({ expired_offers: Type.Integer(), commands_enqueued: Type.Integer(),
        calendar_jobs_without_credentials: Type.Integer(), recovered_leases: Type.Integer(), generated_slots: Type.Integer() }), ...errorResponses(401, 403) } },
  }, async () => tick(pool, offers));

  app.post('/internal/jobs/claim', {
    preHandler: requireServiceScope('calendar-sync'),
    schema: { ...tag, operationId: 'claimJobs',
      summary: 'Reclama trabajos externos con lease (p. ej., calendar.sync) y devuelve el estado deseado vigente',
      body: Type.Object({ kinds: Type.Array(Type.Union([Type.Literal('calendar.sync')]), { minItems: 1 }),
                          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, default: 5 })) }, { additionalProperties: false }),
      response: { 200: Type.Object({ items: Type.Array(Type.Object({ job_id: Uuid, kind: Type.String(), lease_token: Uuid, attempt: Type.Integer() },
        { additionalProperties: true })) }), ...errorResponses(400, 401, 403) } },
  }, async (req) => ({ items: await claimJobs(pool, req.body.kinds, req.body.limit ?? 5, offers.tz) as any }));

  app.post('/internal/jobs/:id/ack', {
    preHandler: requireServiceScope('calendar-sync'),
    schema: { ...tag, operationId: 'ackJob', summary: 'Confirma un trabajo; para calendario registra la versión aplicada (nunca retrocede)',
      params: Type.Object({ id: Uuid }),
      body: Type.Object({ lease_token: Type.String({ format: 'uuid' }), result: Type.Object({
        version: Type.Optional(Type.Integer({ minimum: 1 })), external_event_id: Type.Optional(Type.String({ maxLength: 1024 })),
        action: Type.Optional(Type.String({ maxLength: 40 })) }) }),
      response: { 200: Type.Object({ job_id: Uuid, status: Type.String() }), ...errorResponses(400, 401, 403, 404, 409) } },
  }, async (req) => ackJob(pool, req.params.id, req.body.lease_token, req.body.result));

  app.post('/internal/jobs/:id/fail', {
    preHandler: requireServiceScope('calendar-sync'),
    schema: { ...tag, operationId: 'failJob', summary: 'Informa el fallo de un trabajo: reintento con backoff exponencial y jitter; dead al agotar intentos',
      params: Type.Object({ id: Uuid }),
      body: Type.Object({ lease_token: Type.String({ format: 'uuid' }), error: Type.String({ maxLength: 2000 }) }),
      response: { 200: Type.Object({ job_id: Uuid, status: Type.String(), retry_in_seconds: Type.Union([Type.Integer(), Type.Null()]) }),
        ...errorResponses(400, 401, 403, 404, 409) } },
  }, async (req) => failJob(pool, req.params.id, req.body.lease_token, req.body.error));
};
