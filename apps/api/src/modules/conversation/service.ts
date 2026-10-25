import { currentTimeVariants, localClock } from './clock.js';
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from '../../db/pool.js';
import { withTransaction } from '../../db/tx.js';
import { ApiError, conflict, notFound } from '../../shared/errors.js';
import { type Action, type ConvState, type EngineEvent, INITIAL_STATE, type Reply, type RouteName, routeOf, specialtyNames, step } from './engine.js';
import { CONVERSE_PROMPT_VERSION, type ConverseMode, buildConverseRequest, validateConverse, validateGrounded } from './converse.js';
import { resolveLanguage } from './lang.js';
import { localizeReply } from './localize.js';
import { serviceGuide } from './service-guide.js';
import { type Intent, PROMPT_VERSION, buildOllamaRequest, parseInterpretation } from './llm.js';

export interface ConversationConfig {
  tz: string;
  ollamaUrl: string;
  ollamaModel: string;
  ollamaThink?: boolean;
  llmTimeoutMs: number;
  leaseSeconds: number;
  n8nWebhookUrl?: string;
  n8nWebhookSecret?: string;
  /** Capa 1: segunda llamada al modelo para la conversación general (orquestada por n8n). */
  converseEnabled?: boolean;
  /** Proveedor del modelo: con «openai», n8n llama a la pasarela de la API (que añade la clave) en vez de a Ollama */
  llmProvider?: 'ollama' | 'openai';
  internalApiUrl?: string;
}

/** A dónde envía n8n la petición al modelo: Ollama directo o la pasarela de la API (proveedor compatible con OpenAI). */
export function llmUrl(cfg: ConversationConfig): string {
  return cfg.llmProvider === 'openai' ? `${(cfg.internalApiUrl ?? 'http://api:8080/api/v1').replace(/\/$/, '')}/internal/llm/chat`
    : `${cfg.ollamaUrl.replace(/\/$/, '')}/api/chat`;
}

export interface Quoted { role: 'user' | 'assistant'; text: string }

/** Defensa en profundidad: un código de recuperación nunca se guarda en el historial ni viaja a n8n o al modelo. */
const RECOVERY_CODE_RE = /\bSCR[\s-]*(?:[A-Z0-9]{5}[\s-]*){4}[A-Z0-9]{5}\b/gi;
export function redactSecrets(text: string): string {
  return text.replace(RECOVERY_CODE_RE, '[código de recuperación oculto]');
}

// Contexto reciente que recibe el modelo para seguir el hilo (mensajes del paciente y de Salu)
const HISTORY_TURNS = 10;

/** Identidad de canal y conversación del paciente autenticado (canal gradio ↔ cuenta). */
async function ensureConversation(c: PoolClient, patientId: string): Promise<string> {
  // La conversación pertenece al paciente (no al dispositivo): sigue disponible tras recuperar el acceso en otro equipo
  const ci = await c.query(
    `INSERT INTO channel_identities (patient_id, channel, external_user_id) VALUES ($1, 'gradio', $2)
     ON CONFLICT (channel, external_user_id) DO UPDATE SET external_user_id = EXCLUDED.external_user_id
     RETURNING id, patient_id`, [patientId, `p:${patientId}`]);
  if (ci.rows[0].patient_id !== patientId) throw new ApiError(403, 'forbidden', 'Identidad de canal inconsistente');
  const conv = await c.query(
    `INSERT INTO conversations (channel_identity_id) VALUES ($1)
     ON CONFLICT (channel_identity_id) DO UPDATE SET channel_identity_id = EXCLUDED.channel_identity_id RETURNING id`,
    [ci.rows[0].id]);
  return conv.rows[0].id;
}

function actionLabel(a: Action): string {
  switch (a.type) {
    case 'menu': return `[Menú: ${a.item}]`;
    case 'choose_specialty': return '[Eligió especialidad]';
    case 'choose_date': return `[Eligió fecha ${a.index}]`;
    case 'select_option': return `[Eligió opción ${a.index}]`;
    case 'more_options': return '[Ver más horarios]';
    case 'choose_appointment': return '[Eligió cita]';
    case 'intent_result': return '[Resultado de confirmación]';
    case 'discard_proposal': return '[Descartó]';
    case 'book_with': return '[Eligió reservar]';
    case 'resume': return '[Continuar con mi cita]';
  }
}

async function runEngine(c: PoolClient, cfg: ConversationConfig, conv: { id: string; state: ConvState; version: number },
                         patientId: string, updateId: string, ev: EngineEvent,
                         meta: { model?: string; promptTokens?: number; completionTokens?: number; latencyMs?: number; intent?: string } = {},
                         route?: RouteName) {
  // Idioma: se resuelve con el texto del paciente (petición explícita > detección > idioma actual); los botones lo conservan
  const lang = ev.type === 'action' ? { lang: conv.state.lang ?? 'es', locked: Boolean(conv.state.lang_locked) }
    : resolveLanguage(conv.state, ev.text);
  const [rawNext, rawReply] = await step({ c, patientId, conversationId: conv.id, updateId, tz: cfg.tz, now: new Date() },
    { ...conv.state, lang: lang.lang, lang_locked: lang.locked }, ev, route);
  const next: ConvState = { ...rawNext, lang: lang.lang, lang_locked: lang.locked,
    chat_streak: rawReply.converse === 'reply' ? rawNext.chat_streak : 0 };
  // Respuesta verificada en el idioma de la conversación (plantillas deterministas; el modelo no traduce datos)
  const reply = localizeReply(rawReply, lang.lang);
  await c.query(
    `UPDATE conversations SET state = $2, version = version + 1, lease_until = NULL, lease_token = NULL,
            summary = $3 WHERE id = $1`,
    [conv.id, JSON.stringify(next), summarize(next)]);
  await c.query(
    `INSERT INTO messages (conversation_id, update_id, direction, content, intent, model, prompt_tokens, completion_tokens,
                           latency_ms, mode, payload)
     VALUES ($1, $2, 'outbound', $3, $4, $5, $6, $7, $8, $9, $10)`,
    [conv.id, updateId, reply.text, meta.intent ?? null, meta.model ?? null, meta.promptTokens ?? null,
     meta.completionTokens ?? null, meta.latencyMs ?? null, reply.mode, JSON.stringify(reply)]);
  return reply;
}

/** Resumen estructurado y determinista del estado (no lo genera el modelo). */
function summarize(s: ConvState): string {
  const parts = [`paso=${s.step}`];
  if (s.flow) parts.push(`flujo=${s.flow}`);
  if (s.range) parts.push(`fechas=${s.range.label}`);
  if (s.options?.length) parts.push(`opciones=${s.options.length}`);
  if (s.proposal) parts.push(`propuesta=${s.proposal.kind}`);
  return parts.join('; ');
}

// ---------------------------------------------------------------------------
// Entrada desde Gradio (paciente autenticado)
// ---------------------------------------------------------------------------

export async function receive(pool: Pool, cfg: ConversationConfig, p: { patientId: string },
                              body: { client_message_id: string; text?: string; action?: Action; reply_to?: Quoted }) {
  if (body.text !== undefined) body = { ...body, text: redactSecrets(body.text) };
  if (body.reply_to) body = { ...body, reply_to: { ...body.reply_to, text: redactSecrets(body.reply_to.text) } };
  if (body.text !== undefined) {
    const res = await withTransaction(pool, async (c) => {
      const convId = await ensureConversation(c, p.patientId);
      const ins = await c.query(
        `INSERT INTO inbound_updates (channel, external_update_id, patient_id, conversation_id, payload, kind)
         VALUES ('gradio', $1, $2, $3, $4, 'text') ON CONFLICT (channel, external_update_id) DO NOTHING
         RETURNING id, status`, [body.client_message_id, p.patientId, convId,
          JSON.stringify({ text: body.text, ...(body.reply_to ? { reply_to: body.reply_to } : {}) })]);
      if (!ins.rows[0]) {
        // Mensaje duplicado (reintento del cliente): devuelve la actualización original si es del mismo paciente
        const prev = await c.query(`SELECT id, status, patient_id FROM inbound_updates WHERE channel = 'gradio' AND external_update_id = $1`,
          [body.client_message_id]);
        if (prev.rows[0]?.patient_id !== p.patientId) throw conflict('client_message_id_reused', 'Identificador de mensaje ya usado');
        return { update_id: prev.rows[0].id as string, status: prev.rows[0].status as string, duplicate: true };
      }
      await c.query(`INSERT INTO messages (conversation_id, update_id, direction, content, payload) VALUES ($1, $2, 'inbound', $3, $4)`,
        [convId, ins.rows[0].id, body.text, body.reply_to ? JSON.stringify({ reply_to: body.reply_to }) : null]);
      return { update_id: ins.rows[0].id as string, status: 'received', duplicate: false };
    });
    if (!res.duplicate) void wakeN8n(cfg, res.update_id);
    return { ...res, reply: null };
  }

  // Acción de botón: procesamiento determinista inmediato en la API, sin modelo
  const action = body.action!;
  return withTransaction(pool, async (c) => {
    const convId = await ensureConversation(c, p.patientId);
    const conv = (await c.query(`SELECT id, state, version, lease_until > now() AS leased FROM conversations WHERE id = $1 FOR UPDATE`,
      [convId])).rows[0];
    const ins = await c.query(
      `INSERT INTO inbound_updates (channel, external_update_id, patient_id, conversation_id, payload, kind, status, processed_by)
       VALUES ('gradio', $1, $2, $3, $4, 'action', 'processing', 'api') ON CONFLICT (channel, external_update_id) DO NOTHING
       RETURNING id`, [body.client_message_id, p.patientId, convId, JSON.stringify({ action })]);
    if (!ins.rows[0]) {
      const prev = (await c.query(`SELECT id, status, result, patient_id FROM inbound_updates WHERE channel = 'gradio' AND external_update_id = $1`,
        [body.client_message_id])).rows[0];
      if (prev?.patient_id !== p.patientId) throw conflict('client_message_id_reused', 'Identificador de mensaje ya usado');
      return { update_id: prev.id as string, status: prev.status as string, duplicate: true, reply: prev.result as Reply | null };
    }
    if (conv.leased) throw conflict('conversation_busy', 'El asistente todavía está procesando tu mensaje anterior');
    const updateId = ins.rows[0].id as string;
    await c.query(`INSERT INTO messages (conversation_id, update_id, direction, content, intent) VALUES ($1, $2, 'inbound', $3, $4)`,
      [convId, updateId, actionLabel(action), `action:${action.type}`]);
    const reply = await runEngine(c, cfg, { id: convId, state: { ...INITIAL_STATE, ...conv.state }, version: conv.version },
      p.patientId, updateId, { type: 'action', action });
    await c.query(`UPDATE inbound_updates SET status = 'done', result = $2 WHERE id = $1`, [updateId, JSON.stringify(reply)]);
    return { update_id: updateId, status: 'done', duplicate: false, reply };
  });
}

/** Aviso a n8n para procesar en cuanto llega el mensaje. Si falla, el disparador programado lo recupera. */
async function wakeN8n(cfg: ConversationConfig, updateId: string) {
  if (!cfg.n8nWebhookUrl || !cfg.n8nWebhookSecret) return;
  try {
    await fetch(cfg.n8nWebhookUrl, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-saludcita-webhook-secret': cfg.n8nWebhookSecret },
      body: JSON.stringify({ update_id: updateId }), signal: AbortSignal.timeout(15000),   // margen si n8n tarda en atender
    });
  } catch { /* n8n no disponible: la actualización queda en 'received' y la recoge el disparador cada minuto */ }
}

export async function getUpdate(pool: Pool, patientId: string, id: string) {
  const r = await pool.query(
    `SELECT id, status, kind, result, attempts, created_at FROM inbound_updates WHERE id = $1 AND patient_id = $2`, [id, patientId]);
  const u = r.rows[0];
  if (!u) throw notFound('Mensaje');
  const pending = u.status === 'received' || u.status === 'processing';
  return { update_id: u.id, status: pending ? 'pending' : u.status === 'done' || u.status === 'dead' ? 'done' : u.status,
           attempts: u.attempts, reply: pending ? null : u.result };
}

export async function history(pool: Pool, p: { patientId: string }, limit: number) {
  const r = await pool.query(
    `SELECT m.direction, m.content, m.mode, m.payload, m.created_at, cv.state
     FROM conversations cv JOIN channel_identities ci ON ci.id = cv.channel_identity_id
     JOIN messages m ON m.conversation_id = cv.id
     WHERE ci.channel = 'gradio' AND ci.external_user_id = $1 AND ci.patient_id = $2
     ORDER BY m.created_at DESC, m.id DESC LIMIT $3`, [`p:${p.patientId}`, p.patientId, limit]);
  const state = r.rows[0]?.state ?? INITIAL_STATE;
  return {
    state_step: ({ ...INITIAL_STATE, ...(state as ConvState) }).step,
    messages: r.rows.reverse().map((m) => ({
      direction: m.direction, content: m.content, mode: m.mode, created_at: (m.created_at as Date).toISOString(),
      reply: m.direction === 'outbound' ? m.payload : null,
      reply_to: m.direction === 'inbound' ? (m.payload?.reply_to ?? null) : null,
    })),
  };
}

// ---------------------------------------------------------------------------
// Procesamiento por n8n (credencial de servicio con scope bot)
// ---------------------------------------------------------------------------

/**
 * Reclama hasta `limit` actualizaciones de texto. Serializa por conversación: no reclama si la
 * conversación tiene un lease vigente o una actualización anterior pendiente. Recupera leases vencidos.
 */
export async function claim(pool: Pool, cfg: ConversationConfig, opts: { updateId?: string; limit: number }) {
  return withTransaction(pool, async (c) => {
    // Redacciones abandonadas (n8n caído tras la interpretación): se cierran con el texto determinista ya guardado,
    // sin volver a interpretar ni ejecutar la máquina de estados
    await c.query(`UPDATE inbound_updates SET status = 'done', done_at = now(), lease_until = NULL, last_error = 'redacción no recibida a tiempo'
                   WHERE kind = 'text' AND status = 'processing' AND lease_until < now() AND result IS NOT NULL`);
    const rows = (await c.query(
      `SELECT u.id, u.conversation_id, u.patient_id, u.payload
       FROM inbound_updates u JOIN conversations cv ON cv.id = u.conversation_id
       WHERE u.kind = 'text' AND u.available_at <= now()
         AND (u.status = 'received' OR (u.status = 'processing' AND u.lease_until < now() AND u.result IS NULL))
         AND ($1::uuid IS NULL OR u.id = $1)
         AND (cv.lease_until IS NULL OR cv.lease_until < now())
         AND NOT EXISTS (SELECT 1 FROM inbound_updates p WHERE p.conversation_id = u.conversation_id
                         AND p.created_at < u.created_at AND p.status IN ('received','processing'))
       ORDER BY u.created_at
       LIMIT $2
       FOR UPDATE OF u, cv SKIP LOCKED`, [opts.updateId ?? null, opts.limit])).rows;
    const out = [];
    const names = await specialtyNames(c);
    for (const u of rows) {
      const lease = randomUUID();
      await c.query(`UPDATE inbound_updates SET status = 'processing', attempts = attempts + 1, processed_by = 'n8n', claimed_at = now(),
                       lease_token = $2, lease_until = now() + make_interval(secs => $3) WHERE id = $1`, [u.id, lease, cfg.leaseSeconds]);
      await c.query(`UPDATE conversations SET lease_token = $2, lease_until = now() + make_interval(secs => $3) WHERE id = $1`,
        [u.conversation_id, lease, cfg.leaseSeconds]);
      const conv = (await c.query(`SELECT state FROM conversations WHERE id = $1`, [u.conversation_id])).rows[0];
      const state: ConvState = { ...INITIAL_STATE, ...conv.state };
      const hist = (await c.query(
        `SELECT direction, content FROM messages WHERE conversation_id = $1 AND update_id IS DISTINCT FROM $2
           AND (direction = 'outbound' OR intent IS NULL OR intent NOT LIKE 'action:%')
         ORDER BY created_at DESC, id DESC LIMIT $3`, [u.conversation_id, u.id, HISTORY_TURNS])).rows.reverse();
      const body = buildOllamaRequest(cfg.ollamaModel, u.payload.text, {
        step: state.step, optionsOffered: state.step === 'choosing_slot' ? state.options?.length ?? 0 : state.date_choices?.length ?? 0,
        specialties: names,
        // Con un modelo grande (proveedor en la nube) se envía siempre el contexto reciente para entender continuaciones
        // («¿y si mejor el domingo?»). Con el modelo local pequeño, en reposo no: confunde turnos anteriores con el actual
        history: state.step === 'idle' && cfg.llmProvider !== 'openai' ? [] : hist.map((h) => ({ role: h.direction === 'inbound' ? 'user' as const : 'assistant' as const,
                                                                   content: String(h.content).slice(0, 500) })),
        quoted: u.payload.reply_to ?? null,
      }, { think: cfg.ollamaThink });
      out.push({ update_id: u.id, correlation_id: u.id, mensaje_paciente: u.payload.text, responde_a: u.payload.reply_to ?? null,
                 lease_token: lease, prompt_version: PROMPT_VERSION,
                 llm: { url: llmUrl(cfg), timeout_ms: cfg.llmTimeoutMs, body } });
    }
    return out;
  });
}

async function lockLeased(c: PoolClient, id: string, lease: string) {
  const u = (await c.query(
    `SELECT id, conversation_id, patient_id, payload, status, lease_token, result, attempts, max_attempts
     FROM inbound_updates WHERE id = $1 AND kind = 'text' FOR UPDATE`, [id])).rows[0];
  if (!u) throw notFound('Actualización');
  if (u.status === 'done' && u.lease_token === lease) return { u, done: true };
  if (u.status === 'processing' && u.lease_token === lease && u.result?.draft_pending) return { u, done: false, drafting: true };
  if (u.status !== 'processing' || u.lease_token !== lease) {
    throw conflict('lease_lost', 'El lease de esta actualización ya no es válido');
  }
  const conv = (await c.query(`SELECT id, state, version FROM conversations WHERE id = $1 FOR UPDATE`, [u.conversation_id])).rows[0];
  return { u, conv, done: false as const };
}

export interface LlmOutcome {
  ok: boolean;
  content?: string;     // message.content devuelto por Ollama
  model?: string;
  prompt_eval_count?: number;
  eval_count?: number;
  latency_ms?: number;
  error?: string;
}

function eventFrom(text: string, llm: LlmOutcome) {
  const parsed = llm.ok ? parseInterpretation(llm.content) : { ok: false as const, error: llm.error ?? 'error del modelo' };
  const ev: EngineEvent = parsed.ok
    ? { type: 'interpretation', text, interp: parsed.value }
    : { type: 'llm_failed', text, error: parsed.error };
  return { parsed, ev };
}

/** Estado con el que se decide y se ejecuta (el mismo en las dos fases: la conversación sigue bloqueada por el lease). */
function stateFor(conv: { state: ConvState }, text: string): ConvState {
  const st = { ...INITIAL_STATE, ...conv.state };
  const lang = resolveLanguage(st, text);
  return { ...st, lang: lang.lang, lang_locked: lang.locked };
}

/**
 * Fase 1 (n8n «5 · validar la interpretación»): valida el JSON del modelo, lo concilia con el texto y el estado y DECIDE
 * la rama. No ejecuta nada: guarda la interpretación validada y la rama; n8n enruta con un Switch y llama a la rama.
 */
export async function routeUpdate(pool: Pool, cfg: ConversationConfig, id: string, lease: string, llm: LlmOutcome) {
  return withTransaction(pool, async (c) => {
    const locked = await lockLeased(c, id, lease);
    const { u } = locked;
    const stored = u.result?.routing as { route: RouteName } | undefined;
    if (locked.done) return { update_id: id, lease_token: lease, route: stored?.route ?? null, status: 'done' };
    if (stored) return { update_id: id, lease_token: lease, route: stored.route, status: 'routed', decision: u.result.routing.decision };
    const { parsed, ev } = eventFrom(u.payload.text, llm);
    const route = routeOf(ev, stateFor(locked.conv!, u.payload.text));
    const decision = {
      rama: route, modelo_valido: parsed.ok, error_modelo: parsed.ok ? null : parsed.error,
      intencion: parsed.ok ? parsed.value.intent : null,
      datos_extraidos: parsed.ok ? Object.fromEntries(Object.entries(parsed.value).filter(([k, v]) => k !== 'intent' && v !== null)) : {},
      paso_actual: locked.conv!.state?.step ?? 'idle',
    };
    const routing = { route, llm, decision };
    await c.query(`UPDATE inbound_updates SET result = $2, lease_until = now() + make_interval(secs => $3) WHERE id = $1`,
      [id, JSON.stringify({ routing }), cfg.leaseSeconds]);
    return { update_id: id, lease_token: lease, route, status: 'routed', decision };
  });
}

/** Fase 2 (rama del Switch): ejecuta la rama decidida. Si n8n pide otra rama distinta → 409 route_mismatch. */
export async function executeRoute(pool: Pool, cfg: ConversationConfig, id: string, lease: string, route: RouteName) {
  return withTransaction(pool, async (c) => {
    const locked = await lockLeased(c, id, lease);
    const { u, done } = locked;
    if (done) return { update_id: id, status: 'done', reply: stripInternal(u.result) };
    if ('drafting' in locked && locked.drafting) return draftingResponse(c, cfg, u, lease);
    const routing = u.result?.routing as { route: RouteName; llm: LlmOutcome } | undefined;
    if (!routing) throw conflict('not_routed', 'Este mensaje aún no tiene una rama decidida');
    if (routing.route !== route) throw conflict('route_mismatch', 'La rama pedida no corresponde a la decisión de la API para este mensaje');
    return processMessage(c, cfg, id, lease, locked.u, locked.conv!, routing.llm, route);
  });
}

/** Compatibilidad: decidir y ejecutar en un solo paso (sin Switch en n8n). */
export async function ack(pool: Pool, cfg: ConversationConfig, id: string, lease: string, llm: LlmOutcome) {
  return withTransaction(pool, async (c) => {
    const locked = await lockLeased(c, id, lease);
    const { u, done } = locked;
    if (done) return { update_id: id, status: 'done', reply: u.result as Reply };
    // Reintento del mismo ack durante la redacción: se devuelve la misma petición de redacción
    if ('drafting' in locked && locked.drafting) return draftingResponse(c, cfg, u, lease);
    return processMessage(c, cfg, id, lease, u, locked.conv!, llm);
  });
}

async function processMessage(c: PoolClient, cfg: ConversationConfig, id: string, lease: string, u: any,
                              conv: { id: string; state: ConvState; version: number }, llm: LlmOutcome, route?: RouteName) {
  {
    const { parsed, ev } = eventFrom(u.payload.text, llm);
    const t0 = performance.now();
    const reply = await runEngine(c, cfg, { id: conv.id, state: { ...INITIAL_STATE, ...conv.state }, version: conv.version },
      u.patient_id, id, ev, {
        model: llm.model ?? cfg.ollamaModel, promptTokens: llm.prompt_eval_count, completionTokens: llm.eval_count,
        latencyMs: llm.latency_ms, intent: parsed.ok ? parsed.value.intent : `llm_error`,
      }, route);
    // Tiempos por etapa (para medir latencia): interpretación del modelo (n8n→Ollama) y decisión de la API
    const timing = { interpretation_ms: llm.latency_ms ?? null, decision_ms: Math.round(performance.now() - t0) };
    // Todo mensaje ESCRITO que el modelo entendió se responde con texto redactado por el modelo: si el motor no pidió
    // charla o empatía, la redacción es «grounded» sobre lo que el sistema decidió y consultó (datos, opciones, propuesta).
    // Los botones y la propuesta siguen siendo los del sistema; la redacción se valida y, si no pasa, se usa el texto verificado.
    if (cfg.converseEnabled !== false && parsed.ok && !reply.converse && !reply.no_draft && reply.text) {
      reply.converse = 'grounded';
      reply.facts = groundingFacts(reply);
    }
    const base = { ...reply, interpretation: parsed.ok ? parsed.value : null, prompt_version: PROMPT_VERSION, timing, ...(route ? { route } : {}) };
    // Capa 1: conversación generada por el modelo (charla, empatía o redacción sobre datos verificados)
    const mode: ConverseMode | null = cfg.converseEnabled !== false && parsed.ok && reply.converse ? reply.converse : null;
    const decision = await decisionOf(c, conv.id, parsed.ok ? parsed.value : null, reply, mode, parsed.ok ? undefined : parsed.error);
    if (mode) {
      // La respuesta verificada queda guardada; el mensaje sigue «pendiente» para el paciente hasta recibir la redacción
      await c.query(`UPDATE inbound_updates SET result = $2, last_error = NULL,
                       lease_until = now() + make_interval(secs => $3) WHERE id = $1`,
        [id, JSON.stringify({ ...base, draft_pending: true, draft_mode: mode }), cfg.leaseSeconds]);
      u.result = { ...base, draft_pending: true, draft_mode: mode };
      return { ...(await draftingResponse(c, cfg, u, lease)), decision };
    }
    await c.query(`UPDATE inbound_updates SET status = 'done', done_at = now(), result = $2, last_error = $3, lease_until = NULL WHERE id = $1`,
      [id, JSON.stringify(base), parsed.ok ? null : parsed.error]);
    return { update_id: id, status: 'done', reply, decision };
  }
}

/** Resumen legible de lo que decidió la API (se ve en la ejecución de n8n). Sin datos de otros pacientes. */
/** Lo que el modelo debe comunicar, con todos los datos que puede citar (opciones, citas, propuesta, botones). */
function groundingFacts(r: Reply): string {
  const out = [`Mensaje del sistema que debes comunicar con tus palabras (conserva su sentido, preguntas e instrucciones):\n${r.text}`];
  if (r.options?.length) out.push(`Horarios ofrecidos (el paciente elige con los botones numerados):\n${r.options.map((o) => `${o.index}) ${o.label}`).join('\n')}`);
  if (r.date_choices?.length) out.push(`Fechas para elegir (botones):\n${r.date_choices.map((o) => `${o.index}) ${o.label}`).join('\n')}`);
  if (r.appointment_choices?.length) out.push(`Citas del paciente para elegir (botones):\n${r.appointment_choices.map((o) => `• ${o.label}`).join('\n')}`);
  if (r.specialty_choices?.length) out.push(`Especialidades para elegir (botones): ${r.specialty_choices.map((o) => o.name).join(', ')}`);
  if (r.proposal) out.push(`Propuesta pendiente: ${r.proposal.summary}. Solo se hace si el paciente pulsa «Confirmar»; «Descartar» la anula.`);
  if (r.suggestions?.length) out.push(`Botones sugeridos: ${r.suggestions.map((x) => x.label).join(' · ')}`);
  return out.join('\n\n');
}

async function decisionOf(c: PoolClient, convId: string, interp: any, reply: Reply, draftMode: ConverseMode | null, parseError?: string) {
  const st = (await c.query(`SELECT state FROM conversations WHERE id = $1`, [convId])).rows[0]?.state ?? {};
  return {
    modelo_valido: !parseError, error_modelo: parseError ?? null,
    intencion: interp?.intent ?? null,
    datos_extraidos: interp ? Object.fromEntries(Object.entries(interp).filter(([k, v]) => k !== 'intent' && v !== null)) : {},
    paso_siguiente: st.step ?? 'idle', idioma: st.lang ?? 'es', idioma_fijado: Boolean(st.lang_locked),
    capa: reply.converse === 'reply' ? (reply.topic === 'service_info' ? '2 · información del servicio' : '1 · conversación general')
      : reply.proposal ? '4 · operación (requiere botón)' : '3 · agenda verificada',
    respuesta: { modo: reply.mode, aclaracion: Boolean(reply.clarification), horarios: reply.options?.length ?? 0,
                 propuesta: reply.proposal?.kind ?? null, botones: (reply.suggestions?.length ?? 0) + (reply.specialty_choices?.length ?? 0) },
    conversacion_generativa: draftMode ?? 'no',
  };
}

async function draftingResponse(c: PoolClient, cfg: ConversationConfig, u: any, lease: string) {
  const result = u.result as Reply & { draft_mode: ConverseMode; lang?: string };
  const hist = (await c.query(
    `SELECT direction, content FROM messages WHERE conversation_id = $1 AND update_id IS DISTINCT FROM $2
       AND (direction = 'outbound' OR intent IS NULL OR intent NOT LIKE 'action:%')
     ORDER BY created_at DESC, id DESC LIMIT 10`, [u.conversation_id, u.id])).rows.reverse();
  const name = (await c.query(`SELECT split_part(full_name, ' ', 1) AS first FROM patients WHERE id = $1`, [u.patient_id])).rows[0]?.first;
  const st = (await c.query(`SELECT state FROM conversations WHERE id = $1`, [u.conversation_id])).rows[0]?.state ?? {};
  // Orientar hacia la agenda solo en el primer turno de charla y luego cada 4 (sin insistir en cada respuesta)
  const streak = Number(st.chat_streak ?? 1);
  const body = buildConverseRequest(cfg.ollamaModel, {
    mode: result.draft_mode, patientText: u.payload.text, lang: result.lang ?? st.lang ?? 'es', quoted: u.payload.reply_to ?? null,
    guide: await serviceGuide(c, result.topic === 'service_info' ? 'full' : 'compact'), pending: result.pending ?? null, orient: !result.pending && (streak <= 1 || streak % 4 === 0),
    patientName: name || null, topic: (result.topic ?? 'chat') as never, facts: result.facts, clock: localClock(cfg.tz),
    history: hist.map((h) => ({ role: h.direction === 'inbound' ? 'user' as const : 'assistant' as const, content: String(h.content) })),
  }, { think: cfg.ollamaThink });
  return { update_id: u.id as string, status: 'drafting', lease_token: lease, prompt_version: CONVERSE_PROMPT_VERSION,
           llm: { url: llmUrl(cfg), timeout_ms: cfg.llmTimeoutMs, body },
           reply: stripInternal(result) };
}

function stripInternal(r: any): Reply {
  const { interpretation: _i, prompt_version: _p, draft_pending: _d, draft_mode: _m, draft: _x, timing: _t, converse: _c, routing: _r, route: _o, facts: _f, ...reply } = r;
  return reply as Reply;
}

/** n8n entrega la redacción del modelo. Se valida; si no pasa, se usa el texto determinista. Siempre cierra el mensaje. */
export async function deliverDraft(pool: Pool, id: string, lease: string, llm: LlmOutcome, tz = 'America/Santo_Domingo') {
  return withTransaction(pool, async (c) => {
    const u = (await c.query(`SELECT id, status, lease_token, result FROM inbound_updates WHERE id = $1 AND kind = 'text' FOR UPDATE`, [id])).rows[0];
    if (!u) throw notFound('Actualización');
    if (u.lease_token !== lease) throw conflict('lease_lost', 'El lease de esta actualización ya no es válido');
    if (u.status === 'done') return { update_id: id, status: 'done', reply: stripInternal(u.result) };
    if (u.status !== 'processing' || !u.result?.draft_pending) throw conflict('not_drafting', 'Esta actualización no espera redacción');
    const mode = u.result.draft_mode as ConverseMode;
    const doctors = (await c.query(`SELECT display_name FROM doctors`)).rows.map((r) => String(r.display_name));
    const check = !llm.ok ? { ok: false as const, reason: llm.error ?? 'error del modelo' }
      : mode === 'grounded' ? validateGrounded(llm.content, u.result.lang ?? 'es', String(u.result.facts ?? ''), doctors)
      : validateConverse(llm.content, { mode, lang: u.result.lang ?? 'es' }, doctors, currentTimeVariants(tz));
    const base = stripInternal(u.result);
    // reply: el texto generado sustituye al respaldo · empathy: la frase va antes del aviso de seguridad verificado
    const reply = check.ok ? { ...base, text: mode === 'empathy' ? `${check.text}\n\n${base.text}` : check.text, generated: true } : base;
    const draft = { ok: check.ok, mode, prompt_version: CONVERSE_PROMPT_VERSION, model: llm.model ?? null, latency_ms: llm.latency_ms ?? null,
                    completion_tokens: llm.eval_count ?? null, rejected_reason: check.ok ? null : check.reason };
    const stored = { ...u.result, ...reply, draft_pending: false, draft };
    await c.query(`UPDATE inbound_updates SET status = 'done', done_at = now(), result = $2, lease_until = NULL WHERE id = $1`, [id, JSON.stringify(stored)]);
    await c.query(`UPDATE messages SET content = $2, payload = $3 WHERE update_id = $1 AND direction = 'outbound'`,
      [id, reply.text, JSON.stringify({ ...reply, draft })]);
    return { update_id: id, status: 'done', reply, validacion: { aceptada: check.ok, motivo_rechazo: check.ok ? null : check.reason, modo: mode } };
  });
}

/** Fallo de infraestructura (p. ej., API de n8n). Reintenta con espera; al agotar intentos responde con el menú. */
export async function fail(pool: Pool, cfg: ConversationConfig, id: string, lease: string, error: string) {
  return withTransaction(pool, async (c) => {
    const locked = await lockLeased(c, id, lease);
    const { u, done } = locked;
    if (done) return { update_id: id, status: 'done' };
    if ('drafting' in locked && locked.drafting) {
      // Fallo durante la redacción: la respuesta verificada ya existe; se cierra sin texto del modelo
      await c.query(`UPDATE inbound_updates SET status = 'done', done_at = now(), lease_until = NULL, last_error = $2 WHERE id = $1`, [id, error.slice(0, 500)]);
      return { update_id: id, status: 'done', reply: stripInternal(u.result) };
    }
    const conv = locked.conv!;
    if (u.attempts < u.max_attempts) {
      await c.query(`UPDATE inbound_updates SET status = 'received', lease_token = NULL, lease_until = NULL, last_error = $2,
                       available_at = now() + make_interval(secs => $3) WHERE id = $1`, [id, error.slice(0, 500), 5 * u.attempts]);
      await c.query(`UPDATE conversations SET lease_token = NULL, lease_until = NULL WHERE id = $1`, [conv.id]);
      return { update_id: id, status: 'retrying' };
    }
    const reply = await runEngine(c, cfg, { id: conv.id, state: { ...INITIAL_STATE, ...conv.state }, version: conv.version },
      u.patient_id, id, { type: 'llm_failed', text: u.payload.text, error }, { intent: 'llm_error' });
    await c.query(`UPDATE inbound_updates SET status = 'dead', done_at = now(), result = $2, last_error = $3, lease_until = NULL WHERE id = $1`,
      [id, JSON.stringify(reply), error.slice(0, 500)]);
    return { update_id: id, status: 'dead', reply };
  });
}
