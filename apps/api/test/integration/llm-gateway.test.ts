// Pasarela de modelos compatible con OpenAI (Groq…): traducción de formatos, clave solo en la API y errores del proveedor.
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { P, auth, setupApp, teardown, type Ctx } from '../helpers/app.js';
import { TEST_SERVICE_SECRET } from '../helpers/env.js';
import { resetGatewayBreaker, toOllama, toOpenAI } from '../../src/modules/conversation/llm-gateway.js';

describe('traducción de formatos', () => {
  it('Ollama → OpenAI: mensajes, temperatura, tokens, semilla y modo JSON; el modelo es el configurado', () => {
    const o = toOpenAI({ model: 'qwen3:1.7b', messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }],
      format: { type: 'object', properties: { a: { type: 'string' } } }, options: { temperature: 0, num_predict: 160, seed: 7 } }, 'llama-3.3-70b-versatile');
    expect(o).toEqual({ model: 'llama-3.3-70b-versatile', messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }],
      temperature: 0, max_tokens: 256, seed: 7,
      response_format: { type: 'json_schema', json_schema: { name: 'respuesta', schema: { type: 'object', properties: { a: { type: 'string' } } }, strict: false } } });
  });
  it('gpt-oss: razonamiento bajo, sin devolverlo y con margen de tokens', () => {
    const o = toOpenAI({ messages: [], options: { num_predict: 160 } }, 'openai/gpt-oss-120b');
    expect(o).toMatchObject({ reasoning_effort: 'low', include_reasoning: false, max_tokens: 256 + 1024 });
  });
  it('OpenAI → Ollama: message.content, contadores y duración en ns (lo que leen los nodos de n8n)', () => {
    const r = toOllama({ model: 'm', choices: [{ message: { content: '{"text":"hola"}' } }], usage: { prompt_tokens: 10, completion_tokens: 3 } }, 'm', 250);
    expect(r).toMatchObject({ model: 'm', message: { content: '{"text":"hola"}' }, prompt_eval_count: 10, eval_count: 3, total_duration: 250_000_000 });
  });
});

describe('endpoint /internal/llm/chat', () => {
  let ctx: Ctx; let fake: Server; let seen: { auth?: string; body?: any } = {};
  const SVC = auth(`svc_${TEST_SERVICE_SECRET}`);
  beforeAll(async () => {
    fake = createServer((req, res) => {
      let data = '';
      req.on('data', (c) => (data += c)).on('end', () => {
        seen = { auth: req.headers.authorization, body: JSON.parse(data) };
        res.setHeader('content-type', 'application/json');
        if (seen.body.messages[0].content === 'limite') { res.statusCode = 429; res.end(JSON.stringify({ error: { message: 'Rate limit reached' } })); return; }
        res.end(JSON.stringify({ model: seen.body.model, choices: [{ message: { content: '{"text":"ok"}' } }], usage: { prompt_tokens: 5, completion_tokens: 2 } }));
      });
    }).listen(0);
    const port = (fake.address() as { port: number }).port;
    ctx = await setupApp({ llmProvider: 'openai', llmApiBase: `http://127.0.0.1:${port}/v1`, llmApiKey: 'clave-de-prueba', llmApiModel: 'modelo-nube', llmFallback: false });
  });
  afterAll(async () => { await teardown(ctx); fake.close(); });

  it('reenvía con la clave de la API y responde con formato de Ollama', async () => {
    const r = await ctx.app.inject({ method: 'POST', url: `${P}/internal/llm/chat`, headers: SVC,
      payload: { model: 'qwen3:1.7b', messages: [{ role: 'user', content: 'hola' }], format: {}, options: { temperature: 0 } } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ model: 'modelo-nube', message: { content: '{"text":"ok"}' }, eval_count: 2 });
    expect(seen.auth).toBe('Bearer clave-de-prueba');
    expect(seen.body.model).toBe('modelo-nube');
    expect(JSON.stringify(r.json())).not.toContain('clave-de-prueba');
  });
  it('sin credencial de servicio: 401; límite del proveedor: 429 sin exponer la clave', async () => {
    expect((await ctx.app.inject({ method: 'POST', url: `${P}/internal/llm/chat`, payload: { messages: [] } })).statusCode).toBe(401);
    const r = await ctx.app.inject({ method: 'POST', url: `${P}/internal/llm/chat`, headers: SVC, payload: { messages: [{ role: 'user', content: 'limite' }] } });
    expect(r.statusCode).toBe(429);
    expect(r.body).not.toContain('clave-de-prueba');
  });
  it('el prompt que recibe n8n apunta a la pasarela, no a Ollama', async () => {
    const { login } = await import('../helpers/app.js');
    const { randomUUID } = await import('node:crypto');
    const t = await login(ctx, 3);
    const m = await ctx.app.inject({ method: 'POST', url: `${P}/conversation/messages`, headers: auth(t), payload: { client_message_id: randomUUID(), text: 'hola' } });
    const c = (await ctx.app.inject({ method: 'POST', url: `${P}/internal/updates/claim`, headers: SVC, payload: { update_id: m.json().update_id } })).json().items[0];
    expect(c.llm.url).toBe('http://api:8080/api/v1/internal/llm/chat');
  });
});

describe('respaldo local (Qwen en Ollama) cuando el proveedor falla', () => {
  let ctx: Ctx; let cloud: Server; let local: Server;
  let cloudMode: 'ok' | 'limit' | 'down' = 'ok';
  const hits = { cloud: 0, local: 0 }; let localBody: any;
  const SVC = auth(`svc_${TEST_SERVICE_SECRET}`);
  const ask = () => ctx.app.inject({ method: 'POST', url: `${P}/internal/llm/chat`, headers: SVC,
    payload: { model: 'x', messages: [{ role: 'user', content: 'hola' }], format: {}, options: { temperature: 0, num_ctx: 3072 } } });
  beforeAll(async () => {
    cloud = createServer((req, res) => {
      req.resume().on('end', () => {
        hits.cloud++;
        res.setHeader('content-type', 'application/json');
        if (cloudMode === 'limit') { res.statusCode = 429; res.end(JSON.stringify({ error: { message: 'Rate limit reached' } })); return; }
        if (cloudMode === 'down') { res.statusCode = 503; res.end('{}'); return; }
        res.end(JSON.stringify({ model: 'modelo-nube', choices: [{ message: { content: '{"text":"nube"}' } }] }));
      });
    }).listen(0);
    local = createServer((req, res) => {
      let data = '';
      req.on('data', (c) => (data += c)).on('end', () => {
        hits.local++; localBody = JSON.parse(data);
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ model: localBody.model, done: true, message: { role: 'assistant', content: '{"text":"local"}' }, eval_count: 4 }));
      });
    }).listen(0);
    const cp = (cloud.address() as { port: number }).port, lp = (local.address() as { port: number }).port;
    ctx = await setupApp({ llmProvider: 'openai', llmApiBase: `http://127.0.0.1:${cp}/v1`, llmApiKey: 'clave-de-prueba', llmApiModel: 'modelo-nube',
      llmFallback: true, ollamaUrl: `http://127.0.0.1:${lp}`, ollamaModel: 'qwen3:1.7b' });
  });
  afterAll(async () => { await teardown(ctx); cloud.close(); local.close(); resetGatewayBreaker(); });

  it('proveedor disponible: responde la nube y no se toca el modelo local', async () => {
    resetGatewayBreaker(); cloudMode = 'ok'; hits.cloud = hits.local = 0;
    const r = await ask();
    expect(r.json()).toMatchObject({ model: 'modelo-nube', message: { content: '{"text":"nube"}' } });
    expect(hits).toEqual({ cloud: 1, local: 0 });
  });
  it('límite diario (429): responde Qwen con la misma petición y la nube se salta durante un rato', async () => {
    resetGatewayBreaker(); cloudMode = 'limit'; hits.cloud = hits.local = 0;
    const r = await ask();
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ model: 'qwen3:1.7b', fallback: true, message: { content: '{"text":"local"}' } });
    expect(localBody).toMatchObject({ model: 'qwen3:1.7b', stream: false, think: false, format: {}, options: { num_ctx: 3072 } });
    expect(localBody.messages).toEqual([{ role: 'user', content: 'hola' }]);
    expect(JSON.stringify(localBody)).not.toContain('clave-de-prueba');
    await ask();                                                       // segundo mensaje: directo al respaldo, sin esperar a la nube
    expect(hits).toEqual({ cloud: 1, local: 2 });
  });
  it('proveedor caído (5xx): también responde el respaldo', async () => {
    resetGatewayBreaker(); cloudMode = 'down'; hits.cloud = hits.local = 0;
    expect((await ask()).json()).toMatchObject({ model: 'qwen3:1.7b', fallback: true });
    expect(hits).toEqual({ cloud: 1, local: 1 });
  });
});
