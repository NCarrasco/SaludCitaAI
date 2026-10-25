// Panel en vivo: portada operativa (permisos y fechas) y eventos SSE tras cada commit (NOTIFY → una conexión LISTEN).
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { P, SERVICE, adminHeaders, adminLogin, answerOffer, book, confirm, freeSlots, login, prepare, resetAgenda, setupApp, teardown,
  type AdminSession, type Ctx } from '../helpers/app.js';

let ctx: Ctx;
let base: string;
let admin: AdminSession;
let operator: AdminSession;
let viewer: AdminSession;
beforeAll(async () => {
  ctx = await setupApp();
  base = await ctx.app.listen({ port: 0, host: '127.0.0.1' });
  admin = await adminLogin(ctx, 'admin@saludcita.test');
  operator = await adminLogin(ctx, 'operador@saludcita.test');
  viewer = await adminLogin(ctx, 'panel@saludcita.test');
});
afterAll(async () => { await teardown(ctx); });
beforeEach(async () => { await resetAgenda(ctx); });

const dash = async (s: AdminSession) => (await ctx.app.inject({ url: `${P}/admin/dashboard`, headers: adminHeaders(s, false) })).json();

/** Abre el flujo SSE y acumula los eventos recibidos. */
async function stream(s: AdminSession) {
  const ac = new AbortController();
  const res = await fetch(`${base}${P}/admin/events`, { headers: { cookie: s.cookie }, signal: ac.signal });
  const events: { event: string; data: any; t: number }[] = [];
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let closed = false;
  void (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          const ev = /^event: (.+)$/m.exec(block)?.[1];
          const data = /^data: (.+)$/m.exec(block)?.[1];
          if (ev) events.push({ event: ev, data: data ? JSON.parse(data) : null, t: Date.now() });
        }
      }
    } catch { /* abortado */ }
    closed = true;
  })();
  const waitFor = async (pred: (e: { event: string; data: any }) => boolean, ms = 3000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { const e = events.find(pred); if (e) return e; await new Promise((r) => setTimeout(r, 20)); }
    throw new Error(`evento no recibido en ${ms} ms: ${JSON.stringify(events.map((e) => e.event))}`);
  };
  return { res, events, waitFor, close: () => ac.abort(), isClosed: () => closed };
}

describe('portada operativa', () => {
  it('operator ve pacientes y referencias; viewer solo cifras agregadas (sin datos personales en ninguna parte)', async () => {
    const t = await login(ctx, 3);
    const [s] = await freeSlots(ctx, SERVICE.sosa, 1, 2);
    const ap = await book(ctx, t, s!.slot_id);
    const op = await dash(operator);
    expect(op.scope).toBe('full');
    expect(op.upcoming.some((x: { reference: string }) => x.reference === ap.booking_reference)).toBe(true);
    expect(op.activity[0]).toMatchObject({ kind: 'booked', reference: ap.booking_reference });
    const name = (await ctx.db.query(`SELECT full_name FROM patients p JOIN appointments a ON a.patient_id = p.id WHERE a.id = $1`, [ap.id])).rows[0].full_name;
    const v = await dash(viewer);
    expect(v.scope).toBe('aggregate');
    expect(v.upcoming).toBeUndefined();
    expect(v.agenda_today).toBeUndefined();
    const raw = JSON.stringify(v);
    expect(raw).not.toContain(ap.booking_reference);
    expect(raw).not.toContain(name);
    expect(raw).not.toContain(ap.id);
    expect(v.activity[0]).toEqual(expect.objectContaining({ kind: 'booked', specialty: expect.any(String) }));
  });

  it('una reserva creada hoy para otro día cuenta en «creadas hoy», no en la agenda de hoy', async () => {
    const before = await dash(operator);
    const t = await login(ctx, 4);
    const [s] = await freeSlots(ctx, SERVICE.sosa, 1, 5);
    await book(ctx, t, s!.slot_id);
    const after = await dash(operator);
    expect(after.kpis.operations_today.booked).toBe(before.kpis.operations_today.booked + 1);
    expect(after.kpis.today_total).toBe(before.kpis.today_total);
  });

  it('alerta accionable: asistencia sin registrar enlaza al listado filtrado', async () => {
    // Cita ya iniciada (slot de hace 2 horas creado solo para la prueba, como en las pruebas de asistencia)
    const s = (await ctx.db.query(
      `INSERT INTO slots (doctor_service_id, doctor_id, starts_at, ends_at)
       VALUES ($1, '30000000-0000-4000-8000-000000000001', date_trunc('hour', now()) - interval '2 hours' + interval '7 minutes',
               date_trunc('hour', now()) - interval '2 hours' + interval '27 minutes') ON CONFLICT DO NOTHING RETURNING id`, [SERVICE.mendez])).rows[0]
      ?? (await ctx.db.query(`SELECT id FROM slots WHERE doctor_service_id = $1 AND starts_at < now() ORDER BY starts_at DESC LIMIT 1`, [SERVICE.mendez])).rows[0];
    await ctx.db.query(`INSERT INTO appointments (booking_reference, patient_id, slot_id, source_channel)
                        VALUES ('SC-VIVOA2', '60000000-0000-4000-8000-000000000009', $1, 'seed')`, [s.id]);
    const d = await dash(operator);
    const a = d.alerts.find((x: { code: string }) => x.code === 'attendance_unmarked');
    expect(a.count).toBeGreaterThanOrEqual(1);
    expect(a.action).toMatchObject({ page: 'citas', params: { status: 'booked' } });
  });
});

describe('portada con fecha y filtros', () => {
  const q = async (s: AdminSession, params: string) => (await ctx.app.inject({ url: `${P}/admin/dashboard?${params}`, headers: adminHeaders(s, false) })).json();
  it('la fecha y los filtros acotan el día; próximas y actividad solo los filtros; alertas son de todo el hospital', async () => {
    const t = await login(ctx, 9);
    const [s] = await freeSlots(ctx, SERVICE.sosa, 1, 3);
    const ap = await book(ctx, t, s!.slot_id);
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Santo_Domingo' }).format(ap.slot ? new Date((await ctx.db.query(`SELECT starts_at FROM appointments WHERE id = $1`, [ap.id])).rows[0].starts_at) : new Date());
    const sosa = (await ctx.db.query(`SELECT doctor_id FROM doctor_services WHERE id = $1`, [SERVICE.sosa])).rows[0].doctor_id;
    const mendez = (await ctx.db.query(`SELECT doctor_id FROM doctor_services WHERE id = $1`, [SERVICE.mendez])).rows[0].doctor_id;
    const forSosa = await q(operator, `date=${day}&doctor_id=${sosa}`);
    expect(forSosa.date).toBe(day);
    expect(forSosa.agenda_today.some((x: { reference: string }) => x.reference === ap.booking_reference)).toBe(true);
    const forOther = await q(operator, `date=${day}&doctor_id=${mendez}`);
    expect(forOther.agenda_today.some((x: { reference: string }) => x.reference === ap.booking_reference)).toBe(false);
    expect(forOther.activity.some((x: { reference: string }) => x.reference === ap.booking_reference)).toBe(false);
    expect(forOther.upcoming.some((x: { reference: string }) => x.reference === ap.booking_reference)).toBe(false);
    expect(forOther.alerts).toEqual(forSosa.alerts);          // alertas: todo el hospital
    expect((await ctx.app.inject({ url: `${P}/admin/dashboard?date=2026-13-40`, headers: adminHeaders(operator, false) })).statusCode).toBe(400);
  });
});

describe('eventos en vivo (SSE)', () => {
  it('tras el commit de una reserva llega un aviso; operator recibe el id, viewer no', async () => {
    const so = await stream(operator);
    const sv = await stream(viewer);
    await so.waitFor((e) => e.event === 'hello');
    await sv.waitFor((e) => e.event === 'hello');
    const t = await login(ctx, 6);
    const [s] = await freeSlots(ctx, SERVICE.sosa, 1, 2);
    const t0 = Date.now();
    const ap = await book(ctx, t, s!.slot_id);
    const eo = await so.waitFor((e) => e.event === 'change' && e.data.topic === 'appointments' && e.data.kind === 'booked');
    expect(eo.data.id).toBe(ap.id);
    const ev = await sv.waitFor((e) => e.event === 'change' && e.data.topic === 'appointments');
    expect(ev.data.id).toBeUndefined();
    expect(Object.keys(ev.data).sort()).toEqual(['at', 'kind', 'topic']);
    expect((so.events.find((e) => e === eo) as { t: number }).t - t0).toBeLessThan(2000);
    so.close(); sv.close();
  });

  it('cancelación, adelanto y solicitudes de ayuda también avisan', async () => {
    const so = await stream(admin);
    await so.waitFor((e) => e.event === 'hello');
    const s = await freeSlots(ctx, SERVICE.taveras, 2, 6);
    const ta = await login(ctx, 7); const tb = await login(ctx, 8);
    const A = await book(ctx, ta, s[0]!.slot_id);
    const B = await book(ctx, tb, s[1]!.slot_id, { advance_opt_in: true });
    const p = (await prepare(ctx, ta, { kind: 'cancellation', appointment_id: A.id, expected_version: 1 })).json();
    expect((await confirm(ctx, ta, p.intent_id, p.token)).statusCode).toBe(200);
    await so.waitFor((e) => e.event === 'change' && e.data.kind === 'cancelled' && e.data.id === A.id);
    await so.waitFor((e) => e.event === 'change' && e.data.topic === 'offers' && e.data.id === B.id);
    const off = (await ctx.db.query(`SELECT id FROM advance_offers WHERE appointment_id = $1 AND status = 'pending'`, [B.id])).rows[0];
    expect((await answerOffer(ctx, tb, off.id, 'accept')).statusCode).toBe(200);
    await so.waitFor((e) => e.event === 'change' && e.data.kind === 'advanced' && e.data.id === B.id);
    const pid = (await ctx.db.query(`SELECT patient_id FROM appointments WHERE id = $1`, [A.id])).rows[0].patient_id;
    const h = (await ctx.db.query(`INSERT INTO handoff_cases (patient_id, reason, reference) VALUES ($1, 'prueba en vivo', $2) RETURNING id`,
      [pid, `AY-${randomUUID().replace(/[^A-HJ-NP-Z2-9]/gi, '').toUpperCase().slice(0, 6).padEnd(6, 'K')}`])).rows[0];
    await so.waitFor((e) => e.event === 'change' && e.data.topic === 'handoffs' && e.data.kind === 'open');
    await ctx.app.inject({ method: 'PATCH', url: `${P}/handoffs/${h.id}`, headers: adminHeaders(admin), payload: { status: 'resolved' } });
    await so.waitFor((e) => e.event === 'change' && e.data.topic === 'handoffs' && e.data.kind === 'resolved');
    so.close();
  });

  it('cerrar sesión termina la suscripción; sin sesión no hay flujo', async () => {
    const s = await adminLogin(ctx, 'operador@saludcita.test');
    const so = await stream(s);
    await so.waitFor((e) => e.event === 'hello');
    await ctx.app.inject({ method: 'POST', url: `${P}/auth/logout`, headers: adminHeaders(s) });
    await so.waitFor((e) => e.event === 'session-ended', 3000);
    const t0 = Date.now();
    while (!so.isClosed() && Date.now() - t0 < 2000) await new Promise((r) => setTimeout(r, 20));
    expect(so.isClosed()).toBe(true);
    expect((await fetch(`${base}${P}/admin/events`)).status).toBe(401);
  });

  it('limita las conexiones simultáneas por sesión', async () => {
    const streams = await Promise.all([1, 2, 3, 4].map(() => stream(viewer)));
    await Promise.all(streams.map((x) => x.waitFor((e) => e.event === 'hello')));
    expect((await fetch(`${base}${P}/admin/events`, { headers: { cookie: viewer.cookie } })).status).toBe(429);
    for (const x of streams) x.close();
  });
});

describe('atribución de búsquedas con filtros combinados', () => {
  it('una búsqueda solo por especialidad no se atribuye a un médico ni a un centro', async () => {
    const spec = (await ctx.db.query(`SELECT specialty_id, doctor_id, center_id FROM doctor_services WHERE id = $1`, [SERVICE.sosa])).rows[0];
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Santo_Domingo' }).format(new Date());
    const next = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Santo_Domingo' }).format(new Date(Date.now() + 86400_000));
    const q = (extra: string) => ctx.app.inject({ url: `${P}/stats/summary?from=${day}&to=${next}&specialty_id=${spec.specialty_id}${extra}`,
      headers: adminHeaders(viewer, false) }).then((r) => r.json().data.searches as number);
    const before = [await q(''), await q(`&doctor_id=${spec.doctor_id}`), await q(`&center_id=${spec.center_id}`)];
    const pid = (await ctx.db.query(`SELECT id FROM patients LIMIT 1`)).rows[0].id;
    await ctx.db.query(`INSERT INTO analytics_events (event_type, patient_id, doctor_service_id, dedupe_key, metadata)
                        VALUES ('availability_search', $1, NULL, $2, $3)`, [pid, `test:${randomUUID()}`, JSON.stringify({ specialty_id: spec.specialty_id })]);
    const after = [await q(''), await q(`&doctor_id=${spec.doctor_id}`), await q(`&center_id=${spec.center_id}`)];
    expect(after[0]).toBe(before[0]! + 1);   // filtro solo de especialidad: cuenta
    expect(after[1]).toBe(before[1]);        // con médico: no se puede atribuir
    expect(after[2]).toBe(before[2]);        // con centro: tampoco
  });
});
