import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  P, SERVICE, adminHeaders, adminLogin, auth, book, confirm, freeSlots, login, prepare, resetAgenda, setupApp, teardown,
  type AdminSession, type Ctx,
} from '../helpers/app.js';

let ctx: Ctx;
let viewer: AdminSession;
let operator: AdminSession;
let admin: AdminSession;
const TZ = 'America/Santo_Domingo';

beforeAll(async () => {
  ctx = await setupApp();
  viewer = await adminLogin(ctx, 'panel@saludcita.test');
  operator = await adminLogin(ctx, 'operador@saludcita.test');
  admin = await adminLogin(ctx, 'admin@saludcita.test');
});
afterAll(async () => { await teardown(ctx); });

const localDate = async (expr: string) =>
  (await ctx.db.query(`SELECT to_char(((${expr}) AT TIME ZONE '${TZ}')::date, 'YYYY-MM-DD') d`)).rows[0].d as string;

describe('sesión administrativa', () => {
  it('login con cookie HttpOnly y CSRF; credenciales incorrectas → 401', async () => {
    const r = await ctx.app.inject({ method: 'POST', url: `${P}/auth/login`, payload: { email: 'panel@saludcita.test', password: 'mala' } });
    expect(r.statusCode).toBe(401);
    const ok = await ctx.app.inject({ method: 'POST', url: `${P}/auth/login`, payload: { email: 'PANEL@saludcita.test', password: 'clave-admin-de-prueba' } });
    const c = ok.cookies.find((x) => x.name === 'sc_admin')!;
    expect(c.httpOnly).toBe(true);
    expect(c.sameSite).toBe('Lax');
    expect(ok.cookies.find((x) => x.name === 'sc_csrf')!.httpOnly).toBeFalsy();
    expect(JSON.stringify(ok.json())).not.toContain(c.value); // el token de sesión no viaja en el cuerpo
    expect(ok.json().user.role).toBe('viewer');
  });

  it('una sesión de paciente no da acceso al panel ni a la inversa', async () => {
    const t = await login(ctx, 1);
    const from = await localDate('now()');
    expect((await ctx.app.inject({ url: `${P}/stats/summary?from=${from}&to=${from}`, headers: auth(t) })).statusCode).toBe(403);
    expect((await ctx.app.inject({ url: `${P}/appointments`, headers: adminHeaders(viewer) })).statusCode).toBe(403);
  });

  it('las escrituras exigen X-CSRF-Token; logout revoca la sesión', async () => {
    const s = await adminLogin(ctx, 'operador@saludcita.test');
    const noCsrf = await ctx.app.inject({ method: 'POST', url: `${P}/auth/logout`, headers: adminHeaders(s, false) });
    expect(noCsrf.statusCode).toBe(403);
    const wrong = await ctx.app.inject({ method: 'POST', url: `${P}/auth/logout`, headers: { cookie: s.cookie, 'x-csrf-token': 'csrf_falso' } });
    expect(wrong.statusCode).toBe(403);
    expect((await ctx.app.inject({ method: 'POST', url: `${P}/auth/logout`, headers: adminHeaders(s) })).statusCode).toBe(204);
    expect((await ctx.app.inject({ url: `${P}/auth/me`, headers: adminHeaders(s) })).statusCode).toBe(401);
  });

  it('roles: viewer ve estadísticas pero no operaciones; operator sí', async () => {
    expect((await ctx.app.inject({ url: `${P}/handoffs`, headers: adminHeaders(viewer) })).statusCode).toBe(403);
    expect((await ctx.app.inject({ url: `${P}/handoffs`, headers: adminHeaders(operator) })).statusCode).toBe(200);
    // Sistema (diagnóstico técnico): solo admin. Ni viewer ni operator, aunque fuercen la URL
    const q = 'from=2026-10-01&to=2026-10-31';
    for (const url of ['/admin/jobs', '/admin/integrations', `/stats/conversation?${q}`]) {
      expect((await ctx.app.inject({ url: `${P}${url}`, headers: adminHeaders(viewer) })).statusCode, url).toBe(403);
      expect((await ctx.app.inject({ url: `${P}${url}`, headers: adminHeaders(operator) })).statusCode, url).toBe(403);
      expect((await ctx.app.inject({ url: `${P}${url}`, headers: adminHeaders(admin) })).statusCode, url).toBe(200);
    }
    const retry = await ctx.app.inject({ method: 'POST', url: `${P}/admin/jobs/00000000-0000-4000-8000-000000000000/retry`, headers: adminHeaders(operator) });
    expect(retry.statusCode).toBe(403);
    // Métricas de negocio siguen abiertas a viewer
    expect((await ctx.app.inject({ url: `${P}/stats/offers?${q}`, headers: adminHeaders(viewer) })).statusCode).toBe(200);
  });

  it('CORS: origen autorizado recibe cabeceras con credenciales; uno no autorizado no', async () => {
    const pre = (origin: string) => ctx.app.inject({ method: 'OPTIONS', url: `${P}/stats/summary`,
      headers: { origin, 'access-control-request-method': 'GET', 'access-control-request-headers': 'x-csrf-token' } });
    const ok = await pre('http://localhost:5173');
    expect(ok.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    expect(ok.headers['access-control-allow-credentials']).toBe('true');
    expect(String(ok.headers['access-control-allow-headers'])).toContain('x-csrf-token');
    const bad = await pre('https://evil.example');
    expect(bad.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('estadísticas conciliables con PostgreSQL', () => {
  beforeEach(async () => { await resetAgenda(ctx); });

  it('resumen, serie, médicos y especialidades coinciden con las operaciones realizadas y con SQL independiente', async () => {
    const t1 = await login(ctx, 1);
    const t2 = await login(ctx, 2);
    const t3 = await login(ctx, 3);
    const [a, b] = await freeSlots(ctx, SERVICE.sosa, 2, 4);       // Cardiología
    const [c] = await freeSlots(ctx, SERVICE.jimenez, 1, 6);       // Pediatría
    const [d] = await freeSlots(ctx, SERVICE.taveras, 1, 8);       // Cardiología (otro médico)
    const ap1 = await book(ctx, t1, a!.slot_id);
    await book(ctx, t2, c!.slot_id);
    const ap3 = await book(ctx, t3, d!.slot_id);
    // cancelar ap1 y reprogramar ap3 al slot b
    const x = (await prepare(ctx, t1, { kind: 'cancellation', appointment_id: ap1.id, expected_version: 1 })).json();
    await confirm(ctx, t1, x.intent_id, x.token);
    const y = (await prepare(ctx, t3, { kind: 'reschedule', appointment_id: ap3.id, expected_version: 1, new_slot_id: b!.slot_id })).json();
    await confirm(ctx, t3, y.intent_id, y.token);
    // búsquedas: dos distintas del mismo paciente (deduplicación por filtros y ventana)
    const now = new Date().toISOString();
    const later = new Date(Date.now() + 7 * 86400_000).toISOString();
    await ctx.app.inject({ url: `${P}/availability?specialty_id=20000000-0000-4000-8000-000000000002&from=${now}&to=${later}`, headers: auth(t1) });
    await ctx.app.inject({ url: `${P}/availability?specialty_id=20000000-0000-4000-8000-000000000002&from=${now}&to=${later}`, headers: auth(t1) });
    await ctx.app.inject({ url: `${P}/availability?specialty_id=20000000-0000-4000-8000-000000000003&from=${now}&to=${later}`, headers: auth(t1) });

    const from = await localDate('now()');
    const to = await localDate(`now() + interval '31 days'`);
    const q = `from=${from}&to=${to}`;
    const sum = (await ctx.app.inject({ url: `${P}/stats/summary?${q}`, headers: adminHeaders(viewer) })).json();
    expect(sum.timezone).toBe(TZ);
    expect(sum.definitions.occupancy).toMatch(/occupied\/enabled/);
    expect(sum.data.operations).toEqual({ bookings: 3, cancellations: 1, reschedules: 1, advances: 0 });
    expect(sum.data.searches).toBe(2);
    expect(sum.data.agenda_by_status).toMatchObject({ booked: 2, cancelled: 1 });

    // Conciliación de la ocupación con una consulta SQL independiente (sin CTE del módulo)
    const ind = (await ctx.db.query(`
      SELECT count(*) FILTER (WHERE s.status = 'open')::int AS enabled,
             count(DISTINCT a.slot_id) FILTER (WHERE s.status = 'open')::int AS occupied
      FROM slots s LEFT JOIN appointments a ON a.slot_id = s.id AND a.status <> 'cancelled'
      WHERE s.starts_at >= ($1::date)::timestamp AT TIME ZONE '${TZ}' AND s.starts_at < ($2::date)::timestamp AT TIME ZONE '${TZ}'`, [from, to])).rows[0];
    expect(sum.data.occupancy.enabled).toBe(ind.enabled);
    expect(sum.data.occupancy.occupied).toBe(ind.occupied);
    expect(sum.data.occupancy.occupied).toBe(2);
    expect(sum.data.occupancy.rate).toBeCloseTo(2 / ind.enabled, 4);

    // Filtro por especialidad (Cardiología): 2 reservas, 1 cancelación, 1 reprogramación; 1 búsqueda atribuida
    const card = (await ctx.app.inject({ url: `${P}/stats/summary?${q}&specialty_id=20000000-0000-4000-8000-000000000002`, headers: adminHeaders(viewer) })).json();
    expect(card.data.operations).toEqual({ bookings: 2, cancellations: 1, reschedules: 1, advances: 0 });
    expect(card.data.searches).toBe(1);
    expect(card.data.occupancy.occupied).toBe(1);

    // La serie diaria suma lo mismo que el resumen y rellena días vacíos con 0
    const ts = (await ctx.app.inject({ url: `${P}/stats/timeseries?${q}`, headers: adminHeaders(viewer) })).json().data;
    expect(ts).toHaveLength(31);
    const total = (k: string) => ts.reduce((acc: number, d: Record<string, number>) => acc + d[k]!, 0);
    expect(total('bookings')).toBe(3);
    expect(total('cancellations')).toBe(1);
    expect(total('slots_enabled')).toBe(sum.data.occupancy.enabled);
    expect(total('slots_occupied')).toBe(sum.data.occupancy.occupied);

    // Por especialidad y por médico: la suma de grupos coincide con el total
    const sp = (await ctx.app.inject({ url: `${P}/stats/specialties?${q}`, headers: adminHeaders(viewer) })).json().data;
    expect(sp.reduce((acc: number, g: { bookings: number }) => acc + g.bookings, 0)).toBe(3);
    expect(sp.find((g: { name: string }) => g.name === 'Pediatría').bookings).toBe(1);
    const docs = (await ctx.app.inject({ url: `${P}/stats/doctors?${q}`, headers: adminHeaders(viewer) })).json().data;
    expect(docs).toHaveLength(6);
    expect(docs.reduce((acc: number, g: { slots_occupied: number }) => acc + g.slots_occupied, 0)).toBe(2);
    expect(docs.find((g: { name: string }) => g.name.startsWith('Dra. María Sosa')).bookings).toBe(1);
    expect(JSON.stringify(docs)).not.toMatch(/Ficticia|Ejemplo|Prueba/); // sin nombres de pacientes

    // Recuperación: a (cancelado) y d (reprogramado) liberados antes de su inicio; ninguno reocupado
    const off = (await ctx.app.inject({ url: `${P}/stats/offers?${q}`, headers: adminHeaders(viewer) })).json().data;
    expect(off.recovery).toEqual({ recovered_slots: 0, freed_eligible_slots: 2, rate: 0 });
    // Otro paciente reserva el slot cancelado → se recupera
    await book(ctx, await login(ctx, 4), a!.slot_id);
    const off2 = (await ctx.app.inject({ url: `${P}/stats/offers?${q}`, headers: adminHeaders(viewer) })).json().data;
    expect(off2.recovery).toEqual({ recovered_slots: 1, freed_eligible_slots: 2, rate: 0.5 });

    // Ocupación por franja: suma de buckets = total
    const occ = (await ctx.app.inject({ url: `${P}/stats/occupancy?${q}`, headers: adminHeaders(viewer) })).json().data;
    expect(occ.reduce((acc: number, x: { occupied: number }) => acc + x.occupied, 0)).toBe(3);
  });

  it('valida el intervalo de fechas', async () => {
    const r1 = await ctx.app.inject({ url: `${P}/stats/summary?from=2026-11-01&to=2026-10-01`, headers: adminHeaders(viewer) });
    expect(r1.json().error.code).toBe('invalid_range');
    const r2 = await ctx.app.inject({ url: `${P}/stats/summary?from=2026-01-01&to=2027-06-01`, headers: adminHeaders(viewer) });
    expect(r2.json().error.code).toBe('range_too_long');
  });
});

describe('operación: asistencia, traspasos, trabajos', () => {
  beforeEach(async () => { await resetAgenda(ctx); });

  async function pastAppointment() {
    // Cita ya iniciada: slot de ayer creado solo para la prueba
    const s = (await ctx.db.query(
      `INSERT INTO slots (doctor_service_id, doctor_id, starts_at, ends_at)
       VALUES ($1, '30000000-0000-4000-8000-000000000001', date_trunc('hour', now()) - interval '1 day' + interval '7 minutes',
               date_trunc('hour', now()) - interval '1 day' + interval '27 minutes')
       ON CONFLICT DO NOTHING RETURNING id`, [SERVICE.mendez])).rows[0]
      ?? (await ctx.db.query(`SELECT id FROM slots WHERE doctor_service_id = $1 AND starts_at < now() ORDER BY starts_at DESC LIMIT 1`, [SERVICE.mendez])).rows[0];
    const a = (await ctx.db.query(
      `INSERT INTO appointments (booking_reference, patient_id, slot_id, source_channel)
       VALUES ('SC-PASAD2', '60000000-0000-4000-8000-000000000009', $1, 'seed') RETURNING id, version`, [s.id])).rows[0];
    return a as { id: string; version: number };
  }

  it('asistencia: solo operator, tras el inicio, con versión e idempotencia; cuenta en estadísticas', async () => {
    const a = await pastAppointment();
    const mark = (s: AdminSession, key: string, body: object) => ctx.app.inject({ method: 'POST', url: `${P}/appointments/${a.id}/attendance`,
      headers: { ...adminHeaders(s), 'idempotency-key': key }, payload: body });
    expect((await mark(viewer, randomUUID(), { status: 'completed', expected_version: 1 })).statusCode).toBe(403);
    expect((await mark(operator, randomUUID(), { status: 'completed', expected_version: 9 })).json().error.code).toBe('appointment_version_mismatch');
    const key = randomUUID();
    const r1 = await mark(operator, key, { status: 'no_show', expected_version: 1 });
    const r2 = await mark(operator, key, { status: 'no_show', expected_version: 1 });
    expect(r1.json()).toEqual({ appointment_id: a.id, status: 'no_show', version: 2 });
    expect(r2.json()).toEqual(r1.json());
    expect(r2.headers['idempotent-replayed']).toBe('true');
    // Detalle con historial: operator lo ve (con la asistencia registrada); viewer no
    const det = await ctx.app.inject({ url: `${P}/admin/appointments/${a.id}`, headers: adminHeaders(operator) });
    expect(det.statusCode).toBe(200);
    expect(det.json()).toMatchObject({ id: a.id, status: 'no_show', version: 2, attendance_allowed: false });
    expect(det.json().events.at(-1)).toMatchObject({ type: 'no_show', status_before: 'booked', status_after: 'no_show', actor_type: 'operator' });
    expect(det.json().events.at(-1)).not.toHaveProperty('actor_id');
    expect((await ctx.app.inject({ url: `${P}/admin/appointments/${a.id}`, headers: adminHeaders(viewer) })).statusCode).toBe(403);
    expect((await ctx.app.inject({ url: `${P}/admin/appointments/00000000-0000-4000-8000-000000000000`, headers: adminHeaders(operator) })).statusCode).toBe(404);
    const from = await localDate(`now() - interval '2 days'`);
    const to = await localDate(`now() + interval '1 day'`);
    const sum = (await ctx.app.inject({ url: `${P}/stats/summary?from=${from}&to=${to}`, headers: adminHeaders(viewer) })).json();
    expect(sum.data.attendance).toMatchObject({ completed: 0, no_show: 1, rate: 0 });
  });

  it('una cita futura no admite asistencia', async () => {
    const [s] = await freeSlots(ctx, SERVICE.pena, 1, 2);
    const ap = await book(ctx, await login(ctx, 5), s!.slot_id);
    const r = await ctx.app.inject({ method: 'POST', url: `${P}/appointments/${ap.id}/attendance`,
      headers: { ...adminHeaders(operator), 'idempotency-key': randomUUID() }, payload: { status: 'completed', expected_version: 1 } });
    expect(r.json().error.code).toBe('appointment_not_started');
  });

  it('solicitud de ayuda: detalle con contexto, nota al resolver y aviso al paciente (una sola vez)', async () => {
    const t = await login(ctx, 7);
    const send = (payload: object) => ctx.app.inject({ method: 'POST', url: `${P}/conversation/messages`, headers: auth(t),
      payload: { client_message_id: randomUUID(), ...payload } });
    await send({ action: { type: 'menu', item: 'my_appointments' } });
    await send({ action: { type: 'menu', item: 'handoff' } });
    const h = (await ctx.app.inject({ url: `${P}/handoffs?status=open`, headers: adminHeaders(operator) })).json().items[0];
    expect(h.patient_notified).toBe(false);
    expect((await ctx.app.inject({ url: `${P}/handoffs/${h.id}`, headers: adminHeaders(viewer) })).statusCode).toBe(403);
    const det = (await ctx.app.inject({ url: `${P}/handoffs/${h.id}`, headers: adminHeaders(operator) })).json();
    expect(det.messages.length).toBeGreaterThan(0);
    expect(det.messages.at(-1).text).toContain(h.reference);
    expect(Array.isArray(det.appointments)).toBe(true);

    const note = 'Llamé al paciente y movimos su cita al martes.';
    const r = await ctx.app.inject({ method: 'PATCH', url: `${P}/handoffs/${h.id}`, headers: adminHeaders(operator), payload: { status: 'resolved', note } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ status: 'resolved', resolution_note: note, patient_notified: true });
    expect(r.json().resolved_by).toBeTruthy();
    const inbox = (await ctx.app.inject({ url: `${P}/notifications`, headers: auth(t) })).json();
    const avisos = inbox.items.filter((n: { kind: string }) => n.kind === 'handoff_update');
    expect(avisos).toHaveLength(1);
    expect(avisos[0].body).toContain(note);
    expect(avisos[0].body).toContain(h.reference);
    // Resolverla otra vez no cambia la nota ni repite el aviso
    const again = await ctx.app.inject({ method: 'PATCH', url: `${P}/handoffs/${h.id}`, headers: adminHeaders(operator), payload: { status: 'resolved', note: 'otra' } });
    expect(again.json().resolution_note).toBe(note);
    expect((await ctx.app.inject({ url: `${P}/notifications`, headers: auth(t) })).json().items
      .filter((n: { kind: string }) => n.kind === 'handoff_update')).toHaveLength(1);

    // Sin aviso: se resuelve, queda constancia y el paciente no recibe nada
    await send({ action: { type: 'menu', item: 'handoff' } });
    const h2 = (await ctx.app.inject({ url: `${P}/handoffs?status=open`, headers: adminHeaders(operator) })).json().items[0];
    const quiet = await ctx.app.inject({ method: 'PATCH', url: `${P}/handoffs/${h2.id}`, headers: adminHeaders(operator),
      payload: { status: 'resolved', notify_patient: false } });
    expect(quiet.json()).toMatchObject({ status: 'resolved', resolution_note: null, patient_notified: false });
    expect((await ctx.app.inject({ url: `${P}/notifications`, headers: auth(t) })).json().items
      .filter((n: { kind: string }) => n.kind === 'handoff_update')).toHaveLength(1);
  });

  it('traspasos: listar y resolver; trabajos: listar y reintentar solo dead', async () => {
    const t = await login(ctx, 6);
    await ctx.app.inject({ method: 'POST', url: `${P}/conversation/messages`, headers: auth(t),
      payload: { client_message_id: randomUUID(), action: { type: 'menu', item: 'handoff' } } });
    const list = (await ctx.app.inject({ url: `${P}/handoffs?status=open`, headers: adminHeaders(operator) })).json().items;
    expect(list[0].reference).toMatch(/^AY-/);
    const res = await ctx.app.inject({ method: 'PATCH', url: `${P}/handoffs/${list[0].id}`, headers: adminHeaders(operator), payload: { status: 'resolved' } });
    expect(res.json().status).toBe('resolved');

    const [s] = await freeSlots(ctx, SERVICE.ortega, 1, 3);
    await book(ctx, t, s!.slot_id);
    const job = (await ctx.db.query(`SELECT id FROM outbox_jobs WHERE kind = 'calendar.sync' LIMIT 1`)).rows[0];
    const notDead = await ctx.app.inject({ method: 'POST', url: `${P}/admin/jobs/${job.id}/retry`, headers: adminHeaders(admin) });
    expect(notDead.json().error.code).toBe('job_not_dead');
    await ctx.db.query(`UPDATE outbox_jobs SET status = 'dead', attempts = 5, last_error = 'simulado' WHERE id = $1`, [job.id]);
    const dead = (await ctx.app.inject({ url: `${P}/admin/jobs?status=dead`, headers: adminHeaders(admin) })).json().items;
    expect(dead.map((j: { id: string }) => j.id)).toContain(job.id);
    expect(JSON.stringify(dead)).not.toContain('payload');
    const retry = await ctx.app.inject({ method: 'POST', url: `${P}/admin/jobs/${job.id}/retry`, headers: adminHeaders(admin) });
    expect(retry.json().status).toBe('pending');
  });

  it('integraciones: informa calendario pendiente de credenciales y modelo inalcanzable sin simular éxito', async () => {
    const r = (await ctx.app.inject({ url: `${P}/admin/integrations`, headers: adminHeaders(admin) })).json();
    expect(r.calendar.status).toBe('pending_credentials');
    expect(r.model.status).toBe('unreachable'); // en pruebas OLLAMA_URL apunta a un host inexistente
    expect(JSON.stringify(r)).not.toMatch(/svc_|password|token/i);
  });
});

describe('panel servido desde el mismo origen', () => {
  it('sirve /panel/ con CSP restrictiva y redirige la raíz', async () => {
    const { buildApp } = await import('../../src/app.js');
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    // Compilación mínima del panel en un directorio temporal: la prueba no depende de un `npm run build` previo
    const panelDir = mkdtempSync(join(tmpdir(), 'panel-'));
    writeFileSync(join(panelDir, 'index.html'), '<!doctype html><title>SaludCita AI · Panel</title><div id="root"></div>');
    const app = await buildApp({ databaseUrl: 'postgres://unused', port: 0, logLevel: 'silent',
      businessTimezone: 'America/Santo_Domingo', intentTtlSeconds: 600, patientSessionTtlHours: 12, corsAllowedOrigins: [], dbPoolMax: 2,
      ollamaUrl: 'http://x', ollamaModel: 'x', llmTimeoutMs: 1000, conversationLeaseSeconds: 60, adminSessionTtlHours: 8, cookieSecure: false,
      panelDir }, ctx.pool, { logger: false });
    const r = await app.inject({ url: '/panel/' });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toMatch(/text\/html/);
    expect(r.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(r.headers['content-security-policy']).toContain("connect-src 'self'");
    expect(r.body).not.toMatch(/svc_|adm_|SEED_|password/);
    expect((await app.inject({ url: '/' })).headers.location).toBe('/panel/');
    expect((await app.inject({ url: '/api/v1/health/live' })).headers['cache-control']).toBe('no-store');
    await app.close();
  });
});
