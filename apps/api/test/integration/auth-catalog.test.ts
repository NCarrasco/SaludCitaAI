import { TEST_GATEWAY_SECRET } from '../helpers/env.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { P, SERVICE, SPECIALTY, auth, freeSlots, login, setupApp, teardown, type Ctx } from '../helpers/app.js';

let ctx: Ctx;
beforeAll(async () => { ctx = await setupApp(); });
afterAll(async () => { await teardown(ctx); });

describe('salud', () => {
  it('live y ready sin autenticación', async () => {
    expect((await ctx.app.inject({ url: `${P}/health/live` })).json()).toEqual({ status: 'ok' });
    expect((await ctx.app.inject({ url: `${P}/health/ready` })).json()).toEqual({ status: 'ready' });
  });
});

describe('autenticación de pacientes', () => {
  it('rechaza credenciales incorrectas y usuarios inexistentes con el mismo error', async () => {
    const a = await ctx.app.inject({ method: 'POST', url: `${P}/patient-auth/login`, payload: { username: 'paciente02', password: 'incorrecta' } });
    const b = await ctx.app.inject({ method: 'POST', url: `${P}/patient-auth/login`, payload: { username: 'noexiste99', password: 'incorrecta' } });
    expect(a.statusCode).toBe(401);
    expect(b.statusCode).toBe(401);
    expect(a.json().error.code).toBe('invalid_credentials');
    expect(b.json().error.code).toBe('invalid_credentials');
    expect(a.json().request_id).toBeTruthy();
  });

  it('las rutas protegidas exigen token válido', async () => {
    expect((await ctx.app.inject({ url: `${P}/specialties` })).statusCode).toBe(401);
    expect((await ctx.app.inject({ url: `${P}/specialties`, headers: auth('pat_falso') })).statusCode).toBe(401);
  });

  it('me devuelve el paciente de la sesión y logout revoca el token', async () => {
    const r = await ctx.app.inject({ method: 'POST', url: `${P}/patient-auth/login`,
      payload: { username: 'PACIENTE03', password: 'clave-de-prueba-local' } });
    expect(r.statusCode).toBe(200);
    const token = r.json().token;
    const me = await ctx.app.inject({ url: `${P}/patient-auth/me`, headers: auth(token) });
    expect(me.json().patient.id).toBe('60000000-0000-4000-8000-000000000003');
    expect((await ctx.app.inject({ method: 'POST', url: `${P}/patient-auth/logout`, headers: auth(token) })).statusCode).toBe(204);
    expect((await ctx.app.inject({ url: `${P}/patient-auth/me`, headers: auth(token) })).statusCode).toBe(401);
  });

  it('limita los intentos de login por IP y usuario', async () => {
    let last = 0;
    for (let i = 0; i < 11; i++) {
      last = (await ctx.app.inject({ method: 'POST', url: `${P}/patient-auth/login`,
        payload: { username: 'paciente20', password: 'incorrecta' } })).statusCode;
    }
    expect(last).toBe(429);
  });
});

describe('perfil', () => {
  it('no acepta patient_id en el cuerpo ni fechas futuras', async () => {
    const t = await login(ctx, 4);
    const r1 = await ctx.app.inject({ method: 'PATCH', url: `${P}/patients/me`, headers: auth(t),
      payload: { patient_id: '60000000-0000-4000-8000-000000000001', full_name: 'Intruso' } });
    expect(r1.statusCode).toBe(400);
    const r2 = await ctx.app.inject({ method: 'PATCH', url: `${P}/patients/me`, headers: auth(t), payload: { birth_date: '2999-01-01' } });
    expect(r2.statusCode).toBe(400);
    const r3 = await ctx.app.inject({ method: 'PATCH', url: `${P}/patients/me`, headers: auth(t), payload: { full_name: 'Andrés Simulado Reyes' } });
    expect(r3.statusCode).toBe(200);
    expect(r3.json().patient.id).toBe('60000000-0000-4000-8000-000000000004');
  });

  it('contacto: teléfono o correo válidos; los datos ficticios del seed ya traen teléfono', async () => {
    const t = await login(ctx, 5);
    const patch = (payload: object) => ctx.app.inject({ method: 'PATCH', url: `${P}/patients/me`, headers: auth(t), payload });
    expect((await ctx.app.inject({ url: `${P}/patient-auth/me`, headers: auth(t) })).json().patient).toMatchObject({ phone: '(809) 555-1005', profile_complete: true });
    expect((await patch({ phone: '12' })).json().error.code).toBe('invalid_phone');
    expect((await patch({ email: 'no-es-correo' })).json().error.code).toBe('invalid_email');
    const ok = (await patch({ phone: ' +1 (829) 555-0100 ', email: 'Paciente@Correo.Example' })).json().patient;
    expect(ok).toMatchObject({ phone: '+1 (829) 555-0100', email: 'paciente@correo.example' });
    expect((await patch({ email: '' })).json().patient.email).toBeNull();
  });

  it('para reservar hace falta UN contacto (teléfono o correo)', async () => {
    const g = await ctx.app.inject({ method: 'POST', url: `${P}/gateway/guest-sessions`, headers: auth(`svc_${TEST_GATEWAY_SECRET}`), payload: { client_ip: '198.51.100.77' } });
    const t = g.json().token as string;
    await ctx.app.inject({ method: 'PATCH', url: `${P}/patients/me`, headers: auth(t), payload: { full_name: 'Sin Contacto', birth_date: '1990-01-01' } });
    const me = (await ctx.app.inject({ url: `${P}/patient-auth/me`, headers: auth(t) })).json().patient;
    expect(me.profile_complete).toBe(false);
    await ctx.app.inject({ method: 'PATCH', url: `${P}/patients/me`, headers: auth(t), payload: { email: 'sin.contacto@correo.example' } });
    expect((await ctx.app.inject({ url: `${P}/patient-auth/me`, headers: auth(t) })).json().patient.profile_complete).toBe(true);
  });
});

describe('catálogos y disponibilidad', () => {
  it('lista 3 especialidades y 6 médicos ficticios', async () => {
    const t = await login(ctx, 1);
    expect((await ctx.app.inject({ url: `${P}/specialties`, headers: auth(t) })).json().items).toHaveLength(3);
    const docs = (await ctx.app.inject({ url: `${P}/doctors?specialty_id=${SPECIALTY.cardio}`, headers: auth(t) })).json().items;
    expect(docs).toHaveLength(2);
    expect(docs[0].services[0].specialty.name).toBe('Cardiología');
  });

  it('exige filtro y valida el intervalo', async () => {
    const t = await login(ctx, 1);
    const from = new Date().toISOString();
    const to = new Date(Date.now() + 40 * 86400_000).toISOString();
    expect((await ctx.app.inject({ url: `${P}/availability?from=${from}&to=${from}`, headers: auth(t) })).json().error.code).toBe('filter_required');
    expect((await ctx.app.inject({ url: `${P}/availability?specialty_id=${SPECIALTY.cardio}&from=${to}&to=${from}`, headers: auth(t) })).json().error.code).toBe('invalid_range');
    expect((await ctx.app.inject({ url: `${P}/availability?specialty_id=${SPECIALTY.cardio}&from=${from}&to=${to}`, headers: auth(t) })).json().error.code).toBe('range_too_long');
  });

  it('devuelve solo slots futuros, con fecha completa y desplazamiento -04:00, paginados', async () => {
    const t = await login(ctx, 1);
    const from = new Date().toISOString();
    const to = new Date(Date.now() + 14 * 86400_000).toISOString();
    const r1 = await ctx.app.inject({ url: `${P}/availability?doctor_service_id=${SERVICE.sosa}&from=${from}&to=${to}&limit=3`, headers: auth(t) });
    const body = r1.json();
    expect(body.items).toHaveLength(3);
    for (const s of body.items) {
      expect(new Date(s.starts_at).getTime()).toBeGreaterThan(Date.now());
      expect(s.starts_at).toMatch(/-04:00$/);
      expect(s.label).toMatch(/\d{4}/);
    }
    expect(body.next_cursor).toBeTruthy();
    const r2 = await ctx.app.inject({ url: `${P}/availability?doctor_service_id=${SERVICE.sosa}&from=${from}&to=${to}&limit=3&cursor=${body.next_cursor}`, headers: auth(t) });
    expect(r2.json().items[0].slot_id).not.toBe(body.items[2].slot_id);
    expect(new Date(r2.json().items[0].starts_at) >= new Date(body.items[2].starts_at)).toBe(true);
  });

  it('respeta la ausencia del médico (excepción de agenda) y registra búsquedas deduplicadas', async () => {
    const exc = (await ctx.db.query(`SELECT starts_at, ends_at FROM schedule_exceptions WHERE id = '70000000-0000-4000-8000-000000000001'`)).rows[0];
    const t = await login(ctx, 1);
    const url = `${P}/availability?doctor_service_id=${SERVICE.pena}&from=${exc.starts_at.toISOString()}&to=${exc.ends_at.toISOString()}`;
    const before = (await ctx.db.query(`SELECT count(*)::int n FROM analytics_events WHERE event_type = 'availability_search'`)).rows[0].n;
    expect((await ctx.app.inject({ url, headers: auth(t) })).json().items).toHaveLength(0);
    await ctx.app.inject({ url, headers: auth(t) }); // misma búsqueda: no duplica el evento
    const after = (await ctx.db.query(`SELECT count(*)::int n FROM analytics_events WHERE event_type = 'availability_search'`)).rows[0].n;
    expect(after - before).toBe(1);
  });

  it('un slot bloqueado no aparece ni se puede preparar', async () => {
    const t = await login(ctx, 1);
    const [s] = await freeSlots(ctx, SERVICE.taveras, 1);
    await ctx.db.query(`UPDATE slots SET status = 'blocked' WHERE id = $1`, [s!.slot_id]);
    const r = await ctx.app.inject({ method: 'POST', url: `${P}/action-intents`, headers: auth(t), payload: { kind: 'booking', slot_id: s!.slot_id } });
    expect(r.statusCode).toBe(409);
    expect(r.json().error.details.reason).toBe('blocked');
    await ctx.db.query(`UPDATE slots SET status = 'open' WHERE id = $1`, [s!.slot_id]);
  });
});
