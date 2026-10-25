// Pasarela de modelos: n8n llama SIEMPRE con el mismo formato (el de Ollama /api/chat). Si el proveedor configurado es
// compatible con OpenAI (Groq, OpenAI…), la API traduce la petición, añade la clave (que solo vive en la API, nunca en
// n8n ni en el navegador) y devuelve la respuesta en el formato de Ollama, así los nodos de n8n no cambian.
// Respaldo: si el proveedor falla (límite diario, caída, lentitud), la MISMA petición va al modelo local (Ollama, Qwen) dentro
// del tiempo que n8n concede a la llamada. Tras un fallo, el proveedor se salta un rato para no esperar en cada mensaje.

export interface GatewayConfig {
  apiBase: string; apiKey: string; model: string; timeoutMs: number;
  fallback?: { ollamaUrl: string; model: string };
}

interface OllamaRequest {
  model?: string; think?: boolean; keep_alive?: string; messages: { role: string; content: string }[]; format?: unknown;
  options?: { temperature?: number; num_predict?: number; seed?: number };
}

/** Petición en formato OpenAI (chat/completions) equivalente a la de Ollama. */
export function toOpenAI(body: OllamaRequest, model: string) {
  const o = body.options ?? {};
  // Modelos con razonamiento (gpt-oss, qwen3): razonamiento mínimo para responder rápido, sin devolver el razonamiento,
  // y margen de tokens para que el razonamiento no deje la respuesta vacía
  const reasoning = /gpt-oss/i.test(model) ? { reasoning_effort: 'low', include_reasoning: false }
    : /qwen3/i.test(model) ? { reasoning_effort: 'none' } : {};
  const extra = 'reasoning_effort' in reasoning && reasoning.reasoning_effort === 'low' ? 1024 : 0;
  return {
    model,
    messages: body.messages.map((m) => ({ role: m.role, content: m.content })),
    ...reasoning,
    ...(o.temperature !== undefined ? { temperature: o.temperature } : {}),
    ...(o.num_predict !== undefined ? { max_tokens: Math.max(o.num_predict, 256) + extra } : {}),
    ...(o.seed !== undefined ? { seed: o.seed } : {}),
    // El esquema JSON de Ollama (`format`) se envía como «structured outputs» (el modelo debe devolver todos los campos);
    // si no es un esquema, modo JSON. La API valida la salida igualmente.
    ...(body.format && typeof body.format === 'object' && 'properties' in (body.format as object)
      ? { response_format: { type: 'json_schema', json_schema: { name: 'respuesta', schema: body.format, strict: false } } }
      : body.format ? { response_format: { type: 'json_object' } } : {}),
  };
}

/** Respuesta OpenAI → forma de Ollama que leen los nodos de n8n (message.content, contadores y duración en ns). */
export function toOllama(r: any, model: string, ms: number) {
  const content = r?.choices?.[0]?.message?.content ?? '';
  return {
    model: r?.model ?? model, created_at: new Date().toISOString(), done: true,
    message: { role: 'assistant', content },
    prompt_eval_count: r?.usage?.prompt_tokens ?? null, eval_count: r?.usage?.completion_tokens ?? null,
    total_duration: Math.round(ms * 1e6),
  };
}

type GatewayResult = { ok: true; body: ReturnType<typeof toOllama> & { fallback?: true } } | { ok: false; status: number; error: string };

// Con respaldo, el proveedor tiene un tiempo corto: si no responde, queda margen para el modelo local
const PRIMARY_BUDGET_MS = 15_000;
let skipPrimaryUntil = 0;
/** Solo pruebas: vuelve a intentar el proveedor de inmediato. */
export function resetGatewayBreaker() { skipPrimaryUntil = 0; }

export async function gatewayChat(cfg: GatewayConfig, body: OllamaRequest): Promise<GatewayResult> {
  if (!cfg.fallback) return primaryChat(cfg, body, cfg.timeoutMs);
  const t0 = performance.now();
  let first: GatewayResult | null = null;
  if (Date.now() >= skipPrimaryUntil) {
    first = await primaryChat(cfg, body, Math.min(cfg.timeoutMs, PRIMARY_BUDGET_MS));
    if (first.ok) return first;
    // 429 (límite de Groq): se salta 5 min; caída o lentitud: 1 min
    skipPrimaryUntil = Date.now() + (first.status === 429 ? 300_000 : 60_000);
  }
  const left = cfg.timeoutMs - (performance.now() - t0) - 1_500;
  const second = await fallbackChat(cfg.fallback, body, Math.max(left, 5_000));
  if (second.ok) return second;
  return { ok: false, status: first && !first.ok ? first.status : second.status,
    error: `${first && !first.ok ? `${first.error}; ` : ''}respaldo local: ${second.error}` };
}

/** Modelo local (Ollama): ya habla el formato de n8n; se mantiene cargado para responder rápido la próxima vez. */
async function fallbackChat(fb: NonNullable<GatewayConfig['fallback']>, body: OllamaRequest, timeoutMs: number): Promise<GatewayResult> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(`${fb.ollamaUrl.replace(/\/$/, '')}/api/chat`, {
      method: 'POST', signal: ac.signal, headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...body, model: fb.model, stream: false, think: false, keep_alive: '24h' }),
    });
    const json = await res.json().catch(() => null);
    if (!res.ok || !json?.message) return { ok: false, status: 502, error: String(json?.error ?? `HTTP ${res.status}`).slice(0, 200) };
    return { ok: true, body: { ...json, fallback: true } };
  } catch (e) {
    return { ok: false, status: 504, error: ac.signal.aborted ? 'no respondió a tiempo' : (e as Error).message };
  } finally {
    clearTimeout(timer);
  }
}

/** Carga el modelo de respaldo en memoria al arrancar (la primera carga tarda segundos). Sin esperar ni fallar. */
export function warmFallback(cfg: GatewayConfig) {
  if (!cfg.fallback) return;
  void fallbackChat(cfg.fallback, { messages: [{ role: 'user', content: 'hola' }], options: { num_predict: 1 } }, 120_000).catch(() => undefined);
}

async function primaryChat(cfg: GatewayConfig, body: OllamaRequest, timeoutMs: number): Promise<GatewayResult> {
  const t0 = performance.now();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(`${cfg.apiBase.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST', signal: ac.signal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify(toOpenAI(body, cfg.model)),
    });
    const json = await res.json().catch(() => null);
    if (!res.ok) {
      // Sin repetir la clave ni la petición: solo el estado y el mensaje del proveedor
      const msg = String(json?.error?.message ?? `HTTP ${res.status}`).slice(0, 200);
      return { ok: false as const, status: res.status === 429 ? 429 : 502, error: `proveedor del modelo: ${msg}` };
    }
    return { ok: true as const, body: toOllama(json, cfg.model, performance.now() - t0) };
  } catch (e) {
    return { ok: false as const, status: 504, error: ac.signal.aborted ? 'el proveedor del modelo no respondió a tiempo' : `proveedor del modelo: ${(e as Error).message}` };
  } finally {
    clearTimeout(timer);
  }
}
