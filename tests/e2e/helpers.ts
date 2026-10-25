// Utilidades de las pruebas de interfaz: lectura de .env local, preparación y verificación por la API.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const file = Object.fromEntries(readFileSync(resolve(import.meta.dirname, '../../.env'), 'utf8').split('\n')
  .filter((l) => /^[A-Z0-9_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));

export const env = {
  API: process.env.E2E_API ?? `http://127.0.0.1:${file.API_HOST_PORT ?? 8080}`,
  // Instancia e2e (infra/compose.e2e.yaml): confía en X-Forwarded-For para aislar los contadores por IP de cada ejecución
  GRADIO: process.env.E2E_GRADIO ?? `http://127.0.0.1:${file.GRADIO_E2E_PORT ?? 7861}`,
  patientPassword: file.SEED_PATIENT_PASSWORD!,
  adminPassword: file.SEED_ADMIN_PASSWORD!,
};
const V1 = `${env.API}/api/v1`;

/** IP de documentación propia de esta ejecución (RFC 2544): aísla los límites por IP sin desactivarlos. */
export const RUN_IP = process.env.E2E_RUN_IP ?? `198.18.${Math.floor(Math.random() * 250) + 1}.${Math.floor(Math.random() * 250) + 1}`;
export const RUN_HEADERS = { 'x-forwarded-for': RUN_IP };

export async function patientToken(username: string): Promise<string> {
  const r = await fetch(`${V1}/patient-auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password: env.patientPassword }) });
  if (!r.ok) throw new Error(`login ${username}: ${r.status}`);
  return ((await r.json()) as { token: string }).token;
}

async function call<T = any>(method: string, path: string, token: string, body?: object, key?: string): Promise<{ status: number; json: T }> {
  const r = await fetch(`${V1}${path}`, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}),
    ...(key ? { 'idempotency-key': key } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: (r.status === 204 ? null : await r.json()) as T };
}

/**
 * Confirma una intención como la interfaz: envía la orden (n8n la ejecuta) y espera su resultado terminal.
 * Devuelve { status: 200, json: ConfirmResult } si se confirmó, o el código y el error del resultado (sin cambios).
 */
export async function confirmOrder(token: string, intentId: string, intentToken: string, waitMs = 60_000): Promise<{ status: number; json: any }> {
  const s = await call('POST', `/action-intents/${intentId}/submit`, token, { token: intentToken }, randomUUID());
  if (s.status !== 202) return s;
  const t0 = Date.now();
  for (;;) {
    const st = (await call('GET', `/action-intents/${intentId}/confirmation`, token)).json;
    if (st.status === 'confirmed') return { status: 200, json: st.result };
    if (!['queued', 'running'].includes(st.status)) return { status: st.error?.status ?? 500, json: { error: st.error } };
    if (Date.now() - t0 > waitMs) throw new Error(`orden ${s.json.command_id} sin resultado tras ${waitMs} ms (¿n8n detenido?)`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

/** Cancela todas las citas futuras del paciente (deja un estado inicial conocido). */
export async function clearUpcoming(token: string) {
  const list = (await call<{ items: { id: string; version: number; status: string }[] }>('GET', '/appointments?scope=upcoming&limit=100', token)).json.items;
  for (const a of list.filter((x) => x.status === 'booked')) await cancelAppointment(token, a.id, a.version);
}

export async function cancelAppointment(token: string, id: string, version: number) {
  const p = (await call('POST', '/action-intents', token, { kind: 'cancellation', appointment_id: id, expected_version: version })).json;
  return confirmOrder(token, p.intent_id, p.token);
}

/** Reserva el primer horario libre del servicio en una ventana lejana (días 10–40). */
export async function bookFree(token: string, serviceId: string, opts: { optIn?: boolean; skip?: number; after?: string } = {}) {
  const from = opts.after ?? new Date(Date.now() + 10 * 86400_000).toISOString();
  const to = new Date(Date.now() + 29 * 86400_000).toISOString();
  const items = (await call<{ items: { slot_id: string; starts_at: string }[] }>('GET',
    `/availability?doctor_service_id=${serviceId}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&limit=40`, token)).json.items;
  for (const s of items.slice(opts.skip ?? 0)) {
    const p = await call('POST', '/action-intents', token, { kind: 'booking', slot_id: s.slot_id, advance_opt_in: opts.optIn ?? false });
    if (p.status !== 201) continue;
    const c = await confirmOrder(token, p.json.intent_id, p.json.token);
    if (c.status === 200) return c.json.appointment as { id: string; version: number; booking_reference: string; slot: { slot_id: string; starts_at: string; label: string } };
  }
  throw new Error('sin horarios libres para la prueba');
}

export const myAppointments = async (token: string, scope = 'all') =>
  (await call<{ items: any[] }>('GET', `/appointments?scope=${scope}&limit=100`, token)).json.items;
export const myOffers = async (token: string) => (await call<{ items: any[] }>('GET', '/offers', token)).json.items;
export const appointment = async (token: string, id: string) => (await call<{ appointment: any }>('GET', `/appointments/${id}`, token)).json.appointment;

/** Sesión administrativa por cookie (como el navegador) para limpieza tras una prueba. */
export async function adminSession(email: string) {
  const r = await fetch(`${V1}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: env.adminPassword }) });
  const cookie = r.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const { csrf_token } = (await r.json()) as { csrf_token: string };
  return async (method: string, path: string, body?: object) => {
    const x = await fetch(`${V1}${path}`, { method, headers: { cookie, 'x-csrf-token': csrf_token, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined });
    return { status: x.status, json: x.status === 204 ? null : await x.json() };
  };
}

export const SERVICE = { sosa: '40000000-0000-4000-8000-000000000003', taveras: '40000000-0000-4000-8000-000000000004',
  jimenez: '40000000-0000-4000-8000-000000000005', ortega: '40000000-0000-4000-8000-000000000006', mendez: '40000000-0000-4000-8000-000000000001' };

/** Elige una fecha en el calendario propio del panel (DatePicker): abre, avanza de mes si hace falta y pulsa el día. */
export async function pickDate(page: import('@playwright/test').Page, label: string, iso: string) {
  await page.getByRole('button', { name: new RegExp(`^${label}:`) }).first().click();
  const dlg = page.getByRole('dialog', { name: new RegExp(`Elegir ${label.toLowerCase()}`) });
  for (let i = 0; i < 24 && !(await dlg.locator(`[data-day="${iso}"]:not(.out)`).count()); i++) {
    await dlg.getByRole('button', { name: iso > (await dlg.locator('[data-day]').nth(15).getAttribute('data-day'))! ? 'Mes siguiente' : 'Mes anterior' }).click();
  }
  await dlg.locator(`[data-day="${iso}"]:not(.out)`).click();
}
