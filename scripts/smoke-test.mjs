#!/usr/bin/env node
// Prueba de humo contra la API en ejecución (Docker Compose local).
// Uso: node scripts/smoke-test.mjs   (lee API_HOST_PORT y SEED_PATIENT_PASSWORD de .env)
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

const env = Object.fromEntries(readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')
  .filter((l) => /^[A-Z0-9_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const BASE = process.env.API_URL ?? `http://127.0.0.1:${env.API_HOST_PORT ?? 8080}/api/v1`;
const PASSWORD = process.env.SEED_PATIENT_PASSWORD ?? env.SEED_PATIENT_PASSWORD;

let failures = 0;
const check = (ok, msg) => { console.log(`${ok ? '✔' : '✘'} ${msg}`); if (!ok) failures++; };

async function call(method, path, { token, body, headers = {} } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, json: text ? JSON.parse(text) : null };
}

// Confirmación como la interfaz: orden durable → n8n la ejecuta → resultado (no hay ruta de ejecución directa)
async function confirmOrder(token, intent, key = randomUUID()) {
  const s = await call('POST', `/action-intents/${intent.intent_id}/submit`, { token, body: { token: intent.token }, headers: { 'idempotency-key': key } });
  if (s.status !== 202) return s;
  const t0 = Date.now();
  for (;;) {
    const st = (await call('GET', `/action-intents/${intent.intent_id}/confirmation`, { token })).json;
    if (st.status === 'confirmed') return { status: 200, headers: s.headers, json: st.result, order: s.json };
    if (!['queued', 'running'].includes(st.status)) return { status: st.error?.status ?? 500, headers: s.headers, json: { error: st.error }, order: s.json };
    if (Date.now() - t0 > 60_000) throw new Error('la orden no terminó en 60 s (¿n8n detenido?)');
    await new Promise((r) => setTimeout(r, 200));
  }
}

const login = async (u) => (await call('POST', '/patient-auth/login', { body: { username: u, password: PASSWORD } })).json.token;

const ready = await call('GET', '/health/ready');
check(ready.status === 200, `API lista en ${BASE}`);

const a = await login('paciente18');
const b = await login('paciente19');
check(Boolean(a && b), 'login de dos pacientes ficticios');

const from = new Date(Date.now() + 2 * 86400_000).toISOString();
const to = new Date(Date.now() + 16 * 86400_000).toISOString();
const avail = await call('GET', `/availability?specialty_id=20000000-0000-4000-8000-000000000003&from=${from}&to=${to}&limit=5`, { token: a });
check(avail.status === 200 && avail.json.items.length >= 2, `disponibilidad real de Pediatría (${avail.json.items?.length} slots)`);
const [s1, s2] = avail.json.items;
console.log(`   primer horario: ${s1.label} · ${s1.doctor.display_name}`);

const p = await call('POST', '/action-intents', { token: a, body: { kind: 'booking', slot_id: s1.slot_id } });
check(p.status === 201 && p.json.holds_slot === false, 'intención de reserva preparada (sin retener el horario)');
const key = randomUUID();
const c1 = await confirmOrder(a, p.json, key);
const c2 = await confirmOrder(a, p.json, key);
check(c1.status === 200 && c1.json.outcome === 'booked', `cita confirmada por n8n ${c1.json.appointment?.booking_reference} (orden ${c1.order?.command_id})`);
check(c2.status === 200 && c2.json.appointment.id === c1.json.appointment.id && c2.headers.get('idempotent-replayed') === 'true'
  && c2.order.command_id === c1.order.command_id, 'reenviar con la misma clave devuelve la misma orden y el mismo resultado');

const pb = await call('POST', '/action-intents', { token: b, body: { kind: 'booking', slot_id: s1.slot_id } });
check(pb.status === 409 && pb.json.error.code === 'slot_unavailable', 'otro paciente no puede reservar el mismo horario');
const spy = await call('GET', `/appointments/${c1.json.appointment.id}`, { token: b });
check(spy.status === 404, 'otro paciente no ve la cita ajena (404)');

const r = await call('POST', '/action-intents', { token: a, body: { kind: 'reschedule', appointment_id: c1.json.appointment.id, expected_version: 1, new_slot_id: s2.slot_id } });
const rc = await confirmOrder(a, r.json);
check(rc.status === 200 && rc.json.appointment.slot.slot_id === s2.slot_id && rc.json.appointment.version === 2, 'reprogramación conserva el ID y sube la versión');

const x = await call('POST', '/action-intents', { token: a, body: { kind: 'cancellation', appointment_id: c1.json.appointment.id, expected_version: 2 } });
const xc = await confirmOrder(a, x.json);
check(xc.status === 200 && xc.json.appointment.status === 'cancelled', 'cancelación confirmada');

// Conversación por la ruta real: API → n8n → Ollama → API. Informa el modo sin darlo por bueno si no es IA.
const msg = await call('POST', '/conversation/messages', { token: a, body: { client_message_id: randomUUID(), text: 'Quiero una cita de pediatría' } });
let upd = null;
for (let i = 0; i < 90 && (!upd || upd.json.status === 'pending'); i++) {
  await new Promise((r) => setTimeout(r, 1000));
  upd = await call('GET', `/conversation/updates/${msg.json.update_id}`, { token: a });
}
const mode = upd?.json.reply?.mode;
check(upd?.json.status === 'done', `conversación procesada por n8n (modo: ${mode ?? 'sin respuesta'})`);
if (mode !== 'ai') console.log('   ⚠ La IA no respondió: revisa que Ollama esté activo (--profile ai) y el modelo descargado.');
const menu = await call('POST', '/conversation/messages', { token: a, body: { client_message_id: randomUUID(), action: { type: 'menu', item: 'book' } } });
check(menu.status === 200 && menu.json.reply.mode === 'deterministic' && menu.json.reply.specialty_choices.length > 0, 'menú guiado sin IA');

// Panel: sesión por cookie, CSRF y estadísticas
const adminLogin = await fetch(`${BASE}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'panel@saludcita.test', password: env.SEED_ADMIN_PASSWORD }) });
const adminCookie = adminLogin.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
const { csrf_token: csrf } = await adminLogin.json();
const fmt = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Santo_Domingo' }).format(d);
const stats = await fetch(`${BASE}/stats/summary?from=${fmt(new Date())}&to=${fmt(new Date(Date.now() + 31 * 86400_000))}`, { headers: { cookie: adminCookie } });
const sj = await stats.json();
check(stats.status === 200 && sj.data.occupancy.enabled > 0 && 'definitions' in sj,
  `estadísticas del panel (ocupación ${sj.data?.occupancy.occupied}/${sj.data?.occupancy.enabled})`);
const noCsrf = await fetch(`${BASE}/auth/logout`, { method: 'POST', headers: { cookie: adminCookie } });
check(noCsrf.status === 403, 'escritura sin X-CSRF-Token rechazada');
const out = await fetch(`${BASE}/auth/logout`, { method: 'POST', headers: { cookie: adminCookie, 'x-csrf-token': csrf } });
check(out.status === 204, 'cierre de sesión administrativa');

// Panel administrativo servido en el mismo origen
const panel = await fetch(BASE.replace(/\/api\/v1$/, '/panel/'));
check(panel.status === 200 && (panel.headers.get('content-security-policy') ?? '').includes("default-src 'self'"),
  'panel administrativo en /panel/ con CSP');

console.log(failures === 0 ? '\nPrueba de humo superada.' : `\n${failures} comprobaciones fallidas.`);
process.exit(failures === 0 ? 0 : 1);
