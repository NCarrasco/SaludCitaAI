#!/usr/bin/env node
// Genera contracts/examples/*.json con respuestas REALES de la API local (datos ficticios).
// Los valores de sesión y CSRF se sustituyen por marcadores; no se guarda ningún secreto.
// Uso: node scripts/generate-examples.mjs
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const env = Object.fromEntries(readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')
  .filter((l) => /^[A-Z0-9_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const BASE = process.env.API_URL ?? `http://127.0.0.1:${env.API_HOST_PORT ?? 8080}/api/v1`;
const OUT = new URL('../contracts/examples/', import.meta.url);
mkdirSync(OUT, { recursive: true });

async function session(email) {
  const r = await fetch(`${BASE}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: env.SEED_ADMIN_PASSWORD }) });
  const cookie = r.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const body = await r.json();
  return { cookie, csrf: body.csrf_token, login: body };
}
const save = (name, request, status, body) => {
  writeFileSync(new URL(`${name}.json`, OUT), JSON.stringify({ request, status, body }, null, 2) + '\n');
  console.log(`✔ ${name} (${status})`);
};
async function get(s, path, name) {
  const r = await fetch(`${BASE}${path}`, { headers: { cookie: s.cookie } });
  save(name, { method: 'GET', path: `/api/v1${path}` }, r.status, await r.json());
}

const viewer = await session('panel@saludcita.test');
save('adminLogin', { method: 'POST', path: '/api/v1/auth/login', body: { email: 'panel@saludcita.test', password: '<SEED_ADMIN_PASSWORD>' } },
  200, { ...viewer.login, csrf_token: '<csrf_…: también en la cookie legible sc_csrf>' });
await get(viewer, '/auth/me', 'adminMe');

const fmt = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Santo_Domingo' }).format(d);
const from = fmt(new Date(Date.now() - 7 * 86400_000));
const to = fmt(new Date(Date.now() + 24 * 86400_000));
const q = `from=${from}&to=${to}`;
await get(viewer, `/stats/summary?${q}`, 'getStatsSummary');
await get(viewer, `/stats/summary?${q}&specialty_id=20000000-0000-4000-8000-000000000002`, 'getStatsSummary-cardiologia');
await get(viewer, `/stats/timeseries?${q}`, 'getStatsTimeseries');
await get(viewer, `/stats/doctors?${q}`, 'getStatsByDoctor');
await get(viewer, `/stats/specialties?${q}`, 'getStatsBySpecialty');
await get(viewer, `/stats/occupancy?${q}`, 'getStatsOccupancy');
await get(viewer, `/stats/offers?${q}`, 'getStatsOffers');
await get(viewer, `/stats/conversation?${q}`, 'getStatsConversation');
await get(viewer, '/admin/integrations', 'getIntegrations');
await get(viewer, '/handoffs', 'error-403-rol-insuficiente');

const op = await session('operador@saludcita.test');
await get(op, '/handoffs?limit=5', 'listHandoffs');
await get(op, '/admin/jobs?limit=5', 'listJobs');
const noCsrf = await fetch(`${BASE}/auth/logout`, { method: 'POST', headers: { cookie: op.cookie } });
save('error-403-sin-csrf', { method: 'POST', path: '/api/v1/auth/logout', headers: { cookie: 'sc_admin=<sesión>' } }, noCsrf.status, await noCsrf.json());
const noAuth = await fetch(`${BASE}/stats/summary?${q}`);
save('error-401-sin-sesion', { method: 'GET', path: `/api/v1/stats/summary?${q}` }, noAuth.status, await noAuth.json());
const bad = await fetch(`${BASE}/stats/summary?from=${to}&to=${from}`, { headers: { cookie: viewer.cookie } });
save('error-400-intervalo', { method: 'GET', path: `/api/v1/stats/summary?from=${to}&to=${from}` }, bad.status, await bad.json());

for (const s of [viewer, op]) {
  await fetch(`${BASE}/auth/logout`, { method: 'POST', headers: { cookie: s.cookie, 'x-csrf-token': s.csrf } });
}
