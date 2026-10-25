// Capa 1 (conversación generada), idioma y retomar una gestión. La salida del modelo se SIMULA:
// se verifican enrutamiento, estado, validación, localización y que la charla nunca modifica datos.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { P, auth, login, resetAgenda, setupApp, teardown, type Ctx } from '../helpers/app.js';
import { TEST_SERVICE_SECRET } from '../helpers/env.js';
import { validateConverse } from '../../src/modules/conversation/converse.js';

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
async function say(t: string, text: string) {
  const r = await ctx.app.inject({ method: 'POST', url: `${P}/conversation/messages`, headers: auth(t), payload: { client_message_id: randomUUID(), text } });
  expect(r.statusCode).toBe(202);
  return r.json().update_id as string;
}
const act = async (t: string, action: object) => (await ctx.app.inject({ method: 'POST', url: `${P}/conversation/messages`, headers: auth(t),
  payload: { client_message_id: randomUUID(), action } })).json().reply;
/** Simula a n8n: interpreta con JSON fijo y, si la API pide conversación, entrega el texto «generado». */
async function turn(t: string, text: string, intent: Record<string, unknown>, generated?: string | null) {
  const u = await say(t, text);
  const c = (await ctx.app.inject({ method: 'POST', url: `${P}/internal/updates/claim`, headers: SVC, payload: { update_id: u } })).json().items[0];
  const a = (await ctx.app.inject({ method: 'POST', url: `${P}/internal/updates/${u}/ack`, headers: SVC,
    payload: { lease_token: c.lease_token, llm: { ok: true, content: interp(intent), model: 'simulado' } } })).json();
  if (a.status !== 'drafting') return { ack: a, reply: a.reply, update: u };
  const d = (await ctx.app.inject({ method: 'POST', url: `${P}/internal/updates/${u}/draft`, headers: SVC,
    payload: { lease_token: c.lease_token, llm: generated === null ? { ok: false, error: 'timeout' } : { ok: true, content: JSON.stringify({ text: generated }), model: 'simulado' } } })).json();
  return { ack: a, reply: d.reply, update: u };
}
const stateOf = async (u: string) => (await ctx.db.query(`SELECT cv.state FROM conversations cv JOIN inbound_updates u ON u.conversation_id = cv.id WHERE u.id = $1`, [u])).rows[0].state;

describe('capa 1: conversación general generada', () => {
  it('charla: pide conversación al modelo con la guía del servicio; el texto generado se muestra y no cambia la agenda', async () => {
    const t = await login(ctx, 15);
    const { ack, reply, update } = await turn(t, '¿cómo estás? hoy tuve un día pesado', { intent: 'chat' }, '¡Lamento que tu día haya sido pesado! Aquí estoy para lo que necesites.');
    expect(ack.status).toBe('drafting');
    expect(ack.prompt_version).toBe('converse-v3');
    expect(ack.decision.capa).toBe('1 · conversación general');
    const sys = ack.llm.body.messages[0].content as string;
    expect(sys).toContain('hospital SIMULADO');          // guía documentada (capa 2)
    expect(sys).toContain('Cardiología');                 // catálogo real
    // Saludo según la hora local del hospital y sin responder preguntas que no se hicieron
    expect(sys).toMatch(/Hora actual en el hospital \(Santo Domingo\): \d{2}:\d{2}\. Si es oportuno saludar .*usa el saludo de esa hora: «(Buenos días|Buenas tardes|Buenas noches)»/);
    expect(sys).toContain('no digas «gracias por preguntar» ni contestes preguntas que no hizo');
    expect(sys).toContain('No vuelvas a presentarte, no repitas tu nombre ni el saludo de bienvenida');
    expect(sys).not.toContain('Muy bien, gracias por preguntar. ¿Y tú qué tal? Si necesitas algo');
    expect(reply.text).toBe('¡Lamento que tu día haya sido pesado! Aquí estoy para lo que necesites.');
    expect((await stateOf(update)).step).toBe('idle');
    expect((await ctx.db.query(`SELECT count(*)::int n FROM appointments`)).rows[0].n).toBe(0);
  });

  it('cambiar de tema con una cita a medio elegir: se conserva la gestión y «Continuar con mi cita» la retoma', async () => {
    const t = await login(ctx, 14);
    const r1 = await turn(t, 'quiero cita de cardiología', { intent: 'book', specialty: 'Cardiología' });
    expect(r1.reply.options.length).toBeGreaterThan(0);
    const r2 = await turn(t, 'por cierto, ¿qué tal el clima?', { intent: 'chat' }, 'No tengo datos del clima, lo siento. Cuando quieras seguimos con tu horario de Cardiología.');
    expect(r2.ack.llm.body.messages[0].content).toContain('estaba eligiendo un horario de Cardiología');
    expect(r2.reply.suggestions.map((s: { label: string }) => s.label)).toContain('Continuar con mi cita');
    expect((await stateOf(r2.update)).step).toBe('choosing_slot');
    const back = await act(t, { type: 'resume' });
    expect(back.options.map((o: { slot_id: string }) => o.slot_id)).toEqual(r1.reply.options.map((o: { slot_id: string }) => o.slot_id));
  });

  it('una propuesta pendiente NO se confirma por conversación libre («sí, confírmala ya» en charla)', async () => {
    const t = await login(ctx, 13);
    await turn(t, 'quiero cita de pediatría', { intent: 'book', specialty: 'Pediatría' });
    const p = await turn(t, 'la primera', { intent: 'select_option', option_number: 1 });
    expect(p.reply.proposal.kind).toBe('booking');
    await turn(t, 'jaja qué bueno, gracias', { intent: 'chat' }, '¡Con gusto! Cuando quieras confirma con el botón.');
    const f = await turn(t, 'confírmala ya', { intent: 'affirm' });
    expect(f.reply.text).toMatch(/botón «Confirmar»/);
    expect((await ctx.db.query(`SELECT count(*)::int n FROM appointments`)).rows[0].n).toBe(0);
  });

  it('texto generado no verificable (hora, operación, medicamento, otro idioma) → texto verificado', async () => {
    const t = await login(ctx, 12);
    for (const bad of ['Te reservé la cita para el martes a las 9:00.', 'Toma 400 mg de ibuprofeno.', 'Hello! How can I help you today with your appointments?']) {
      const { reply, update } = await turn(t, 'hola, ¿qué tal todo por allá?', { intent: 'chat' }, bad);
      expect(reply.text).not.toBe(bad);
      const st = (await ctx.db.query(`SELECT result FROM inbound_updates WHERE id = $1`, [update])).rows[0].result;
      expect(st.draft.ok).toBe(false);
    }
  });

  it('pregunta clínica: frase empática FIJA + aviso de seguridad verificado (9-1-1), sin segunda llamada al modelo', async () => {
    // converse-v2: la frase empática generada por el modelo pequeño prometía «resolverlo»; ahora es texto verificado
    const t = await login(ctx, 11);
    const { ack, reply } = await turn(t, 'me siento muy mal, tengo fiebre', { intent: 'clinical_question' }, 'Te ayudaré a resolverlo.');
    expect(ack.status).not.toBe('drafting');
    expect(reply.text).toMatch(/^Lamento que te sientas así\. No puedo darte orientación médica/);
    expect(reply.text).toContain('9-1-1');
    expect(reply.text).not.toContain('resolverlo');
  });

  it('si el modelo no responde, se usa el texto verificado (no se inventa nada)', async () => {
    const t = await login(ctx, 10);
    const { reply } = await turn(t, 'hola', { intent: 'greeting' }, null);
    expect(reply.text).toMatch(/Puedo ayudarte a reservar/);
    expect(reply.text).not.toMatch(/Soy Salu/);             // no se vuelve a presentar: la bienvenida ya lo hizo
  });
});

describe('aclaración ante mensajes vagos', () => {
  it('«eso de lo mío del otro día» → aclaración con opciones concretas aunque el modelo diga «chat»', async () => {
    const t = await login(ctx, 6);
    const { ack, reply } = await turn(t, 'eso de lo mío del otro día', { intent: 'chat' });
    expect(ack.status).toBe('drafting');                         // también la aclaración la redacta el modelo (con respaldo)
    expect(reply.clarification).toBe(true);
    expect(reply.suggestions.length).toBeGreaterThanOrEqual(3);
  });
});

describe('idioma de la conversación', () => {
  it('inglés: respuesta de agenda con plantillas verificadas (fechas, nombres y referencias intactos)', async () => {
    const t = await login(ctx, 9);
    const { reply, update } = await turn(t, 'Hi, I need an appointment with a cardiologist please', { intent: 'book', specialty: 'Cardiología' });
    expect((await stateOf(update)).lang).toBe('en');
    expect(reply.text).toMatch(/^These are the available times for the next 14 days:/);
    expect(reply.text).toMatch(/Cardiology with Dra?\. .+ \(fictitious\)/);
    expect(reply.options[0].label).toMatch(/^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), [A-Z][a-z]+ \d{1,2}, \d{4}, \d{1,2}:\d{2} (AM|PM)$/);
    const sel = await act(t, { type: 'select_option', index: 1 });
    expect(sel.text).toMatch(/^Book: Cardiology with /);
  });

  it('mensajes breves conservan el idioma; una petición explícita lo fija hasta otra petición', async () => {
    const t = await login(ctx, 8);
    const a = await turn(t, 'Hello, what can you do for me?', { intent: 'help' }, 'I can help you with your appointments.');
    expect((await stateOf(a.update)).lang).toBe('en');
    const b = await turn(t, 'ok', { intent: 'chat' }, 'Great!');
    expect((await stateOf(b.update)).lang).toBe('en');
    const c = await turn(t, 'respóndeme en español por favor', { intent: 'chat' }, '¡Claro! Seguimos en español.');
    expect((await stateOf(c.update))).toMatchObject({ lang: 'es', lang_locked: true });
    const d = await turn(t, 'I want to see my appointments please', { intent: 'list_appointments' });
    expect((await stateOf(d.update)).lang).toBe('es');             // fijado: no cambia hasta otra petición
    expect(d.reply.text).toMatch(/^No tienes citas próximas activas\./);
  });

  it('idioma sin plantillas verificadas (portugués): la charla la genera el modelo; la agenda se marca en español', async () => {
    const t = await login(ctx, 7);
    const a = await turn(t, 'Olá, tudo bem? Eu preciso de uma consulta', { intent: 'book' });
    expect((await stateOf(a.update)).lang).toBe('pt');
    const st = (await ctx.db.query(`SELECT result FROM inbound_updates WHERE id = $1`, [a.update])).rows[0].result;
    expect(st.lang_fallback).toBe(true);
  });
});

describe('validación del texto generado', () => {
  it.each([
    ['Tu cita quedó el lunes a las 10:30.', 'reply'], ['He reservado tu cita.', 'reply'], ['Toma paracetamol.', 'reply'],
    ['Busqué en internet y dice que sí.', 'reply'], ['¿Me das tu contraseña?', 'reply'], ['La Dra. Inventada te atiende.', 'reply'],
    ['Deberías tomar agua y descansar.', 'empathy'],
    ["I'm sorry to hear you're feeling unwell. Please rest and stay hydrated.", 'empathy'],
    ['Lo siento mucho. Espero que mejores pronto.', 'empathy'],
  ])('rechaza «%s» (%s)', (text, mode) => {
    expect(validateConverse(JSON.stringify({ text }), { mode: mode as 'reply', lang: 'es' }, ['Dra. María Sosa (ficticia)']).ok).toBe(false);
  });
  it('en una conversación en inglés no acepta una respuesta copiada de la guía en español', () => {
    expect(validateConverse(JSON.stringify({ text: 'Especialidades disponibles: Cardiología, Medicina Interna, Pediatría.' }), { mode: 'reply', lang: 'en' }).ok).toBe(false);
  });
  it('acepta citar palabras de otro idioma y mencionar el código de recuperación sin pedirlo', () => {
    expect(validateConverse(JSON.stringify({ text: 'En inglés se dice «thank you». ¿Seguimos con tu cita?' }), { mode: 'reply', lang: 'es' }).ok).toBe(true);
    expect(validateConverse(JSON.stringify({ text: 'Para volver a tus citas desde otro teléfono usa tu código de recuperación y tu fecha de nacimiento.' }), { mode: 'reply', lang: 'es' }).ok).toBe(true);
    expect(validateConverse(JSON.stringify({ text: 'Dame tu código de recuperación, por favor.' }), { mode: 'reply', lang: 'es' }).ok).toBe(false);
  });
  it('acepta conversación general natural y médicos del catálogo', () => {
    expect(validateConverse(JSON.stringify({ text: '¡Qué bueno saber de ti! La capital de Francia es París. ¿Te ayudo con algo más?' }), { mode: 'reply', lang: 'es' }).ok).toBe(true);
    expect(validateConverse(JSON.stringify({ text: 'La Dra. María Sosa atiende Cardiología.' }), { mode: 'reply', lang: 'es' }, ['Dra. María Sosa (ficticia)']).ok).toBe(true);
  });
});
