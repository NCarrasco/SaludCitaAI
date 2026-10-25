// Preguntas sobre DATOS respondidas en lenguaje natural: la API lee PostgreSQL, n8n pide la redacción al modelo con
// esos datos y la API valida que cada hora, cifra y médico del texto esté en los datos. La salida del modelo se SIMULA.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { P, auth, login, resetAgenda, setupApp, teardown, type Ctx } from '../helpers/app.js';
import { TEST_SERVICE_SECRET } from '../helpers/env.js';
import { validateGrounded } from '../../src/modules/conversation/converse.js';
import { genderOf } from '../../src/modules/conversation/engine.js';

let ctx: Ctx;
const SVC = auth(`svc_${TEST_SERVICE_SECRET}`);
beforeAll(async () => { ctx = await setupApp({ llmConverseEnabled: true }); });
afterAll(async () => { await teardown(ctx); });
beforeEach(async () => {
  await resetAgenda(ctx);
  await ctx.db.query(`TRUNCATE messages, inbound_updates, handoff_cases, conversations, channel_identities CASCADE`);
});

const interp = (o: Record<string, unknown>) => JSON.stringify({ intent: 'unknown', specialty: null, doctor: null, date_phrase: null,
  time_of_day: null, option_number: null, booking_reference: null, ...o });
async function turn(t: string, text: string, intent: Record<string, unknown>, generated: (body: any) => string | null) {
  const r = await ctx.app.inject({ method: 'POST', url: `${P}/conversation/messages`, headers: auth(t), payload: { client_message_id: randomUUID(), text } });
  const u = r.json().update_id as string;
  const c = (await ctx.app.inject({ method: 'POST', url: `${P}/internal/updates/claim`, headers: SVC, payload: { update_id: u } })).json().items[0];
  const a = (await ctx.app.inject({ method: 'POST', url: `${P}/internal/updates/${u}/ack`, headers: SVC,
    payload: { lease_token: c.lease_token, llm: { ok: true, content: interp(intent), model: 'simulado' } } })).json();
  if (a.status !== 'drafting') return { ack: a, reply: a.reply };
  const g = generated(a.llm.body);
  const d = (await ctx.app.inject({ method: 'POST', url: `${P}/internal/updates/${u}/draft`, headers: SVC,
    payload: { lease_token: c.lease_token, llm: g === null ? { ok: false, error: 'timeout' } : { ok: true, content: JSON.stringify({ text: g }), model: 'simulado' } } })).json();
  return { ack: a, reply: d.reply, draft: d };
}
const factsOf = (body: any) => String(body.messages[0].content).split('<<<DATOS')[1]!.split('DATOS>>>')[0]!;

describe('validación de respuestas con datos', () => {
  const facts = 'Médicos (ficticios):\n• Dr. José Taveras (ficticio) — Cardiología; próximo horario libre: martes, 27 de octubre de 2026, 8:00 a. m.; 12 libres en los próximos 7 días';
  const docs = ['Dr. José Taveras (ficticio)', 'Dra. María Sosa (ficticia)'];
  it('acepta una redacción natural fiel a los datos', () => {
    expect(validateGrounded(JSON.stringify({ text: 'El Dr. Taveras, de Cardiología, tiene libre el martes 27 de octubre a las 8:00 a. m. y 12 horarios esta semana.' }), 'es', facts, docs).ok).toBe(true);
  });
  it('rechaza horas, cifras o médicos que no están en los datos', () => {
    expect(validateGrounded(JSON.stringify({ text: 'El Dr. Taveras atiende a las 9:30 a. m.' }), 'es', facts, docs)).toMatchObject({ ok: false });
    expect(validateGrounded(JSON.stringify({ text: 'Hay 20 horarios libres.' }), 'es', facts, docs)).toMatchObject({ ok: false });
    expect(validateGrounded(JSON.stringify({ text: 'La Dra. Sosa está disponible.' }), 'es', facts, docs)).toMatchObject({ ok: false, reason: 'médico no presente en los datos' });
    expect(validateGrounded(JSON.stringify({ text: 'Listo, reservé tu cita con el Dr. Taveras.' }), 'es', facts, docs)).toMatchObject({ ok: false });
  });
  it('una propuesta pendiente no se presenta como cita hecha', () => {
    const f = 'Mensaje del sistema: Vas a reservar…\n\nPropuesta pendiente: lunes, 26 de octubre de 2026, 9:00 a. m. con Dra. María Sosa (ficticia). Solo se hace si pulsa «Confirmar».';
    expect(validateGrounded(JSON.stringify({ text: 'Tu próxima cita es con la Dra. Sosa el lunes 26 a las 9:00 a. m.' }), 'es', f, docs)).toMatchObject({ ok: false });
    expect(validateGrounded(JSON.stringify({ text: 'Tienes pendiente confirmar la cita con la Dra. Sosa el lunes 26 a las 9:00 a. m.: pulsa «Confirmar».' }), 'es', f, docs).ok).toBe(true);
  });
  it('responde en otro idioma con los mismos datos', () => {
    expect(validateGrounded(JSON.stringify({ text: 'Dr. Taveras (Cardiology) has a free slot on Tuesday, October 27 at 8:00 a. m.; there are 12 free slots this week.' }), 'en', facts, docs).ok).toBe(true);
  });
  it('sexo pedido en el texto', () => {
    expect(genderOf('¿qué médico masculino está disponible?')).toBe('male');
    expect(genderOf('quiero una doctora')).toBe('female');
    expect(genderOf('¿qué médicos hay?')).toBeNull();
  });
});

describe('consulta de médicos por n8n con redacción del modelo', () => {
  it('«¿qué médico hombre está disponible?» → solo médicos «Dr.» con su próximo horario libre real; texto redactado y validado', async () => {
    const t = await login(ctx, 4);
    const { ack, reply, draft } = await turn(t, '¿qué médico hombre está disponible?', { intent: 'book' }, (body) => {
      const f = factsOf(body);
      const first = f.split('\n').find((l) => l.startsWith('• '))!;
      const name = /• (Dr\. [^(]+?) \(/.exec(first)![1]!;
      return `Claro. ${name} tiene disponibilidad; ${first.split('; ').at(-2)}.`;
    });
    expect(ack.status).toBe('drafting');
    expect(ack.route ?? ack.decision?.ruta ?? 'informacion').toBeTruthy();
    const facts = factsOf(ack.llm.body);
    expect(facts).toContain('Médicos (ficticios) · hombres');
    expect(facts).not.toMatch(/Dra\./);
    // El próximo horario libre coincide con la vista de horarios reservables
    const real = (await ctx.db.query(`SELECT d.display_name, min(rs.starts_at) n FROM reservable_slots rs JOIN doctors d ON d.id = rs.doctor_id
      WHERE d.display_name LIKE 'Dr. %' GROUP BY 1`)).rows;
    for (const r of real) expect(facts).toContain(r.display_name);
    expect(draft.validacion.aceptada).toBe(true);
    expect(reply.generated).toBe(true);
    expect(reply).not.toHaveProperty('facts');                        // los datos internos no viajan al cliente
  });

  it('si el modelo inventa una hora, se muestra el texto verificado', async () => {
    const t = await login(ctx, 5);
    const { reply, draft } = await turn(t, '¿qué doctoras están disponibles?', { intent: 'chat' }, () => 'La Dra. Sosa atiende a las 6:15 p. m.');
    expect(draft.validacion.aceptada).toBe(false);
    expect(reply.text).toMatch(/^Médicos \(ficticios\) · mujeres:/);
  });
});
