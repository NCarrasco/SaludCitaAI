import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from 'typebox';
import type { Pool } from '../../db/pool.js';
import { withTransaction } from '../../db/tx.js';
import { idempotent, requireIdempotencyKey } from '../../shared/idempotency.js';
import type { OfferConfig } from '../offers/service.js';
import { patientOf, requirePatient, requireServiceScope } from '../../plugins/auth.js';
import { BearerSecurity, Uuid, errorResponses } from '../../shared/schemas.js';
import { receiptPdf, receiptStatus, retryReceipt } from '../receipts/service.js';
import { COMMAND_KINDS, type GuestCleanupPolicy, claimCommands, confirmationStatus, executeConfirm, executeGuestCleanup, executeOfferAnswer,
  executeReceipt, executeReminder, failCommand, offerAnswerStatus, submitConfirmation, submitOfferAnswer } from './service.js';

export const commandRoutes: FastifyPluginAsyncTypebox<{ pool: Pool; tz: string; cleanup: GuestCleanupPolicy; offers: OfferConfig }> =
  async (app, { pool, tz, cleanup, offers }) => {
  const svc = { preHandler: requireServiceScope('scheduler') };
  const tag = { tags: ['Interno (n8n)'], security: BearerSecurity };
  const Lease = Type.Object({ lease_token: Type.String({ format: 'uuid' }) }, { additionalProperties: false });
  const Exec = Type.Object({ command_id: Uuid, status: Type.String(), correlation_id: Type.Union([Uuid, Type.Null()]), result: Type.Unknown() });

  app.post('/internal/commands/claim', {
    ...svc,
    schema: { ...tag, operationId: 'claimCommands',
      summary: 'Reclama comandos durables con lease (recordatorios, comprobantes PDF, limpieza de invitados)',
      description: 'Un lease vencido (n8n caído o reiniciado) se puede reclamar de nuevo; cada comando lleva su correlation_id.',
      body: Type.Object({ kinds: Type.Optional(Type.Array(Type.Union(COMMAND_KINDS.map((k) => Type.Literal(k))), { minItems: 1 })),
                          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, default: 10 })) }, { additionalProperties: false }),
      response: { 200: Type.Object({ items: Type.Array(Type.Object({ command_id: Uuid, kind: Type.String(), lease_token: Uuid, attempt: Type.Integer(),
        correlation_id: Type.Union([Uuid, Type.Null()]), aggregate_id: Type.Union([Uuid, Type.Null()]), payload: Type.Unknown() })) }), ...errorResponses(400, 401, 403) } },
  }, async (req) => ({ items: await claimCommands(pool, req.body?.kinds ?? [...COMMAND_KINDS], req.body?.limit ?? 10) as any }));

  app.post('/internal/commands/:id/confirm', {
    ...svc, schema: { ...tag, operationId: 'executeConfirmCommand',
      summary: 'Ejecuta una orden de confirmación (reserva, cancelación o reprogramación) enviada por el paciente',
      description: 'La API revalida identidad, propiedad, agenda y versión dentro de su transacción. Un rechazo de negocio ' +
        '(horario ocupado, versión cambiada, plazo vencido) se guarda como resultado y no se reintenta.',
      params: Type.Object({ id: Uuid }), body: Lease, response: { 200: Exec, ...errorResponses(400, 401, 403, 404, 409) } },
  }, async (req) => executeConfirm(pool, req.params.id, req.body.lease_token, tz, offers) as any);

  app.post('/internal/commands/:id/offer-answer', {
    ...svc, schema: { ...tag, operationId: 'executeOfferAnswerCommand',
      summary: 'Ejecuta la respuesta del paciente a un adelanto (aceptar mueve la cita y abre la cascada; rechazar pasa al siguiente)',
      description: 'El plazo de la oferta se evalúa en el momento en que el paciente respondió. Un rechazo de negocio es un resultado.',
      params: Type.Object({ id: Uuid }), body: Lease, response: { 200: Exec, ...errorResponses(400, 401, 403, 404, 409) } },
  }, async (req) => executeOfferAnswer(pool, req.params.id, req.body.lease_token, offers) as any);

  app.post('/internal/commands/:id/reminder', {
    ...svc, schema: { ...tag, operationId: 'executeReminderCommand', summary: 'Ejecuta un recordatorio: publica el aviso si la cita sigue vigente',
      params: Type.Object({ id: Uuid }), body: Lease, response: { 200: Exec, ...errorResponses(400, 401, 403, 404, 409) } },
  }, async (req) => executeReminder(pool, req.params.id, req.body.lease_token, tz) as any);

  app.post('/internal/commands/:id/receipt', {
    ...svc, schema: { ...tag, operationId: 'executeReceiptCommand', summary: 'Genera el comprobante PDF de la versión de la cita (datos verificados)',
      params: Type.Object({ id: Uuid }), body: Lease, response: { 200: Exec, ...errorResponses(400, 401, 403, 404, 409) } },
  }, async (req) => executeReceipt(pool, req.params.id, req.body.lease_token, tz) as any);

  app.post('/internal/commands/:id/guest-cleanup', {
    ...svc, schema: { ...tag, operationId: 'executeGuestCleanupCommand',
      summary: 'Limpieza de sesiones invitadas (nunca borra citas, historial ni impide recuperar el acceso)',
      params: Type.Object({ id: Uuid }), body: Lease, response: { 200: Exec, ...errorResponses(400, 401, 403, 404, 409) } },
  }, async (req) => executeGuestCleanup(pool, req.params.id, req.body.lease_token, cleanup) as any);

  app.post('/internal/commands/:id/fail', {
    ...svc, schema: { ...tag, operationId: 'failCommand', summary: 'Fallo de un comando: reintento con backoff; dead al agotar intentos',
      params: Type.Object({ id: Uuid }), body: Type.Object({ lease_token: Type.String({ format: 'uuid' }), error: Type.String({ maxLength: 2000 }) }, { additionalProperties: false }),
      response: { 200: Type.Object({ command_id: Uuid, status: Type.String(), retry_in_seconds: Type.Union([Type.Integer(), Type.Null()]) }), ...errorResponses(400, 401, 403, 404, 409) } },
  }, async (req) => failCommand(pool, req.params.id, req.body.lease_token, req.body.error));

  // --- Confirmación orquestada por n8n: el paciente envía la orden y consulta su resultado ---
  const itag = { tags: ['Intenciones y confirmación'], security: BearerSecurity };
  const Order = Type.Object({ status: Type.String(), intent_id: Uuid, command_id: Uuid, correlation_id: Uuid });
  app.post('/action-intents/:id/submit', {
    preHandler: requirePatient,
    schema: { ...itag, operationId: 'submitActionIntent',
      summary: 'Envía la confirmación a n8n: registra la orden como comando durable (no modifica la agenda todavía)',
      description: 'Requiere Idempotency-Key. Devuelve 202 con command_id y correlation_id; el resultado se consulta en ' +
        'GET /action-intents/:id/confirmation. Si n8n no la ejecuta en 120 s, se descarta sin cambios.',
      params: Type.Object({ id: Uuid }),
      headers: Type.Object({ 'idempotency-key': Type.String({ minLength: 8, maxLength: 200 }) }),
      body: Type.Object({ token: Type.String({ minLength: 10, maxLength: 200 }) }, { additionalProperties: false }),
      response: { 202: Order, ...errorResponses(400, 401, 403, 404, 409, 410) } },
  }, async (req, reply) => {
    const p = patientOf(req);
    const key = requireIdempotencyKey(req.headers['idempotency-key']);
    const res = await withTransaction(pool, (c) => idempotent(c, {
      principalId: p.id, route: 'POST /action-intents/:id/submit', key, request: { id: req.params.id, body: req.body },
    }, async () => ({ status: 202, body: await submitConfirmation(c, p.patientId, req.params.id, req.body.token) })));
    reply.header('idempotent-replayed', String(res.replayed));
    if (res.status >= 400) return reply.code(res.status as 202).send({ ...(res.body as object), request_id: req.id } as any);
    return reply.code(202).send(res.body as any);
  });

  app.get('/action-intents/:id/confirmation', {
    preHandler: requirePatient,
    schema: { ...itag, operationId: 'getConfirmationStatus',
      summary: 'Resultado de una confirmación enviada: queued · running · confirmed · failed · expired',
      params: Type.Object({ id: Uuid }),
      response: { 200: Type.Object({ status: Type.String(), intent_id: Uuid, command_id: Uuid, correlation_id: Uuid, attempts: Type.Integer(),
        result: Type.Optional(Type.Unknown({ description: 'ConfirmResult (igual que POST /action-intents/:id/confirm)' })),
        error: Type.Optional(Type.Object({ code: Type.String(), status: Type.Integer(), message: Type.String() })) }),
        ...errorResponses(400, 401, 403, 404, 409) } },
  }, async (req) => confirmationStatus(pool, patientOf(req).patientId, req.params.id) as any);

  const otag = { tags: ['Ofertas de adelanto'], security: BearerSecurity };
  app.post('/offers/:id/answer', {
    preHandler: requirePatient,
    schema: { ...otag, operationId: 'submitOfferAnswer',
      summary: 'Envía a n8n la respuesta a un adelanto (aceptar o rechazar) como comando durable',
      description: 'Requiere Idempotency-Key. 202 con command_id y correlation_id; el resultado se consulta en GET /offers/:id/answer.',
      params: Type.Object({ id: Uuid }),
      headers: Type.Object({ 'idempotency-key': Type.String({ minLength: 8, maxLength: 200 }) }),
      body: Type.Object({ action: Type.Union([Type.Literal('accept'), Type.Literal('reject')]) }, { additionalProperties: false }),
      response: { 202: Type.Object({ status: Type.String(), offer_id: Uuid, action: Type.String(), command_id: Uuid, correlation_id: Uuid }),
        ...errorResponses(400, 401, 403, 404, 409, 410) } },
  }, async (req, reply) => {
    const p = patientOf(req);
    const key = requireIdempotencyKey(req.headers['idempotency-key']);
    const res = await withTransaction(pool, (c) => idempotent(c, {
      principalId: p.id, route: 'POST /offers/:id/answer', key, request: { id: req.params.id, body: req.body },
    }, async () => {
      // Un rechazo (oferta vencida o cerrada) se devuelve sin deshacer la transacción: el vencimiento queda materializado
      const r = await submitOfferAnswer(c, p.patientId, req.params.id, req.body.action, offers);
      return r.ok ? { status: 202, body: r.body } : { status: r.status, body: { error: { code: r.code, message: r.message, details: {} } } };
    }));
    reply.header('idempotent-replayed', String(res.replayed));
    if (res.status >= 400) return reply.code(res.status as 202).send({ ...(res.body as object), request_id: req.id } as any);
    return reply.code(202).send(res.body as any);
  });

  app.get('/offers/:id/answer', {
    preHandler: requirePatient,
    schema: { ...otag, operationId: 'getOfferAnswerStatus', summary: 'Resultado de la respuesta enviada: queued · running · done · failed · expired',
      params: Type.Object({ id: Uuid }),
      response: { 200: Type.Object({ status: Type.String(), offer_id: Uuid, action: Type.String(), command_id: Uuid, correlation_id: Uuid,
        attempts: Type.Integer(), result: Type.Optional(Type.Unknown()),
        error: Type.Optional(Type.Object({ code: Type.String(), status: Type.Integer(), message: Type.String() })) }),
        ...errorResponses(400, 401, 403, 404, 409) } },
  }, async (req) => offerAnswerStatus(pool, patientOf(req).patientId, req.params.id) as any);

  // --- Comprobantes: solo el dueño de la cita, con su sesión ---
  const ptag = { tags: ['Comprobantes'], security: BearerSecurity };
  app.get('/appointments/:id/receipt', {
    preHandler: requirePatient,
    schema: { ...ptag, operationId: 'getReceiptStatus', summary: 'Estado del comprobante de la versión vigente de una cita propia',
      params: Type.Object({ id: Uuid }),
      response: { 200: Type.Object({ appointment_status: Type.String(), version: Type.Integer(), receipt_number: Type.Union([Type.Integer(), Type.Null()]),
        status: Type.Union([Type.String(), Type.Null()]), sha256: Type.Union([Type.String(), Type.Null()]), size_bytes: Type.Union([Type.Integer(), Type.Null()]) }),
        ...errorResponses(400, 401, 403, 404) } },
  }, async (req) => receiptStatus(pool, patientOf(req).patientId, req.params.id) as any);

  app.get('/appointments/:id/receipt.pdf', {
    preHandler: requirePatient,
    schema: { ...ptag, operationId: 'downloadReceipt', summary: 'Descarga el PDF del comprobante vigente (404 si la cita no es tuya; 409 si aún no está listo)',
      params: Type.Object({ id: Uuid }), response: { ...errorResponses(400, 401, 403, 404, 409) } },
  }, async (req, reply) => {
    const r = await receiptPdf(pool, patientOf(req).patientId, req.params.id);
    return reply.header('content-type', 'application/pdf').header('content-disposition', `attachment; filename="${r.filename}"`)
      .header('cache-control', 'private, no-store').send(r.pdf);
  });

  app.post('/appointments/:id/receipt/retry', {
    preHandler: requirePatient,
    schema: { ...ptag, operationId: 'retryReceipt', summary: 'Reintenta generar el comprobante si falló (la cita sigue confirmada)',
      params: Type.Object({ id: Uuid }), response: { 200: Type.Object({ status: Type.String() }), ...errorResponses(400, 401, 403, 404, 409) } },
  }, async (req) => retryReceipt(pool, patientOf(req).patientId, req.params.id));
};
