import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { P, SERVICE, adminHeaders, adminLogin, book, freeSlots, login, resetAgenda, setupApp, teardown, type AdminSession, type Ctx } from '../helpers/app.js';

let ctx: Ctx;
let admin: AdminSession;
let operator: AdminSession;
let viewer: AdminSession;
beforeAll(async () => {
  ctx = await setupApp();
  admin = await adminLogin(ctx, 'admin@saludcita.test');
  operator = await adminLogin(ctx, 'operador@saludcita.test');
  viewer = await adminLogin(ctx, 'panel@saludcita.test');
});
afterAll(async () => { await teardown(ctx); });
beforeEach(async () => { await resetAgenda(ctx); });

const req = (s: AdminSession, method: 'POST' | 'PATCH' | 'PUT' | 'DELETE' | 'GET', url: string, payload?: object) =>
  ctx.app.inject({ method, url: `${P}${url}`, headers: adminHeaders(s), ...(payload ? { payload } : {}) });
const DOCTOR_MENDEZ = '30000000-0000-4000-8000-000000000001';

describe('permisos de mantenimiento', () => {
  it('solo admin modifica catálogos; viewer y operator reciben 403; sin CSRF también 403', async () => {
    expect((await req(viewer, 'POST', '/admin/specialties', { name: 'Dermatología' })).statusCode).toBe(403);
    expect((await req(operator, 'POST', '/admin/specialties', { name: 'Dermatología' })).statusCode).toBe(403);
    const noCsrf = await ctx.app.inject({ method: 'POST', url: `${P}/admin/specialties`, headers: adminHeaders(admin, false), payload: { name: 'Dermatología' } });
    expect(noCsrf.statusCode).toBe(403);
    expect((await req(viewer, 'GET', '/admin/catalog')).statusCode).toBe(200);
    expect((await req(viewer, 'GET', '/admin/appointments?from=2026-01-01&to=2026-02-01')).statusCode).toBe(403);
  });
});

describe('catálogos: crear, editar, desactivar y auditar', () => {
  it('crea especialidad, rechaza duplicado (409) y registra auditoría', async () => {
    const name = `Dermatología ${Date.now()}`;
    const r = await req(admin, 'POST', '/admin/specialties', { name });
    expect(r.statusCode).toBe(200);
    expect((await req(admin, 'POST', '/admin/specialties', { name })).json().error.code).toBe('duplicate');
    const audit = await ctx.db.query(`SELECT action, entity FROM admin_audit_log WHERE entity_id = $1`, [r.json().item.id]);
    expect(audit.rows).toEqual([{ action: 'create', entity: 'specialty' }]);
  });

  it('desactivar un médico conserva sus citas, informa el impacto y bloquea nuevas reservas', async () => {
    const [s] = await freeSlots(ctx, SERVICE.mendez, 1, 30);
    const ap = await book(ctx, await login(ctx, 1), s!.slot_id);
    const dry = await req(admin, 'PATCH', `/admin/doctors/${DOCTOR_MENDEZ}?dry_run=true`, { active: false });
    expect(dry.json()).toMatchObject({ dry_run: true, impact: { future_booked_appointments: 1 } });
    expect((await ctx.db.query(`SELECT active FROM doctors WHERE id = $1`, [DOCTOR_MENDEZ])).rows[0].active).toBe(true);
    const real = await req(admin, 'PATCH', `/admin/doctors/${DOCTOR_MENDEZ}`, { active: false });
    expect(real.json().dry_run).toBe(false);
    expect((await ctx.db.query(`SELECT status FROM appointments WHERE id = $1`, [ap.id])).rows[0].status).toBe('booked');
    expect((await ctx.db.query(`SELECT count(*)::int n FROM reservable_slots WHERE doctor_id = $1`, [DOCTOR_MENDEZ])).rows[0].n).toBe(0);
    await req(admin, 'PATCH', `/admin/doctors/${DOCTOR_MENDEZ}`, { active: true });
  });

  it('valida zona horaria de centros', async () => {
    expect((await req(admin, 'POST', '/admin/centers', { name: 'Centro X', timezone: 'Marte/Olympus' })).json().error.code).toBe('invalid_timezone');
  });
});

describe('agenda: reglas y ausencias respetan las reservas', () => {
  it('un servicio nuevo con regla: dry_run no guarda nada; la regla real genera slots reservables', async () => {
    const doc = (await req(admin, 'POST', '/admin/doctors', { display_name: `Dra. Nueva ${Date.now()} (ficticia)` })).json().item;
    const svc = (await req(admin, 'POST', '/admin/doctor-services', { doctor_id: doc.id, center_id: '10000000-0000-4000-8000-000000000001',
      specialty_id: '20000000-0000-4000-8000-000000000001', consultation_kind: 'initial', slot_minutes: 30 })).json().item;
    const today = (await ctx.db.query(`SELECT to_char((now() AT TIME ZONE 'America/Santo_Domingo')::date, 'YYYY-MM-DD') d`)).rows[0].d;
    const body = { doctor_service_id: svc.id, weekday: 3, local_start: '09:00', local_end: '11:00', valid_from: today };
    const dry = (await req(admin, 'POST', '/admin/schedule-rules?dry_run=true', body)).json();
    expect(dry.dry_run).toBe(true);
    expect(dry.impact.generated_slots).toBeGreaterThan(0);
    expect((await ctx.db.query(`SELECT count(*)::int n FROM slots WHERE doctor_service_id = $1`, [svc.id])).rows[0].n).toBe(0);
    const real = (await req(admin, 'POST', '/admin/schedule-rules', body)).json();
    expect(real.impact.generated_slots).toBe(dry.impact.generated_slots);
    const n = (await ctx.db.query(`SELECT count(*)::int n FROM reservable_slots WHERE doctor_service_id = $1`, [svc.id])).rows[0].n;
    expect(n).toBeGreaterThan(0);
  });

  it('una ausencia bloquea slots libres y reporta la cita reservada como conflicto sin cancelarla; retirarla reabre', async () => {
    const [s] = await freeSlots(ctx, SERVICE.mendez, 1, 25);
    const ap = await book(ctx, await login(ctx, 2), s!.slot_id);
    const day = (await ctx.db.query(`SELECT (starts_at AT TIME ZONE 'America/Santo_Domingo')::date AS d FROM slots WHERE id = $1`, [s!.slot_id])).rows[0].d;
    const range = (await ctx.db.query(`SELECT ($1::date)::timestamp AT TIME ZONE 'America/Santo_Domingo' AS a, ($1::date + 1)::timestamp AT TIME ZONE 'America/Santo_Domingo' AS b`, [day])).rows[0];
    const body = { doctor_id: DOCTOR_MENDEZ, starts_at: range.a.toISOString(), ends_at: range.b.toISOString(), reason: 'absence' };
    const openBefore = (await ctx.db.query(`SELECT count(*)::int n FROM slots WHERE doctor_id = $1 AND status = 'open' AND starts_at >= $2 AND starts_at < $3`, [DOCTOR_MENDEZ, range.a, range.b])).rows[0].n;

    const r = (await req(admin, 'POST', '/admin/schedule-exceptions', body)).json();
    expect(r.impact.conflicts).toHaveLength(1);
    expect(r.impact.conflicts[0]).toMatchObject({ appointment_id: ap.id, reason: 'doctor_absence' });
    expect(r.impact.blocked_free_slots).toBe(openBefore - 1);
    expect((await ctx.db.query(`SELECT status, slot_id FROM appointments WHERE id = $1`, [ap.id])).rows[0]).toEqual({ status: 'booked', slot_id: s!.slot_id });

    const del = (await req(admin, 'DELETE', `/admin/schedule-exceptions/${r.item.id}`)).json();
    expect(del.impact.reopened_slots).toBe(openBefore - 1);
  });

  it('finalizar una regla bloquea los slots libres posteriores y no toca citas', async () => {
    const [s] = await freeSlots(ctx, SERVICE.sosa, 1, 20);
    const ap = await book(ctx, await login(ctx, 3), s!.slot_id);
    const rules = (await req(admin, 'GET', `/admin/doctor-services/${SERVICE.sosa}/schedule`)).json().rules;
    const wd = (await ctx.db.query(`SELECT extract(isodow FROM starts_at AT TIME ZONE 'America/Santo_Domingo')::int d,
      to_char((now() AT TIME ZONE 'America/Santo_Domingo')::date, 'YYYY-MM-DD') today FROM slots WHERE id = $1`, [s!.slot_id])).rows[0];
    const rule = rules.find((x: { weekday: number }) => x.weekday === wd.d);
    const dry = (await req(admin, 'PATCH', `/admin/schedule-rules/${rule.id}?dry_run=true`, { valid_until: wd.today })).json();
    expect(dry.impact.conflicts.map((c: { appointment_id: string }) => c.appointment_id)).toContain(ap.id);
    expect(dry.impact.blocked_free_slots).toBeGreaterThan(0);
    expect((await ctx.db.query(`SELECT valid_until FROM schedule_rules WHERE id = $1`, [rule.id])).rows[0].valid_until).toBeNull();
    expect((await req(admin, 'PATCH', `/admin/schedule-rules/${rule.id}`, { local_start: '12:00', local_end: '08:00' })).json().error.code).toBe('invalid_rule');
  });

  it('ausencia ya iniciada no se puede retirar', async () => {
    const id = (await ctx.db.query(`INSERT INTO schedule_exceptions (doctor_id, starts_at, ends_at, reason)
      VALUES ($1, now() - interval '1 hour', now() + interval '1 hour', 'other') RETURNING id`, [DOCTOR_MENDEZ])).rows[0].id;
    expect((await req(admin, 'DELETE', `/admin/schedule-exceptions/${id}`)).json().error.code).toBe('exception_started');
    await ctx.db.query(`DELETE FROM schedule_exceptions WHERE id = $1`, [id]);
  });
});

describe('búsqueda de citas (operator)', () => {
  it('filtra por referencia o nombre y marca si admite asistencia', async () => {
    const [s] = await freeSlots(ctx, SERVICE.jimenez, 1, 12);
    const ap = await book(ctx, await login(ctx, 11), s!.slot_id);
    const from = (await ctx.db.query(`SELECT to_char((now() AT TIME ZONE 'America/Santo_Domingo')::date, 'YYYY-MM-DD') d`)).rows[0].d;
    const to = (await ctx.db.query(`SELECT to_char((now() AT TIME ZONE 'America/Santo_Domingo')::date + 40, 'YYYY-MM-DD') d`)).rows[0].d;
    const byRef = (await req(operator, 'GET', `/admin/appointments?from=${from}&to=${to}&q=${ap.booking_reference.toLowerCase()}`)).json();
    expect(byRef.total).toBe(1);
    expect(byRef.items[0]).toMatchObject({ id: ap.id, attendance_allowed: false, patient: { full_name: 'Sofía Ficticia Mejía' } });
    const byName = (await req(operator, 'GET', `/admin/appointments?from=${from}&to=${to}&q=sofía ficticia`)).json();
    expect(byName.items.map((x: { id: string }) => x.id)).toContain(ap.id);
    // «Activas» excluye canceladas; los contadores por estado ignoran el filtro de estado
    await ctx.db.query(`UPDATE appointments SET status = 'cancelled', cancelled_at = now(), cancelled_by_type = 'operator' WHERE id = $1`, [ap.id]);
    const q = `from=${from}&to=${to}&q=${ap.booking_reference}`;
    const active = (await req(operator, 'GET', `/admin/appointments?${q}&status=active`)).json();
    expect(active.total).toBe(0);
    expect(active.counts).toMatchObject({ cancelled: 1, booked: 0 });
    const cancelled = (await req(operator, 'GET', `/admin/appointments?${q}&status=cancelled`)).json();
    expect(cancelled.items.map((x: { id: string }) => x.id)).toEqual([ap.id]);
  });
});

describe('vínculos de calendario por médico', () => {
  it('solo admin; valida el ID; al habilitar encola las citas futuras del médico y queda auditado', async () => {
    const DOC = '30000000-0000-4000-8000-000000000005'; // Jiménez
    const [s] = await freeSlots(ctx, SERVICE.jimenez, 1, 33);
    const ap = await book(ctx, await login(ctx, 12), s!.slot_id);
    const body = { external_calendar_id: 'pediatria-prueba@group.calendar.google.com', enabled: true };
    expect((await req(operator, 'PUT', `/admin/calendar-bindings/${DOC}`, body)).statusCode).toBe(403);
    expect((await req(admin, 'PUT', `/admin/calendar-bindings/${DOC}`, { ...body, external_calendar_id: 'no es un id' })).json().error.code)
      .toBe('invalid_calendar_id');
    const r = (await req(admin, 'PUT', `/admin/calendar-bindings/${DOC}`, body)).json();
    expect(r).toMatchObject({ enabled: true, requeued_appointments: 1 });
    expect((await ctx.db.query(`SELECT status FROM calendar_sync WHERE appointment_id = $1`, [ap.id])).rows[0].status).toBe('pending');
    expect((await ctx.db.query(`SELECT count(*)::int n FROM outbox_jobs WHERE aggregate_id = $1 AND kind = 'calendar.sync' AND status = 'pending'`, [ap.id])).rows[0].n)
      .toBeGreaterThanOrEqual(1);
    expect((await ctx.db.query(`SELECT action FROM admin_audit_log WHERE entity = 'calendar_binding' ORDER BY occurred_at DESC LIMIT 1`)).rows[0].action).toBe('enable');
    const list = (await req(admin, 'GET', '/admin/calendar-bindings')).json().items;
    expect(list.find((x: { doctor_id: string }) => x.doctor_id === DOC).enabled).toBe(true);
    await req(admin, 'PUT', `/admin/calendar-bindings/${DOC}`, { ...body, enabled: false });
  });
});

describe('datos institucionales que usa el asistente (centros y precios)', () => {
  const CENTER = '10000000-0000-4000-8000-000000000001';
  const SERVICE_SOSA = '40000000-0000-4000-8000-000000000003';
  const original = { phone: '(809) 555-0100', email: 'citas@hospital-simulado.example',
    accepted_insurers: ['ARS Ficticia Uno', 'ARS Ficticia Dos', 'Seguro Demo Plus'] };
  afterAll(async () => {
    await ctx.db.query(`UPDATE centers SET phone = $2, email = $3, accepted_insurers = $4 WHERE id = $1`,
      [CENTER, original.phone, original.email, original.accepted_insurers]);
    await ctx.db.query(`UPDATE doctor_services SET price_dop = 2500 WHERE id = $1`, [SERVICE_SOSA]);
  });

  it('el catálogo devuelve contacto, notas, seguros, pagos y precio', async () => {
    const c = (await req(viewer, 'GET', '/admin/catalog')).json();
    const center = c.centers.find((x: { id: string }) => x.id === CENTER);
    expect(center).toMatchObject({ phone: original.phone, email: original.email });
    expect(center.accepted_insurers).toContain('ARS Ficticia Uno');
    expect(c.services.find((x: { id: string }) => x.id === SERVICE_SOSA).price_dop).toBe(2500);
  });

  it('admin edita la ficha del centro y el precio; la vista previa del asistente lo refleja al momento', async () => {
    const r = await req(admin, 'PATCH', `/admin/centers/${CENTER}`, { phone: '(809) 555-0199', accepted_insurers: [' ARS Nueva ', 'ARS Nueva', ''] });
    expect(r.statusCode).toBe(200);
    expect(r.json().item.accepted_insurers).toEqual(['ARS Nueva']);           // recortado, sin vacíos ni repetidos
    expect((await req(admin, 'PATCH', `/admin/doctor-services/${SERVICE_SOSA}`, { price_dop: 2750 })).statusCode).toBe(200);
    const contact = (await req(viewer, 'GET', '/admin/service-info?topic=ubicacion_contacto')).json();
    expect(contact.text).toMatch(/Teléfono: \(809\) 555-0199/);
    const prices = (await req(viewer, 'GET', '/admin/service-info?topic=precios_seguros&specialty=Cardiolog%C3%ADa')).json();
    expect(prices.text).toMatch(/Cardiología: RD\$2[.,]?500–RD\$2[.,]?750/);   // dos médicos: rango
    expect(prices.text).toMatch(/ARS Nueva/);
    // Borrar el teléfono: el asistente reconoce que no consta
    await req(admin, 'PATCH', `/admin/centers/${CENTER}`, { phone: '' });
    expect((await req(viewer, 'GET', '/admin/service-info?topic=ubicacion_contacto')).json().text).toMatch(/No hay un teléfono registrado/);
  });

  it('valida correo, longitudes y permisos', async () => {
    expect((await req(admin, 'PATCH', `/admin/centers/${CENTER}`, { email: 'no-es-correo' })).statusCode).toBe(400);
    expect((await req(admin, 'PATCH', `/admin/doctor-services/${SERVICE_SOSA}`, { price_dop: -1 })).statusCode).toBe(400);
    expect((await req(operator, 'PATCH', `/admin/centers/${CENTER}`, { phone: '1' })).statusCode).toBe(403);
    expect((await req(viewer, 'GET', '/admin/service-info?topic=inventado')).statusCode).toBe(400);
  });
});

describe('horarios que anuncia el asistente', () => {
  it('una regla finalizada antes de la próxima fecha de su día no se anuncia; una vigente sí', async () => {
    const tz = 'America/Santo_Domingo';
    const { rows: [k] } = await ctx.db.query(`SELECT ce.id AS center, sp.id AS specialty,
        (extract(isodow FROM (now() AT TIME ZONE $1)::date + 1))::int AS manana, ((now() AT TIME ZONE $1)::date)::text AS hoy
      FROM centers ce, specialties sp WHERE sp.name = 'Cardiología' LIMIT 1`, [tz]);
    const svc = async (name: string, until: string) => {
      const d = (await ctx.db.query(`INSERT INTO doctors (display_name) VALUES ($1) RETURNING id`, [name])).rows[0].id;
      const s = (await ctx.db.query(`INSERT INTO doctor_services (doctor_id, center_id, specialty_id, consultation_kind, slot_minutes)
        VALUES ($1, $2, $3, 'initial', 30) RETURNING id`, [d, k.center, k.specialty])).rows[0].id;
      await ctx.db.query(`INSERT INTO schedule_rules (doctor_service_id, weekday, local_start, local_end, valid_from, valid_until)
        VALUES ($1, $2, '09:00', '12:00', $3::date, $3::date + $4::int)`, [s, k.manana, k.hoy, until === 'hoy' ? 0 : 7]);
      return s;
    };
    // Regla del día de mañana que termina hoy: ya no se aplicará nunca (el caso «domingos hasta el sábado»)
    const vencida = await svc('Dr. Regla Vencida (ficticio)', 'hoy');
    const vigente = await svc('Dra. Regla Vigente (ficticia)', 'semana');
    const text = (await req(viewer, 'GET', '/admin/service-info?topic=horarios&specialty=Cardiolog%C3%ADa')).json().text as string;
    expect(text).toContain('Regla Vigente');
    expect(text).not.toContain('Regla Vencida');
    const docs = (await req(viewer, 'GET', '/admin/service-info?topic=especialidades&specialty=Cardiolog%C3%ADa')).json().text as string;
    expect(docs).not.toMatch(/Regla Vencida[^\n]*(lun|mar|mi[eé]|jue|vie|s[aá]b|dom)/i);
    await ctx.db.query(`UPDATE doctor_services SET active = false WHERE id = ANY($1)`, [[vencida, vigente]]);
  });
});
