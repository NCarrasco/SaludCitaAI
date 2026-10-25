import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from 'typebox';
import type { Pool } from '../../db/pool.js';
import { patientOf, requirePatient, requireServiceScope } from '../../plugins/auth.js';
import { type GatewayConfig, gatewayChat, warmFallback } from './llm-gateway.js';
import { badRequest } from '../../shared/errors.js';
import { BearerSecurity, Uuid, errorResponses } from '../../shared/schemas.js';
import { type Action, ROUTES } from './engine.js';
import { type ConversationConfig, ack, claim, deliverDraft, executeRoute, fail, getUpdate, history, receive, routeUpdate } from './service.js';

const ActionSchema = Type.Union([
  Type.Object({ type: Type.Literal('menu'), item: Type.Union(['book', 'my_appointments', 'cancel', 'reschedule', 'handoff', 'help'].map((x) => Type.Literal(x))) }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal('choose_specialty'), specialty_id: Uuid }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal('choose_date'), index: Type.Integer({ minimum: 1, maximum: 10 }) }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal('select_option'), index: Type.Integer({ minimum: 1, maximum: 10 }) }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal('more_options') }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal('choose_appointment'), appointment_id: Uuid }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal('intent_result'), intent_id: Uuid }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal('discard_proposal') }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal('resume') }, { additionalProperties: false, description: 'Retomar la gestión de cita en curso tras cambiar de tema' }),
  Type.Object({ type: Type.Literal('book_with'), specialty_id: Type.Optional(Uuid), doctor_id: Type.Optional(Uuid),
    date_from: Type.Optional(Type.String({ format: 'date' })), date_to: Type.Optional(Type.String({ format: 'date' })),
    date_label: Type.Optional(Type.String({ maxLength: 80 })), time_of_day: Type.Optional(Type.Union([Type.Literal('morning'), Type.Literal('afternoon')])) },
    { additionalProperties: false }),
], { $id: 'ConversationAction', title: 'ConversationAction' });

// Respuesta del asistente: texto y elementos de interfaz. La propuesta NO contiene tokens:
// el backend de Gradio prepara y confirma la intención con la sesión del paciente.
const ReplySchema = Type.Object({
  text: Type.String(),
  mode: Type.Union([Type.Literal('ai'), Type.Literal('deterministic'), Type.Literal('fallback_menu'), Type.Literal('system')], {
    description: 'ai: intención extraída por el modelo local y ejecutada por reglas; deterministic: botón sin modelo; ' +
      'fallback_menu: el modelo falló o no estaba disponible; system: resultado de una operación leído de PostgreSQL',
  }),
  options: Type.Optional(Type.Array(Type.Object({ index: Type.Integer(), slot_id: Uuid, label: Type.String(), doctor: Type.String(),
                                                  specialty: Type.String(), starts_at: Type.String() }))),
  more_options: Type.Optional(Type.Boolean()),
  change_specialty: Type.Optional(Type.Boolean({ description: 'Reserva: mostrar «Elegir otra especialidad» junto a los horarios' })),
  date_choices: Type.Optional(Type.Array(Type.Object({ index: Type.Integer(), label: Type.String() }))),
  specialty_choices: Type.Optional(Type.Array(Type.Object({ id: Uuid, name: Type.String() }))),
  appointment_choices: Type.Optional(Type.Array(Type.Object({ appointment_id: Uuid, label: Type.String() }))),
  proposal: Type.Optional(Type.Object({
    kind: Type.Union([Type.Literal('booking'), Type.Literal('cancellation'), Type.Literal('reschedule')]),
    slot_id: Type.Optional(Uuid), appointment_id: Type.Optional(Uuid), expected_version: Type.Optional(Type.Integer()),
    new_slot_id: Type.Optional(Uuid), summary: Type.String(),
  })),
  menu: Type.Optional(Type.Boolean()),
  handoff_reference: Type.Optional(Type.String()),
  suggestions: Type.Optional(Type.Array(Type.Object({ label: Type.String(), action: Type.Ref('ConversationAction') }),
    { description: 'Acciones concretas ante intención incierta (se envían como action)' })),
  clarification: Type.Optional(Type.Boolean({ description: 'La respuesta pide aclaración; se mide aparte del éxito directo' })),
  lang: Type.Optional(Type.String({ description: 'Idioma de la conversación (es, en, pt…)' })),
  lang_fallback: Type.Optional(Type.Boolean({ description: 'Los datos de agenda se muestran en español: no hay plantillas verificadas para ese idioma' })),
  generated: Type.Optional(Type.Boolean({ description: 'Texto de conversación general generado por el modelo y validado (capa 1)' })),
  topic: Type.Optional(Type.String()),
  service_topic: Type.Optional(Type.String({ description: 'Tema institucional respondido con datos verificados (rama «informacion»)' })),
  schedule: Type.Optional(Type.Object({
    center: Type.String(), specialty: Type.Union([Type.String(), Type.Null()]),
    closed_days: Type.Array(Type.Integer({ minimum: 1, maximum: 7 }), { description: 'Días sin consulta (1 = lunes)' }),
    doctors: Type.Array(Type.Object({ specialty: Type.String(), doctor: Type.String(),
      ranges: Type.Array(Type.Object({ days: Type.Array(Type.Integer({ minimum: 1, maximum: 7 })), start: Type.String(), end: Type.String() })) })),
  }, { description: 'Horario de consulta estructurado (rama «informacion», tema horarios) para dibujarlo como tarjeta; `text` es la versión accesible' })),
}, { $id: 'AssistantReply', title: 'AssistantReply' });

const UpdateStatus = Type.Object({
  update_id: Uuid,
  status: Type.String({ description: 'pending | done | failed' }),
  attempts: Type.Optional(Type.Integer()),
  reply: Type.Union([Type.Ref('AssistantReply'), Type.Null()]),
});

export const conversationRoutes: FastifyPluginAsyncTypebox<{ pool: Pool; cfg: ConversationConfig; gateway?: GatewayConfig }> = async (app, { pool, cfg, gateway }) => {
  if (gateway?.fallback && process.env.NODE_ENV !== 'test') warmFallback(gateway); // el respaldo local queda cargado y listo
  app.addSchema(ActionSchema);
  app.addSchema(ReplySchema);

  app.post('/conversation/messages', {
    preHandler: requirePatient,
    schema: {
      operationId: 'postConversationMessage', tags: ['Conversación'], security: BearerSecurity,
      summary: 'Envía un mensaje de texto (lo interpreta la IA vía n8n) o una acción de botón (procesamiento determinista)',
      description: 'El paciente se obtiene de la sesión. client_message_id deduplica reintentos. Texto → 202 y se consulta ' +
        'GET /conversation/updates/{id}. Acción → 200 con la respuesta inmediata.',
      body: Type.Object({
        client_message_id: Type.String({ format: 'uuid' }),
        text: Type.Optional(Type.String({ minLength: 1, maxLength: 1000 })),
        action: Type.Optional(Type.Ref('ConversationAction')),
        reply_to: Type.Optional(Type.Object({
          role: Type.Union([Type.Literal('user'), Type.Literal('assistant')]),
          text: Type.String({ minLength: 1, maxLength: 500 }),
        }, { additionalProperties: false, description: 'Mensaje citado (respuesta tipo WhatsApp). Solo contexto para el modelo; no autoriza nada' })),
      }, { additionalProperties: false }),
      response: {
        200: Type.Object({ update_id: Uuid, status: Type.String(), duplicate: Type.Boolean(), reply: Type.Union([Type.Ref('AssistantReply'), Type.Null()]) }),
        202: Type.Object({ update_id: Uuid, status: Type.String(), duplicate: Type.Boolean(), reply: Type.Null() }),
        ...errorResponses(400, 401, 403, 409),
      },
    },
  }, async (req, reply) => {
    const p = patientOf(req);
    const b = req.body;
    if ((b.text === undefined) === (b.action === undefined)) throw badRequest('text_or_action', 'Envía exactamente uno: text o action');
    if (b.text !== undefined && b.text.trim() === '') throw badRequest('empty_text', 'El mensaje está vacío');
    const r = await receive(pool, cfg, { patientId: p.patientId },
      { client_message_id: b.client_message_id, text: b.text?.trim(), action: b.action as Action | undefined,
        reply_to: b.text !== undefined && b.reply_to ? { role: b.reply_to.role, text: b.reply_to.text.trim() } : undefined });
    return reply.code(b.text !== undefined ? 202 : 200).send(r as any);
  });

  app.get('/conversation/updates/:id', {
    preHandler: requirePatient,
    schema: {
      operationId: 'getConversationUpdate', tags: ['Conversación'], security: BearerSecurity,
      summary: 'Estado y respuesta de un mensaje propio (404 si es ajeno)',
      params: Type.Object({ id: Uuid }),
      response: { 200: UpdateStatus, ...errorResponses(400, 401, 403, 404) },
    },
  }, async (req) => getUpdate(pool, patientOf(req).patientId, req.params.id) as any);

  app.get('/conversation', {
    preHandler: requirePatient,
    schema: {
      operationId: 'getConversation', tags: ['Conversación'], security: BearerSecurity,
      summary: 'Historial reciente de la conversación del paciente (memoria persistente)',
      querystring: Type.Object({ limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 30 })) }),
      response: {
        200: Type.Object({
          state_step: Type.String(),
          messages: Type.Array(Type.Object({ direction: Type.String(), content: Type.String(), mode: Type.Union([Type.String(), Type.Null()]),
                                             created_at: Type.String(), reply: Type.Union([Type.Ref('AssistantReply'), Type.Null()]),
                                             reply_to: Type.Union([Type.Object({ role: Type.String(), text: Type.String() }), Type.Null()]) })),
        }),
        ...errorResponses(401, 403),
      },
    },
  }, async (req) => {
    const p = patientOf(req);
    return history(pool, { patientId: p.patientId }, req.query.limit ?? 30) as any;
  });

  // --- Endpoints internos para n8n (credencial de servicio, scope bot) ---
  const internal = { preHandler: requireServiceScope('bot') };
  const LeaseBody = { lease_token: Type.String({ format: 'uuid' }) };

  // Pasarela de modelos (solo con LLM_PROVIDER=openai): n8n envía la petición con formato de Ollama; la API la traduce,
  // añade la clave del proveedor y devuelve la respuesta con formato de Ollama. La clave nunca sale de la API.
  app.post('/internal/llm/chat', {
    ...internal,
    schema: {
      operationId: 'llmGatewayChat', tags: ['Interno (n8n)'], security: BearerSecurity,
      summary: 'Pasarela al proveedor del modelo (compatible con OpenAI) con formato de petición y respuesta de Ollama',
      body: Type.Object({ messages: Type.Array(Type.Object({ role: Type.String(), content: Type.String() })) }, { additionalProperties: true }),
    },
  }, async (req, reply) => {
    if (!gateway) return reply.code(503).send({ error: { code: 'llm_gateway_disabled', message: 'La pasarela de modelos no está configurada (LLM_PROVIDER=openai y LLM_API_KEY)' } });
    const r = await gatewayChat(gateway, req.body as never);
    if (!r.ok) return reply.code(r.status).send({ error: { code: 'llm_provider_error', message: r.error } });
    return r.body;
  });

  app.post('/internal/updates/claim', {
    ...internal,
    schema: {
      operationId: 'claimConversationUpdates', tags: ['Interno (n8n)'], security: BearerSecurity,
      summary: 'Reclama mensajes de texto pendientes con lease y devuelve la petición completa para Ollama',
      description: 'Serializa los turnos por conversación y recupera leases vencidos tras reinicios. La petición al modelo la ' +
        'construye la API (prompt versionado); n8n solo la reenvía y devuelve el resultado con /ack.',
      body: Type.Object({ update_id: Type.Optional(Uuid), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 10, default: 5 })) },
        { additionalProperties: false }),
      response: {
        200: Type.Object({ items: Type.Array(Type.Object({
          update_id: Uuid, lease_token: Uuid, prompt_version: Type.String(),
          correlation_id: Type.Optional(Uuid), mensaje_paciente: Type.Optional(Type.String()),
          responde_a: Type.Optional(Type.Union([Type.Object({ role: Type.String(), text: Type.String() }), Type.Null()])),
          llm: Type.Object({ url: Type.String(), timeout_ms: Type.Integer(), body: Type.Record(Type.String(), Type.Unknown()) }),
        })) }),
        ...errorResponses(400, 401, 403),
      },
    },
  }, async (req) => ({ items: await claim(pool, cfg, { updateId: req.body?.update_id, limit: req.body?.limit ?? 5 }) as any }));

  app.post('/internal/updates/:id/ack', {
    ...internal,
    schema: {
      operationId: 'ackConversationUpdate', tags: ['Interno (n8n)'], security: BearerSecurity,
      summary: 'Entrega el resultado del modelo (o su error); la API valida el JSON y ejecuta la máquina de estados',
      params: Type.Object({ id: Uuid }),
      body: Type.Object({
        ...LeaseBody,
        llm: Type.Object({
          ok: Type.Boolean(), content: Type.Optional(Type.String({ maxLength: 20000 })), model: Type.Optional(Type.String({ maxLength: 200 })),
          prompt_eval_count: Type.Optional(Type.Integer({ minimum: 0 })), eval_count: Type.Optional(Type.Integer({ minimum: 0 })),
          latency_ms: Type.Optional(Type.Integer({ minimum: 0 })), error: Type.Optional(Type.String({ maxLength: 2000 })),
        }),
      }),
      description: 'Si la respuesta admite redacción natural, devuelve status «drafting» con una segunda petición para Ollama ' +
        '(prompt draft-v1); n8n la ejecuta y entrega el texto en /draft. La respuesta verificada ya queda guardada.',
      response: { 200: Type.Object({ update_id: Uuid, status: Type.String({ description: 'done | drafting' }), reply: Type.Ref('AssistantReply'),
        lease_token: Type.Optional(Uuid), prompt_version: Type.Optional(Type.String()),
        decision: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: 'Resumen legible de la decisión (visible en n8n)' })),
        llm: Type.Optional(Type.Object({ url: Type.String(), timeout_ms: Type.Integer(), body: Type.Record(Type.String(), Type.Unknown()) })) }),
        ...errorResponses(400, 401, 403, 404, 409) },
    },
  }, async (req) => ack(pool, cfg, req.params.id, req.body.lease_token, req.body.llm) as any);

  const LlmBody = Type.Object({
    ok: Type.Boolean(), content: Type.Optional(Type.String({ maxLength: 20000 })), model: Type.Optional(Type.String({ maxLength: 200 })),
    prompt_eval_count: Type.Optional(Type.Integer({ minimum: 0 })), eval_count: Type.Optional(Type.Integer({ minimum: 0 })),
    latency_ms: Type.Optional(Type.Integer({ minimum: 0 })), error: Type.Optional(Type.String({ maxLength: 2000 })),
  });
  const Route = Type.Union(ROUTES.map((r) => Type.Literal(r)));

  app.post('/internal/updates/:id/route', {
    ...internal,
    schema: {
      operationId: 'routeConversationUpdate', tags: ['Interno (n8n)'], security: BearerSecurity,
      summary: 'Fase 1: valida la interpretación del modelo y decide la rama del mensaje (no ejecuta nada)',
      description: 'Devuelve `route` (conversacion, disponibilidad, aclaracion, operacion, confirmacion, mis_citas, personal, ' +
        'fallo_modelo). n8n enruta con un Switch por ese valor y llama a /branch/{route}. Repetir devuelve la misma rama.',
      params: Type.Object({ id: Uuid }),
      body: Type.Object({ ...LeaseBody, llm: LlmBody }),
      response: { 200: Type.Object({ update_id: Uuid, lease_token: Uuid, route: Type.Union([Route, Type.Null()]), status: Type.String(),
        decision: Type.Optional(Type.Record(Type.String(), Type.Unknown())) }), ...errorResponses(400, 401, 403, 404, 409) },
    },
  }, async (req) => routeUpdate(pool, cfg, req.params.id, req.body.lease_token, req.body.llm) as any);

  app.post('/internal/updates/:id/branch/:route', {
    ...internal,
    schema: {
      operationId: 'executeConversationBranch', tags: ['Interno (n8n)'], security: BearerSecurity,
      summary: 'Fase 2: ejecuta la rama decidida (409 route_mismatch si n8n pide otra)',
      description: 'Misma respuesta que /ack: «done» con la respuesta verificada o «drafting» con la petición de redacción para Ollama.',
      params: Type.Object({ id: Uuid, route: Route }),
      body: Type.Object(LeaseBody),
      response: { 200: Type.Object({ update_id: Uuid, status: Type.String({ description: 'done | drafting' }), reply: Type.Ref('AssistantReply'),
        lease_token: Type.Optional(Uuid), prompt_version: Type.Optional(Type.String()),
        decision: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
        llm: Type.Optional(Type.Object({ url: Type.String(), timeout_ms: Type.Integer(), body: Type.Record(Type.String(), Type.Unknown()) })) }),
        ...errorResponses(400, 401, 403, 404, 409) },
    },
  }, async (req) => executeRoute(pool, cfg, req.params.id, req.body.lease_token, req.params.route) as any);

  app.post('/internal/updates/:id/draft', {
    ...internal,
    schema: {
      operationId: 'draftConversationUpdate', tags: ['Interno (n8n)'], security: BearerSecurity,
      summary: 'Entrega la redacción del modelo; la API la valida (sin números, fechas, médicos ni operaciones afirmadas) y cierra el mensaje',
      params: Type.Object({ id: Uuid }),
      body: Type.Object({
        ...LeaseBody,
        llm: Type.Object({
          ok: Type.Boolean(), content: Type.Optional(Type.String({ maxLength: 20000 })), model: Type.Optional(Type.String({ maxLength: 200 })),
          prompt_eval_count: Type.Optional(Type.Integer({ minimum: 0 })), eval_count: Type.Optional(Type.Integer({ minimum: 0 })),
          latency_ms: Type.Optional(Type.Integer({ minimum: 0 })), error: Type.Optional(Type.String({ maxLength: 2000 })),
        }),
      }),
      response: { 200: Type.Object({ update_id: Uuid, status: Type.String(), reply: Type.Ref('AssistantReply'),
        validacion: Type.Optional(Type.Object({ aceptada: Type.Boolean(), motivo_rechazo: Type.Union([Type.String(), Type.Null()]), modo: Type.String() })) }),
        ...errorResponses(400, 401, 403, 404, 409) },
    },
  }, async (req) => deliverDraft(pool, req.params.id, req.body.lease_token, req.body.llm, cfg.tz) as any);

  app.post('/internal/updates/:id/fail', {
    ...internal,
    schema: {
      operationId: 'failConversationUpdate', tags: ['Interno (n8n)'], security: BearerSecurity,
      summary: 'Informa un fallo de procesamiento; reintenta con espera y, al agotar intentos, responde con el menú',
      params: Type.Object({ id: Uuid }),
      body: Type.Object({ ...LeaseBody, error: Type.String({ maxLength: 2000 }) }),
      response: { 200: Type.Object({ update_id: Uuid, status: Type.String(), reply: Type.Optional(Type.Ref('AssistantReply')) }), ...errorResponses(400, 401, 403, 404, 409) },
    },
  }, async (req) => fail(pool, cfg, req.params.id, req.body.lease_token, req.body.error) as any);
};
