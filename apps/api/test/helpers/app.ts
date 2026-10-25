import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { buildApp } from '../../src/app.js';
import type { Config } from '../../src/config/env.js';
import { createPool } from '../../src/db/pool.js';
import { TEST_ADMIN_PASSWORD, TEST_PATIENT_PASSWORD, TEST_SERVICE_SECRET, testDatabaseUrl } from './env.js';

export const P = '/api/v1';
export const SPECIALTY = {
  internal: '20000000-0000-4000-8000-000000000001',
  cardio: '20000000-0000-4000-8000-000000000002',
  pedia: '20000000-0000-4000-8000-000000000003',
};
export const SERVICE = {
  mendez: '40000000-0000-4000-8000-000000000001',
  pena: '40000000-0000-4000-8000-000000000002',
  sosa: '40000000-0000-4000-8000-000000000003',
  taveras: '40000000-0000-4000-8000-000000000004',
  jimenez: '40000000-0000-4000-8000-000000000005',
  ortega: '40000000-0000-4000-8000-000000000006',
};

export interface Ctx { app: FastifyInstance; pool: pg.Pool; db: pg.Pool; tokens: Map<string, string> }

export async function setupApp(overrides: Partial<Config> = {}): Promise<Ctx> {
  const cfg: Config = {
    databaseUrl: testDatabaseUrl(), port: 0, logLevel: 'silent', liveEvents: true, liveHeartbeatMs: 300, businessTimezone: 'America/Santo_Domingo',
    intentTtlSeconds: 600, patientSessionTtlHours: 12, corsAllowedOrigins: ['http://localhost:5173'], dbPoolMax: 30,
    ollamaUrl: 'http://ollama.invalid:11434', ollamaModel: 'modelo-de-prueba', llmTimeoutMs: 45000, llmProvider: 'ollama', llmApiBase: 'https://api.groq.com/openai/v1', llmApiModel: 'llama-3.3-70b-versatile', llmFallback: true, internalApiUrl: 'http://api:8080/api/v1', llmConverseEnabled: false, guestAbandonedAfterDays: 30, guestSessionRetentionDays: 7, conversationLeaseSeconds: 120, adminSessionTtlHours: 8, cookieSecure: false, offerWindowSeconds: 3600, offersDemoMode: false, reminderLeadHours: [24, 1], guestSessionTtlDays: 30, recoveryCodeTtlDays: 180,
    ...overrides,
  };
  const pool = createPool(cfg.databaseUrl, cfg.dbPoolMax);
  const app = await buildApp(cfg, pool, { logger: false });
  await app.ready();
  const db = new pg.Pool({ connectionString: cfg.databaseUrl, max: 4 });
  return { app, pool, db, tokens: new Map() };
}

export async function teardown(ctx: Ctx) {
  await ctx.app.close();
  await ctx.pool.end();
  await ctx.db.end();
}

/** Limpia citas y efectos derivados (TRUNCATE no dispara los triggers de inmutabilidad por fila). */
export async function resetAgenda(ctx: Ctx) {
  await ctx.db.query(`TRUNCATE appointment_events, advance_offers, offer_rounds, notifications, calendar_sync,
    outbox_jobs, analytics_events, idempotency_records, action_intents, appointments CASCADE`);
  await ctx.db.query(`UPDATE slots SET status = 'open' WHERE status = 'blocked'`);
}

export async function login(ctx: Ctx, n: number): Promise<string> {
  const username = `paciente${String(n).padStart(2, '0')}`;
  const cached = ctx.tokens.get(username);
  if (cached) return cached;
  const r = await ctx.app.inject({ method: 'POST', url: `${P}/patient-auth/login`,
    payload: { username, password: TEST_PATIENT_PASSWORD } });
  if (r.statusCode !== 200) throw new Error(`login ${username}: ${r.statusCode} ${r.body}`);
  const token = r.json().token as string;
  ctx.tokens.set(username, token);
  return token;
}

export const auth = (token: string) => ({ authorization: `Bearer ${token}` });

/** Slots reservables del servicio, ordenados; permite saltar los primeros. */
export async function freeSlots(ctx: Ctx, serviceId: string, n: number, skip = 0): Promise<{ slot_id: string; starts_at: Date }[]> {
  const r = await ctx.db.query(
    `SELECT slot_id, starts_at FROM reservable_slots WHERE doctor_service_id = $1
     ORDER BY starts_at OFFSET $2 LIMIT $3`, [serviceId, skip, n]);
  if (r.rows.length < n) throw new Error('no hay suficientes slots libres en el seed');
  return r.rows;
}

export async function prepare(ctx: Ctx, token: string, body: object) {
  return ctx.app.inject({ method: 'POST', url: `${P}/action-intents`, headers: auth(token), payload: body });
}

/** Respuesta con la forma de `inject` (statusCode, headers, body, json()) para resultados de órdenes durables. */
export interface OrderResponse { statusCode: number; headers: Record<string, unknown>; body: string; json(): any }
const asResponse = (statusCode: number, body: unknown, headers: Record<string, unknown>): OrderResponse =>
  ({ statusCode, headers, body: JSON.stringify(body), json: () => body });

/**
 * n8n SIMULADO para UNA orden concreta: la reclama (lease) solo si sigue pendiente y llama al mismo endpoint interno
 * que el workflow «Comandos durables». No toca órdenes de otros pacientes ni otras pruebas.
 */
export async function runOrder(ctx: Ctx, commandId: string) {
  const l = (await ctx.db.query(
    `UPDATE outbox_jobs SET status = 'leased', lease_token = gen_random_uuid(), lease_until = now() + interval '120 seconds',
            attempts = attempts + 1, updated_at = now()
     WHERE id = $1 AND status = 'pending' RETURNING kind, lease_token`, [commandId])).rows[0];
  if (!l) return null;
  const path = l.kind === 'offer.answer' ? 'offer-answer' : 'confirm';
  return ctx.app.inject({ method: 'POST', url: `${P}/internal/commands/${commandId}/${path}`,
    headers: auth(`svc_${TEST_SERVICE_SECRET}`), payload: { lease_token: l.lease_token } });
}

async function waitOrder(ctx: Ctx, token: string, url: string) {
  for (let i = 0; i < 500; i++) {
    const st = (await ctx.app.inject({ method: 'GET', url, headers: auth(token) })).json();
    if (!['queued', 'running'].includes(st.status)) return st;
    await new Promise((r) => setTimeout(r, 10));           // otra llamada concurrente está ejecutando la misma orden
  }
  throw new Error(`orden sin terminar: ${url}`);
}

/**
 * Confirmación como la hace la interfaz: envía la orden (202), n8n simulado la ejecuta y se lee el resultado.
 * Devuelve 200 + ConfirmResult si se confirmó, o el código y el error del resultado terminal (sin cambios).
 */
export async function confirm(ctx: Ctx, token: string, intentId: string, intentToken: string, key = randomUUID()): Promise<OrderResponse> {
  const s = await ctx.app.inject({ method: 'POST', url: `${P}/action-intents/${intentId}/submit`,
    headers: { ...auth(token), 'idempotency-key': key }, payload: { token: intentToken } });
  if (s.statusCode !== 202) return asResponse(s.statusCode, s.json(), s.headers);
  await runOrder(ctx, s.json().command_id);
  const st = await waitOrder(ctx, token, `${P}/action-intents/${intentId}/confirmation`);
  return st.status === 'confirmed' ? asResponse(200, st.result, s.headers) : asResponse(st.error.status, { error: st.error }, s.headers);
}

/** Respuesta a un adelanto como la hace la interfaz (orden offer.answer ejecutada por n8n simulado). */
export async function answerOffer(ctx: Ctx, token: string, offerId: string, action: 'accept' | 'reject', key = randomUUID()): Promise<OrderResponse> {
  const s = await ctx.app.inject({ method: 'POST', url: `${P}/offers/${offerId}/answer`,
    headers: { ...auth(token), 'idempotency-key': key }, payload: { action } });
  if (s.statusCode !== 202) return asResponse(s.statusCode, s.json(), s.headers);
  await runOrder(ctx, s.json().command_id);
  const st = await waitOrder(ctx, token, `${P}/offers/${offerId}/answer`);
  return st.status === 'done' ? asResponse(200, st.result, s.headers) : asResponse(st.error.status, { error: st.error }, s.headers);
}

/** Prepara y confirma una reserva; devuelve la cita. */
export async function book(ctx: Ctx, token: string, slotId: string, extra: object = {}) {
  const p = await prepare(ctx, token, { kind: 'booking', slot_id: slotId, ...extra });
  if (p.statusCode !== 201) throw new Error(`prepare: ${p.statusCode} ${p.body}`);
  const c = await confirm(ctx, token, p.json().intent_id, p.json().token);
  if (c.statusCode !== 200) throw new Error(`confirm: ${c.statusCode} ${c.body}`);
  return c.json().appointment as { id: string; version: number; status: string; booking_reference: string; slot: { slot_id: string } };
}

export interface AdminSession { cookie: string; csrf: string; role: string }

/** Inicia sesión administrativa y devuelve la cookie (para cabecera Cookie) y el token CSRF. */
export async function adminLogin(ctx: Ctx, email: string): Promise<AdminSession> {
  const r = await ctx.app.inject({ method: 'POST', url: `${P}/auth/login`, payload: { email, password: TEST_ADMIN_PASSWORD } });
  if (r.statusCode !== 200) throw new Error(`admin login ${email}: ${r.statusCode} ${r.body}`);
  const c = r.cookies.find((x) => x.name === 'sc_admin')!;
  return { cookie: `sc_admin=${c.value}`, csrf: r.json().csrf_token, role: r.json().user.role };
}

export const adminHeaders = (s: AdminSession, withCsrf = true) =>
  ({ cookie: s.cookie, ...(withCsrf ? { 'x-csrf-token': s.csrf } : {}) });
