import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { P, SERVICE, auth, confirm, freeSlots, prepare, setupApp, teardown, type Ctx } from '../helpers/app.js';
import { TEST_GATEWAY_SECRET, TEST_SERVICE_SECRET } from '../helpers/env.js';
import { normalizeRecoveryCode } from '../../src/modules/guest/service.js';

let ctx: Ctx;
const GW = auth(`svc_${TEST_GATEWAY_SECRET}`);
beforeAll(async () => { ctx = await setupApp(); });
afterAll(async () => { await teardown(ctx); });

let ipSeq = 0;
const ip = () => `198.51.100.${++ipSeq}`;
async function guest() {
  const r = await ctx.app.inject({ method: 'POST', url: `${P}/gateway/guest-sessions`, headers: GW, payload: { client_ip: ip() } });
  expect(r.statusCode).toBe(200);
  return r.json() as { token: string; patient: { id: string; kind: string; profile_complete: boolean } };
}
const redeem = (code: string, clientIp = ip()) =>
  ctx.app.inject({ method: 'POST', url: `${P}/gateway/recover`, headers: GW, payload: { code, client_ip: clientIp } });

describe('sesión invitada (sin registro previo)', () => {
  it('solo la pasarela crea sesiones; un paciente o un anónimo no', async () => {
    const g = await guest();
    expect(g.patient.kind).toBe('guest');
    expect(g.patient.profile_complete).toBe(false);
    expect((await ctx.app.inject({ method: 'POST', url: `${P}/gateway/guest-sessions`, headers: auth(g.token), payload: { client_ip: ip() } })).statusCode).toBe(403);
    expect((await ctx.app.inject({ method: 'POST', url: `${P}/gateway/guest-sessions`, payload: { client_ip: ip() } })).statusCode).toBe(401);
    expect((await ctx.app.inject({ method: 'POST', url: `${P}/gateway/guest-sessions`, headers: auth(`svc_${TEST_SERVICE_SECRET}`), payload: { client_ip: ip() } })).statusCode).toBe(403);
  });

  it('reserva sin registro: pide perfil mínimo, luego reserva; otro invitado no ve la cita', async () => {
    const g = await guest();
    const [s] = await freeSlots(ctx, SERVICE.mendez, 1, 70);
    const p1 = await prepare(ctx, g.token, { kind: 'booking', slot_id: s!.slot_id });
    expect(p1.statusCode).toBe(409);
    expect(p1.json().error).toMatchObject({ code: 'profile_required', details: { missing: ['full_name', 'birth_date', 'contact'] } });
    await ctx.app.inject({ method: 'PATCH', url: `${P}/patients/me`, headers: auth(g.token), payload: { full_name: 'Invitada Ficticia', birth_date: '1990-02-03', email: 'invitada@correo.example' } });
    const p2 = (await prepare(ctx, g.token, { kind: 'booking', slot_id: s!.slot_id })).json();
    const c = await confirm(ctx, g.token, p2.intent_id, p2.token);
    expect(c.statusCode).toBe(200);
    const other = await guest();
    expect((await ctx.app.inject({ url: `${P}/appointments/${c.json().appointment.id}`, headers: auth(other.token) })).statusCode).toBe(404);
    expect((await ctx.app.inject({ url: `${P}/appointments?scope=all`, headers: auth(other.token) })).json().items).toHaveLength(0);
  });

  it('una sesión caducada o revocada deja de valer', async () => {
    const g = await guest();
    await ctx.db.query(`UPDATE patient_sessions SET expires_at = now() - interval '1 second' WHERE patient_id = $1`, [g.patient.id]);
    expect((await ctx.app.inject({ url: `${P}/patient-auth/me`, headers: auth(g.token) })).statusCode).toBe(401);
    const h = await guest();
    await ctx.app.inject({ method: 'POST', url: `${P}/patient-auth/logout`, headers: auth(h.token) });
    expect((await ctx.app.inject({ url: `${P}/patient-auth/me`, headers: auth(h.token) })).statusCode).toBe(401);
  });
});

describe('recuperación desde otro dispositivo', () => {
  it('código de alta entropía: se muestra una vez, se guarda como hash, se canjea una vez y rota', async () => {
    const g = await guest();
    const st0 = (await ctx.app.inject({ url: `${P}/patient-auth/recovery-code`, headers: auth(g.token) })).json();
    expect(st0.active).toBe(false);
    const gen = await ctx.app.inject({ method: 'POST', url: `${P}/patient-auth/recovery-code`, headers: auth(g.token) });
    expect(gen.headers['cache-control']).toBe('no-store');
    const code = gen.json().recovery_code as string;
    expect(code).toMatch(/^SCR(-[A-HJ-NP-Z2-9]{5}){5}$/);
    // Solo el hash en la base
    const stored = (await ctx.db.query(`SELECT encode(code_hash, 'hex') h FROM patient_recovery_codes WHERE patient_id = $1`, [g.patient.id])).rows[0].h;
    expect(stored).not.toContain(code);
    expect(JSON.stringify((await ctx.app.inject({ url: `${P}/patient-auth/recovery-code`, headers: auth(g.token) })).json())).not.toContain(code.slice(4));

    // Otro dispositivo: escribe el código en minúsculas y con espacios
    const r = await redeem(code.toLowerCase().replace(/-/g, ' '));
    expect(r.statusCode).toBe(200);
    const dev2 = r.json();
    expect(dev2.patient.id).toBe(g.patient.id);
    expect(dev2.new_recovery_code).not.toBe(code);
    expect((await ctx.app.inject({ url: `${P}/patient-auth/me`, headers: auth(dev2.token) })).json().patient.id).toBe(g.patient.id);
    // El código usado ya no vale; el nuevo sí
    expect((await redeem(code)).statusCode).toBe(401);
    expect((await redeem(dev2.new_recovery_code)).statusCode).toBe(200);
  });

  it('rotar o revocar invalida el anterior; caducado no vale; formato inválido da el mismo error', async () => {
    const g = await guest();
    const c1 = (await ctx.app.inject({ method: 'POST', url: `${P}/patient-auth/recovery-code`, headers: auth(g.token) })).json().recovery_code;
    const c2 = (await ctx.app.inject({ method: 'POST', url: `${P}/patient-auth/recovery-code`, headers: auth(g.token) })).json().recovery_code;
    expect((await redeem(c1)).json().error.code).toBe('invalid_recovery_code');
    await ctx.db.query(`UPDATE patient_recovery_codes SET created_at = now() - interval '2 days', expires_at = now() - interval '1 second' WHERE patient_id = $1 AND revoked_at IS NULL`, [g.patient.id]);
    expect((await redeem(c2)).statusCode).toBe(401);
    const c3 = (await ctx.app.inject({ method: 'POST', url: `${P}/patient-auth/recovery-code`, headers: auth(g.token) })).json().recovery_code;
    await ctx.app.inject({ method: 'DELETE', url: `${P}/patient-auth/recovery-code`, headers: auth(g.token) });
    expect((await redeem(c3)).statusCode).toBe(401);
    expect((await redeem('SCR-12345-0OOII-XYZ')).json().error.code).toBe('invalid_recovery_code');
    expect(normalizeRecoveryCode('scr aaaaa bbbbb ccccc ddddd eeeee')).toBe('SCR-AAAAA-BBBBB-CCCCC-DDDDD-EEEEE');
  });

  it('límite de intentos de canje por IP del visitante', async () => {
    const attacker = ip();
    const codes = [];
    for (let i = 0; i < 6; i++) codes.push((await redeem('SCR-AAAAA-AAAAA-AAAAA-AAAAA-AAAAA', attacker)).statusCode);
    expect(codes.slice(0, 5).every((c) => c === 401)).toBe(true);
    expect(codes[5]).toBe(429);
  });

  it('nombre, fecha de nacimiento o referencia de cita no sirven como credencial', async () => {
    const r = await ctx.app.inject({ method: 'POST', url: `${P}/gateway/recover`, headers: GW,
      payload: { code: 'Rosa Elena Ficticia 1985-03-14', client_ip: ip() } });
    expect(r.statusCode).toBe(401);
  });

  it('cerrar otras sesiones revoca los demás dispositivos', async () => {
    const g = await guest();
    const code = (await ctx.app.inject({ method: 'POST', url: `${P}/patient-auth/recovery-code`, headers: auth(g.token) })).json().recovery_code;
    const dev2 = (await redeem(code)).json();
    const r = (await ctx.app.inject({ method: 'POST', url: `${P}/patient-auth/sessions/revoke-others`, headers: auth(dev2.token) })).json();
    expect(r.revoked_sessions).toBe(1);
    expect((await ctx.app.inject({ url: `${P}/patient-auth/me`, headers: auth(g.token) })).statusCode).toBe(401);
    expect((await ctx.app.inject({ url: `${P}/patient-auth/me`, headers: auth(dev2.token) })).statusCode).toBe(200);
  });

  it('con fecha de nacimiento registrada, el canje exige que coincida; si no, error genérico y el código sigue vigente', async () => {
    const g = await guest();
    await ctx.app.inject({ method: 'PATCH', url: `${P}/patients/me`, headers: auth(g.token), payload: { full_name: 'Prueba Ficticia', birth_date: '1990-05-17' } });
    const code = (await ctx.app.inject({ method: 'POST', url: `${P}/patient-auth/recovery-code`, headers: auth(g.token) })).json().recovery_code;
    const call = (birth_date?: string) => ctx.app.inject({ method: 'POST', url: `${P}/gateway/recover`, headers: GW,
      payload: { code, client_ip: ip(), ...(birth_date ? { birth_date } : {}) } });
    const wrong = await call('1991-05-17');
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json().error.code).toBe('invalid_recovery_code');
    expect((await call()).statusCode).toBe(401);   // sin fecha tampoco
    expect((await call('1990-05-17')).statusCode).toBe(200);  // el código no se consumió con los fallos
  });

  it('tras 5 fechas de nacimiento incorrectas el código se invalida (aunque luego llegue la correcta)', async () => {
    const g = await guest();
    await ctx.app.inject({ method: 'PATCH', url: `${P}/patients/me`, headers: auth(g.token), payload: { full_name: 'Bloqueo Ficticio', birth_date: '1985-01-02' } });
    const code = (await ctx.app.inject({ method: 'POST', url: `${P}/patient-auth/recovery-code`, headers: auth(g.token) })).json().recovery_code;
    for (let i = 0; i < 5; i++) {
      const r = await ctx.app.inject({ method: 'POST', url: `${P}/gateway/recover`, headers: GW, payload: { code, birth_date: '1999-09-09', client_ip: ip() } });
      expect(r.statusCode).toBe(401);
    }
    const ok = await ctx.app.inject({ method: 'POST', url: `${P}/gateway/recover`, headers: GW, payload: { code, birth_date: '1985-01-02', client_ip: ip() } });
    expect(ok.statusCode).toBe(401);
    expect(ok.json().error.code).toBe('invalid_recovery_code');
    const row = (await ctx.db.query(`SELECT revoke_reason, failed_attempts FROM patient_recovery_codes WHERE patient_id = $1`, [g.patient.id])).rows[0];
    expect(row).toEqual({ revoke_reason: 'too_many_attempts', failed_attempts: 5 });
  });

  it('un código de recuperación escrito en el chat no se guarda en el historial ni llega a n8n o al modelo', async () => {
    const g = await guest();
    const code = 'SCR-ABCDE-FGHJK-LMNPQ-RSTVW-XYZ23';
    const r = await ctx.app.inject({ method: 'POST', url: `${P}/conversation/messages`, headers: auth(g.token),
      payload: { client_message_id: crypto.randomUUID(), text: `mi código es ${code}`, reply_to: { role: 'assistant', text: `código ${code.toLowerCase()}` } } });
    expect(r.statusCode).toBe(202);
    const dump = JSON.stringify((await ctx.db.query(
      `SELECT m.content, m.payload, u.payload AS up FROM messages m JOIN inbound_updates u ON u.id = m.update_id WHERE u.patient_id = $1`, [g.patient.id])).rows);
    expect(dump).toContain('código de recuperación oculto');
    expect(dump.toUpperCase()).not.toContain('ABCDE-FGHJK');
  });
});

