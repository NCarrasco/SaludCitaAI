// Máquina de estados determinista de la conversación.
// Entrada: interpretación validada del modelo, fallo del modelo o acción de botón.
// Salida: nuevo estado y respuesta. Todos los horarios, citas y referencias salen de PostgreSQL.
// Nunca confirma operaciones: solo propone una acción que el paciente confirma con un botón.

import { localClock } from './clock.js';
import type { PoolClient } from '../../db/pool.js';
import { bookingReference } from '../../shared/crypto.js';
import { ApiError } from '../../shared/errors.js';
import { period } from '../../shared/text.js';
import { spanishLabel } from '../../shared/time.js';
import { type DayRange, type TimeOfDay, defaultRange, detectTimeOfDay, normalize, resolveDate } from './dates.js';
import { groundedDatePhrase, groundedTimeOfDay, hasCue, looksClinical, looksLikeBooking, ordinalInText, yesNo } from './grounding.js';
import type { InterpretationT } from './llm.js';
import { type ScheduleCard, type ServiceTopic, serviceInfo } from './service-info.js';

/**
 * Tema institucional del mensaje (información del servicio con datos verificados, nunca redactada por el modelo):
 * service_info → su tema (o «funciones» si no lo indicó); help → «funciones»; charla o saludo con tema institucional → ese tema.
 */
export function infoTopic(i: InterpretationT, text: string): ServiceTopic | null {
  const t = (i.service_topic ?? null) as ServiceTopic | null;
  if (i.intent === 'service_info') return t ?? 'funciones';
  // «ayuda» que alude a SUS citas («¿cuándo es mi cita?») no es información general: se aclara con sus citas
  if (i.intent === 'help') return t ?? (APPOINTMENT_CUES.some((w) => normalize(text).includes(w)) || VAGUE_CUES.test(normalize(text)) ? null : 'funciones');
  if ((i.intent === 'chat' || i.intent === 'greeting') && t) return t;
  return null;
}

export type Mode = 'ai' | 'deterministic' | 'fallback_menu' | 'system';

export interface SlotOption { index: number; slot_id: string; label: string; doctor: string; specialty: string; starts_at: string }
export interface AppointmentChoice { appointment_id: string; label: string }

export type Proposal =
  | { kind: 'booking'; slot_id: string; summary: string }
  | { kind: 'cancellation'; appointment_id: string; expected_version: number; summary: string }
  | { kind: 'reschedule'; appointment_id: string; expected_version: number; new_slot_id: string; summary: string };

export interface ConvState {
  step: 'idle' | 'choosing_specialty' | 'clarifying_date' | 'choosing_slot' | 'awaiting_confirmation' | 'choosing_appointment';
  flow?: 'book' | 'cancel' | 'reschedule';
  specialty_id?: string;
  doctor_id?: string;
  doctor_service_id?: string;
  range?: DayRange;
  time_of_day?: TimeOfDay | null;
  date_choices?: DayRange[];
  options?: SlotOption[];
  after?: string;                 // inicio del último horario ofrecido, para «ver más»
  appointment_choices?: AppointmentChoice[];
  target_appointment_id?: string;
  target_version?: number;
  proposal?: Proposal;
  /** Idioma de la conversación y si lo fijó el paciente explícitamente («respóndeme en inglés») */
  lang?: string;
  lang_locked?: boolean;
  /** Turnos seguidos de conversación general (para no ofrecer citas en cada turno) */
  chat_streak?: number;
}

export interface Reply {
  text: string;
  /** Interno: respuesta social ya natural y verificada; no se pide redacción al modelo */
  no_draft?: boolean;
  /** Capa 1: la respuesta la genera el modelo (reply) o se antepone una frase empática (empathy); el texto es el respaldo verificado */
  converse?: 'reply' | 'empathy' | 'grounded';
  /** Interno (no se envía al cliente): datos verificados para la redacción «grounded» */
  facts?: string;
  topic?: 'chat' | 'service_info' | 'greeting' | 'help' | 'clinical_question';
  /** Gestión en curso que el paciente puede retomar tras cambiar de tema */
  pending?: string;
  mode: Mode;
  options?: SlotOption[];
  more_options?: boolean;
  change_specialty?: boolean;   // reserva: la lista de horarios ofrece volver a elegir especialidad
  date_choices?: { index: number; label: string }[];
  specialty_choices?: { id: string; name: string }[];
  appointment_choices?: AppointmentChoice[];
  proposal?: Proposal;
  menu?: boolean;
  handoff_reference?: string;
  /** Acciones concretas propuestas cuando la intención es incierta */
  suggestions?: { label: string; action: Action }[];
  /** true si la respuesta pide aclaración (se mide aparte del éxito directo) */
  clarification?: boolean;
  /** El texto ya está en este idioma (información institucional con plantillas verificadas): no se traduce */
  prelocalized?: 'es' | 'en';
  /** Tema institucional respondido con datos verificados */
  service_topic?: ServiceTopic;
  /** Horario estructurado (tema horarios) para la tarjeta del chat */
  schedule?: ScheduleCard;
}

export type Action =
  | { type: 'menu'; item: 'book' | 'my_appointments' | 'cancel' | 'reschedule' | 'handoff' | 'help' }
  | { type: 'choose_specialty'; specialty_id: string }
  | { type: 'choose_date'; index: number }
  | { type: 'select_option'; index: number }
  | { type: 'more_options' }
  | { type: 'choose_appointment'; appointment_id: string }
  | { type: 'intent_result'; intent_id: string }
  | { type: 'discard_proposal' }
  | { type: 'resume' }
  | { type: 'book_with'; specialty_id?: string; doctor_id?: string; date_from?: string; date_to?: string; date_label?: string;
      time_of_day?: 'morning' | 'afternoon' };

export type EngineEvent =
  | { type: 'interpretation'; text: string; interp: InterpretationT }
  | { type: 'llm_failed'; text: string; error: string }
  | { type: 'action'; action: Action };

export interface EngineCtx {
  c: PoolClient;
  patientId: string;
  conversationId: string;
  updateId: string;
  tz: string;
  now: Date;
}

const OPTIONS_PER_TURN = 3;


const NO_WAITLIST = 'Por ahora no tenemos lista de espera para personas sin cita.';

export const INITIAL_STATE: ConvState = { step: 'idle' };

/** La referencia de cita solo cuenta si aparece literalmente en el mensaje. */
function groundedReference(ref: string | null, text: string): string | null {
  return ref && text.toUpperCase().includes(ref) ? ref : null;
}

// ---------------------------------------------------------------------------
// Catálogo y consultas (todo desde PostgreSQL)
// ---------------------------------------------------------------------------

interface Specialty { id: string; name: string }
interface DoctorRef { id: string; name: string; specialty_id: string }

async function loadCatalog(c: PoolClient): Promise<{ specialties: Specialty[]; doctors: DoctorRef[] }> {
  const s = await c.query(
    `SELECT DISTINCT sp.id, sp.name FROM specialties sp JOIN doctor_services ds ON ds.specialty_id = sp.id AND ds.active
     JOIN doctors d ON d.id = ds.doctor_id AND d.active WHERE sp.active ORDER BY sp.name`);
  const d = await c.query(
    `SELECT d.id, d.display_name AS name, ds.specialty_id FROM doctors d JOIN doctor_services ds ON ds.doctor_id = d.id AND ds.active
     WHERE d.active ORDER BY d.display_name`);
  return { specialties: s.rows, doctors: d.rows };
}

export async function specialtyNames(c: PoolClient): Promise<string[]> {
  return (await loadCatalog(c)).specialties.map((s) => s.name);
}

// Sinónimos administrativos (no clínicos) para emparejar texto libre con el catálogo
const SPECIALTY_SYNONYMS: Record<string, string[]> = {
  'medicina interna': ['medicina interna', 'internista', 'medico internista', 'medicina general', 'medico general', 'interna', 'internal medicine', 'internist', 'general practitioner'],
  cardiologia: ['cardiologia', 'cardiologo', 'cardiologa', 'corazon', 'cardio', 'cardiology', 'cardiologist', 'cardiologists', 'heart'],
  pediatria: ['pediatria', 'pediatra', 'nino', 'nina', 'hijo', 'hija', 'bebe', 'infantil', 'pediatrics', 'pediatrician', 'pediatricians', 'child', 'kid'],
};

export function matchSpecialty(text: string | null | undefined, specialties: Specialty[]): Specialty | undefined {
  if (!text) return undefined;
  for (const sp of specialties) {
    const key = normalize(sp.name);
    if (hasCue(text, SPECIALTY_SYNONYMS[key] ?? [key])) return sp;
  }
  return undefined;
}

function matchDoctor(text: string | null | undefined, doctors: DoctorRef[]): DoctorRef | undefined {
  if (!text) return undefined;
  const t = normalize(text);
  return doctors.find((d) => {
    const surname = normalize(d.name).replace(/\(.*\)/, '').replace(/^(dra?\.?)\s+/, '').split(' ').filter((w) => w.length > 3);
    return surname.some((w) => new RegExp(`\\b${w}\\b`).test(t));
  });
}

async function searchSlots(ctx: EngineCtx, s: ConvState, range: DayRange): Promise<SlotOption[]> {
  const r = await ctx.c.query(
    `SELECT rs.slot_id, rs.starts_at, d.display_name AS doctor, sp.name AS specialty
     FROM reservable_slots rs
     JOIN doctors d ON d.id = rs.doctor_id
     JOIN specialties sp ON sp.id = rs.specialty_id
     JOIN centers c ON c.id = rs.center_id
     WHERE rs.starts_at >= ($1::date)::timestamp AT TIME ZONE c.timezone
       AND rs.starts_at <  ($2::date)::timestamp AT TIME ZONE c.timezone
       AND ($3::uuid IS NULL OR rs.specialty_id = $3)
       AND ($4::uuid IS NULL OR rs.doctor_id = $4)
       AND ($5::uuid IS NULL OR rs.doctor_service_id = $5)
       AND ($6::text IS NULL OR ($6 = 'morning' AND extract(hour FROM rs.starts_at AT TIME ZONE c.timezone) < 12)
                             OR ($6 = 'afternoon' AND extract(hour FROM rs.starts_at AT TIME ZONE c.timezone) >= 12))
       AND ($7::timestamptz IS NULL OR rs.starts_at > $7)
       AND NOT EXISTS (SELECT 1 FROM appointments a WHERE a.patient_id = $8 AND a.status = 'booked'
                       AND tstzrange(a.starts_at, a.ends_at) && tstzrange(rs.starts_at, rs.ends_at))
     ORDER BY rs.starts_at, rs.slot_id
     LIMIT $9`,
    [range.from, range.to, s.specialty_id ?? null, s.doctor_id ?? null, s.doctor_service_id ?? null,
     s.time_of_day ?? null, s.after ?? null, ctx.patientId, OPTIONS_PER_TURN]);
  await ctx.c.query(
    `INSERT INTO analytics_events (event_type, patient_id, doctor_service_id, dedupe_key, metadata)
     VALUES ('availability_search', $1, $2, $3, $4) ON CONFLICT (dedupe_key) DO NOTHING`,
    [ctx.patientId, s.doctor_service_id ?? null, `search:conv:${ctx.updateId}:${range.from}:${s.after ?? ''}`,
     JSON.stringify({ source: 'conversation', specialty_id: s.specialty_id ?? null, results_first_page: r.rows.length })]);
  return r.rows.map((x, i) => ({
    index: i + 1, slot_id: x.slot_id, label: spanishLabel(x.starts_at, ctx.tz), doctor: x.doctor,
    specialty: x.specialty, starts_at: x.starts_at.toISOString(),
  }));
}

async function upcomingAppointments(ctx: EngineCtx) {
  const r = await ctx.c.query(
    `SELECT a.id, a.version, a.booking_reference, a.starts_at, a.slot_id, s.doctor_service_id, d.display_name AS doctor, sp.name AS specialty
     FROM appointments a JOIN slots s ON s.id = a.slot_id JOIN doctors d ON d.id = s.doctor_id
     JOIN doctor_services ds ON ds.id = s.doctor_service_id JOIN specialties sp ON sp.id = ds.specialty_id
     WHERE a.patient_id = $1 AND a.status = 'booked' AND a.starts_at > now()
     ORDER BY a.starts_at LIMIT 10`, [ctx.patientId]);
  return r.rows.map((x) => ({
    id: x.id as string, version: x.version as number, reference: x.booking_reference as string,
    doctor_service_id: x.doctor_service_id as string,
    label: `${x.booking_reference} · ${x.specialty} con ${x.doctor} · ${spanishLabel(x.starts_at, ctx.tz)}`,
  }));
}

// ---------------------------------------------------------------------------
// Respuestas reutilizables
// ---------------------------------------------------------------------------

// Preguntas sobre quién atiende los horarios ofrecidos (texto normalizado, sin tildes)
const ABOUT_OFFERED = /\b(medic[oa]s?|doctor(a|es|as)?|especialista|quien (me )?(atiende|es|son)|con quien|which doctor|who is the doctor)\b/;

const MENU_TEXT = 'Puedo ayudarte a reservar, consultar, reprogramar o cancelar citas, o pasar tu solicitud al personal administrativo.';

/**
 * Respuestas sociales verificadas (sin modelo): saludo que refleja el del paciente, agradecimiento y despedida.
 * Son naturales y no contienen datos de agenda, así que no necesitan redacción por el modelo.
 */
function welcome(mode: Mode, text = '', tz = 'America/Santo_Domingo'): Reply {
  const t = normalize(text);
  if (/\b(gracias|thank|muchas gracias|te lo agradezco)\b/.test(t)) {
    return { mode, menu: true, text: '¡Con gusto! 😊 Si necesitas algo más con tus citas, aquí estoy.' };
  }
  if (/\b(adios|chao|chau|hasta luego|hasta pronto|nos vemos|bye)\b/.test(t)) {
    return { mode, menu: true, text: '¡Hasta pronto! 👋 Cuando quieras, escríbeme para reservar o revisar tus citas.' };
  }
  const hello = /\bbuenas noches\b/.test(t) ? '¡Buenas noches!' : /\bbuenas tardes\b/.test(t) ? '¡Buenas tardes!'
    : /\bbuen(os)? dias?\b/.test(t) ? '¡Buenos días!' : `¡${localClock(tz).greeting}!`;
  // Sin volver a presentarse: el chat ya mostró la bienvenida de Salu al abrirse
  return { mode, menu: true, text: `${hello} ${MENU_TEXT} ` +
    'Por ejemplo: «Quiero una cita de cardiología el martes por la mañana».' };
}

const VAGUE_CUES = /\b(lo mio|lo de|eso de|aquello|lo del otro dia|lo que te dije|la cosa|my thing|the thing|that thing|about my|lo meu|ma chose)\b/;

/** Aclaración con acciones concretas cuando el mensaje es demasiado vago para actuar o conversar. */
function vagueClarification(mode: Mode): [ConvState, Reply] {
  return [{ step: 'idle' }, { mode, clarification: true, menu: true,
    text: `No estoy seguro de haber entendido. ¿Te refieres a alguna de estas opciones? Elige una opción o escríbelo de otra forma.`,
    suggestions: [
      { label: 'Ver mis citas', action: { type: 'menu', item: 'my_appointments' } },
      { label: 'Reservar una cita', action: { type: 'menu', item: 'book' } },
      { label: 'Cambiar o cancelar una cita', action: { type: 'menu', item: 'reschedule' } },
      { label: 'Hablar con el personal', action: { type: 'menu', item: 'handoff' } },
    ] }];
}

/** Descripción (para el modelo) de una gestión en curso que el paciente puede retomar, o null. */
export function pendingSummary(s: ConvState): string | null {
  switch (s.step) {
    case 'choosing_slot': return `estaba eligiendo un horario de ${s.options?.[0]?.specialty ?? 'una especialidad'}`;
    case 'awaiting_confirmation': return `tenía pendiente confirmar: ${s.proposal?.summary ?? 'una operación'}`;
    case 'choosing_specialty': return 'estaba eligiendo la especialidad para una cita';
    case 'clarifying_date': return 'estaba eligiendo la fecha de una cita';
    case 'choosing_appointment': return `estaba eligiendo qué cita ${s.flow === 'cancel' ? 'cancelar' : 'cambiar'}`;
    default: return null;
  }
}

/** Capa 1: respuesta de conversación general. El estado de la cita NO cambia; si hay una gestión en curso se puede retomar. */
function conversational(s: ConvState, mode: Mode, topic: 'chat' | 'service_info' | 'greeting' | 'help', fallback: Reply): [ConvState, Reply] {
  const pending = pendingSummary(s);
  return [{ ...s, chat_streak: (s.chat_streak ?? 0) + 1 }, {
    ...fallback, mode, converse: 'reply', topic, menu: !pending,
    ...(pending ? { pending, suggestions: [{ label: 'Continuar con mi cita', action: { type: 'resume' } }] } : {}),
  }];
}

function optionsReply(mode: Mode, options: SlotOption[], intro: string, more: boolean, changeSpecialty = false): Reply {
  const lines = options.map((o) => `${o.index}. ${o.label} · ${o.specialty} con ${o.doctor}`);
  return { mode, options, more_options: more, ...(changeSpecialty ? { change_specialty: true } : {}), text: `${intro}\n${lines.join('\n')}\n\nElige un horario con su botón o escribe su número.` };
}

// ---------------------------------------------------------------------------
// Flujos
// ---------------------------------------------------------------------------

async function offerSlots(ctx: EngineCtx, s: ConvState, mode: Mode, opts: { more?: boolean } = {}): Promise<[ConvState, Reply]> {
  const range = s.range ?? defaultRange(ctx.now, ctx.tz);
  const next: ConvState = { ...s, range, after: opts.more ? s.after : undefined, proposal: undefined };
  let options = await searchSlots(ctx, next, range);
  let intro = `Estos son los horarios disponibles para ${range.label}${s.time_of_day ? (s.time_of_day === 'morning' ? ' por la mañana' : ' por la tarde') : ''}:`;

  if (options.length === 0 && !opts.more) {
    // Sin horarios en el intervalo pedido: buscar en los 14 días siguientes y decirlo explícitamente
    const widened: DayRange = { from: range.to, to: defaultRange(new Date(Date.parse(`${range.to}T12:00:00Z`)), 'UTC', 14).to,
                                label: 'los días siguientes' };
    options = await searchSlots(ctx, { ...next, time_of_day: null }, widened);
    if (options.length > 0) {
      intro = `No encontré horarios disponibles para ${range.label}. Los más próximos después de esa fecha son:`;
      next.range = widened;
      next.time_of_day = null;
    }
  }
  if (options.length === 0) {
    return [{ step: 'idle' }, { mode, menu: true, text: opts.more
      ? 'No hay más horarios disponibles en ese periodo. Puedes buscar otra fecha o pedir ayuda al personal.'
      : `No encontré horarios disponibles. ${NO_WAITLIST} Puedes probar otra fecha u otra especialidad, o pedir ayuda al personal administrativo.` }];
  }
  next.step = 'choosing_slot';
  next.options = options;
  next.after = options[options.length - 1]!.starts_at;
  return [next, optionsReply(mode, options, opts.more ? 'Más horarios disponibles:' : intro, options.length === OPTIONS_PER_TURN, next.flow === 'book')];
}

/** Últimos mensajes escritos por el paciente en esta conversación (sin el actual ni los botones), para respaldar contexto */
async function recentPatientText(ctx: EngineCtx): Promise<string> {
  const r = await ctx.c.query(
    `SELECT content FROM messages WHERE conversation_id = $1 AND direction = 'inbound' AND update_id IS DISTINCT FROM $2
       AND content NOT LIKE '[%' AND created_at > now() - interval '24 hours'
     ORDER BY created_at DESC LIMIT 6`, [ctx.conversationId, ctx.updateId]);
  return r.rows.map((x) => String(x.content)).join(' \n ');
}

async function startBooking(ctx: EngineCtx, s: ConvState, mode: Mode, p: {
  specialtyText?: string | null; doctorText?: string | null; dateText?: string | null; rawText?: string; timeOfDay?: TimeOfDay | null;
}): Promise<[ConvState, Reply]> {
  const cat = await loadCatalog(ctx.c);
  const raw = p.rawText ?? '';
  // El médico debe aparecer en el texto del paciente (no basta con que el modelo lo nombre)
  const doctor = raw ? matchDoctor(raw, cat.doctors) : matchDoctor(p.doctorText, cat.doctors);
  // Especialidad: la del texto; la del modelo solo si una pista la respalda en el texto o en los mensajes recientes del
  // paciente (continuaciones como «¿y si mejor voy el domingo?» tras «quiero llevar a mi hija al pediatra»)
  const fromModel = matchSpecialty(p.specialtyText, cat.specialties);
  const cues = fromModel ? SPECIALTY_SYNONYMS[normalize(fromModel.name)] ?? [] : [];
  const specialty = matchSpecialty(raw, cat.specialties)
    ?? (fromModel && (!raw || hasCue(raw, cues) || hasCue(await recentPatientText(ctx), cues)) ? fromModel : undefined)
    ?? (doctor ? cat.specialties.find((x) => x.id === doctor.specialty_id) : undefined)
    ?? (s.flow === 'book' && s.specialty_id ? cat.specialties.find((x) => x.id === s.specialty_id) : undefined);
  const next: ConvState = { step: 'idle', flow: 'book', specialty_id: specialty?.id, doctor_id: doctor?.id,
                            time_of_day: raw ? (groundedTimeOfDay(p.timeOfDay ?? null, raw) ?? detectTimeOfDay(raw)) : p.timeOfDay ?? null };

  // Fecha: se resuelve primero sobre el texto del paciente; la expresión del modelo solo si aquel no tiene fecha
  let res = raw ? resolveDate(raw, ctx.now, ctx.tz) : { kind: 'none' as const } as ReturnType<typeof resolveDate>;
  // Fecha del modelo solo si está anclada en el texto del paciente (sin texto, p. ej. botones, se usa tal cual)
  const dateText = p.rawText ? groundedDatePhrase(p.dateText, p.rawText) : p.dateText;
  if (res.kind === 'none' && dateText) res = resolveDate(dateText, ctx.now, ctx.tz);
  if (res.kind === 'past') {
    return [{ ...next, step: specialty ? 'idle' : 'choosing_specialty' },
      { mode, menu: !specialty, text: `El ${res.label} ya pasó. ¿Para qué otra fecha buscas la cita?` }];
  }
  if (res.kind === 'range') next.range = res.range;

  if (!specialty) {
    next.step = 'choosing_specialty';
    if (res.kind === 'ambiguous') next.date_choices = res.choices;
    return [next, { mode, clarification: true, specialty_choices: cat.specialties,
      text: `¿Para qué especialidad necesitas la cita? Disponibles: ${cat.specialties.map((x) => x.name).join(', ')}.` }];
  }
  if (res.kind === 'ambiguous') {
    next.step = 'clarifying_date';
    next.date_choices = res.choices;
    return [next, { mode, clarification: true, text: res.question, date_choices: res.choices.map((c, i) => ({ index: i + 1, label: c.label })) }];
  }
  return offerSlots(ctx, next, mode);
}

async function startAppointmentFlow(ctx: EngineCtx, flow: 'cancel' | 'reschedule', mode: Mode, p: {
  reference?: string | null; dateText?: string | null; timeOfDay?: TimeOfDay | null; rawText?: string;
}): Promise<[ConvState, Reply]> {
  const appts = await upcomingAppointments(ctx);
  if (appts.length === 0) {
    return [{ step: 'idle' }, { mode, menu: true, text: 'No tienes citas próximas activas.' }];
  }
  const byRef = p.reference ? appts.find((a) => a.reference === p.reference) : undefined;
  if (p.reference && !byRef) {
    return [{ step: 'choosing_appointment', flow, appointment_choices: appts.map((a) => ({ appointment_id: a.id, label: a.label })) },
      { mode, appointment_choices: appts.map((a) => ({ appointment_id: a.id, label: a.label })),
        text: `No encontré una cita activa tuya con la referencia ${p.reference}. ¿Cuál de estas quieres ${flow === 'cancel' ? 'cancelar' : 'cambiar'}?` }];
  }
  const target = byRef ?? (appts.length === 1 ? appts[0] : undefined);
  if (!target) {
    const choices = appts.map((a) => ({ appointment_id: a.id, label: a.label }));
    return [{ step: 'choosing_appointment', flow, appointment_choices: choices },
      { mode, appointment_choices: choices, text: `¿Qué cita quieres ${flow === 'cancel' ? 'cancelar' : 'cambiar'}?` }];
  }
  return continueWithAppointment(ctx, flow, target.id, mode, p);
}

async function continueWithAppointment(ctx: EngineCtx, flow: 'cancel' | 'reschedule', appointmentId: string, mode: Mode,
                                       p: { dateText?: string | null; timeOfDay?: TimeOfDay | null; rawText?: string } = {}): Promise<[ConvState, Reply]> {
  const appts = await upcomingAppointments(ctx);
  const a = appts.find((x) => x.id === appointmentId);
  if (!a) return [{ step: 'idle' }, { mode, menu: true, text: 'Esa cita ya no está activa.' }];
  if (flow === 'cancel') {
    const proposal: Proposal = { kind: 'cancellation', appointment_id: a.id, expected_version: a.version, summary: `Cancelar ${a.label}` };
    return [{ step: 'awaiting_confirmation', flow, target_appointment_id: a.id, target_version: a.version, proposal },
      { mode, proposal, text: `Vas a cancelar la cita ${period(a.label)} Para hacerlo, pulsa «Confirmar». Si no, pulsa «Descartar».` }];
  }
  // Reprogramar: mismo servicio (médico, centro y especialidad)
  const next: ConvState = { step: 'idle', flow: 'reschedule', target_appointment_id: a.id, target_version: a.version,
                            doctor_service_id: a.doctor_service_id, time_of_day: p.timeOfDay ?? null };
  let res = p.rawText ? resolveDate(p.rawText, ctx.now, ctx.tz) : { kind: 'none' as const } as ReturnType<typeof resolveDate>;
  // Fecha del modelo solo si está anclada en el texto del paciente (sin texto, p. ej. botones, se usa tal cual)
  const dateText = p.rawText ? groundedDatePhrase(p.dateText, p.rawText) : p.dateText;
  if (res.kind === 'none' && dateText) res = resolveDate(dateText, ctx.now, ctx.tz);
  if (p.rawText) next.time_of_day = groundedTimeOfDay(p.timeOfDay ?? null, p.rawText) ?? detectTimeOfDay(p.rawText);
  if (res.kind === 'range') next.range = res.range;
  if (res.kind === 'ambiguous') {
    next.step = 'clarifying_date';
    next.date_choices = res.choices;
    return [next, { mode, text: res.question, date_choices: res.choices.map((c, i) => ({ index: i + 1, label: c.label })) }];
  }
  const [st, reply] = await offerSlots(ctx, next, mode);
  if (st.step === 'choosing_slot') reply.text = `Vas a cambiar la cita ${a.reference} con el mismo médico. ${reply.text}`;
  return [st, reply];
}

function selectOption(s: ConvState, index: number, mode: Mode): [ConvState, Reply] {
  const opt = s.options?.find((o) => o.index === index);
  if (s.step !== 'choosing_slot' || !opt) {
    return [s, { mode, options: s.options, text: s.options?.length
      ? `No hay una opción ${index}. Elige entre 1 y ${s.options.length}.`
      : 'No hay horarios ofrecidos en este momento. Dime qué cita buscas.' }];
  }
  const summary = `${opt.specialty} con ${opt.doctor}, ${opt.label}`;
  const proposal: Proposal = s.flow === 'reschedule' && s.target_appointment_id && s.target_version
    ? { kind: 'reschedule', appointment_id: s.target_appointment_id, expected_version: s.target_version, new_slot_id: opt.slot_id,
        summary: `Cambiar al ${summary}` }
    : { kind: 'booking', slot_id: opt.slot_id, summary };
  return [{ ...s, step: 'awaiting_confirmation', proposal },
    { mode, proposal, text: `${proposal.kind === 'booking' ? 'Reservar' : 'Cambiar a'}: ${period(summary)} ` +
      'El horario no queda apartado hasta que pulses «Confirmar»; se vuelve a comprobar al confirmar.' }];
}

async function createHandoff(ctx: EngineCtx, mode: Mode, reason: string): Promise<[ConvState, Reply]> {
  let ref = '';
  for (let i = 0; i < 5 && !ref; i++) {
    const candidate = `AY-${bookingReference().slice(3)}`;
    const r = await ctx.c.query(
      `INSERT INTO handoff_cases (patient_id, conversation_id, reason, reference) VALUES ($1, $2, $3, $4)
       ON CONFLICT (reference) DO NOTHING RETURNING reference`, [ctx.patientId, ctx.conversationId, reason.slice(0, 500), candidate]);
    ref = r.rows[0]?.reference ?? '';
  }
  return [{ step: 'idle' }, { mode, handoff_reference: ref,
    text: `Registré tu solicitud de ayuda administrativa con la referencia ${ref}. El personal la verá en su bandeja; ` +
      'todavía nadie la ha respondido. Mientras tanto puedes seguir usando el asistente.' }];
}

async function listAppointments(ctx: EngineCtx, mode: Mode, question?: string): Promise<[ConvState, Reply]> {
  const appts = await upcomingAppointments(ctx);
  const text = appts.length ? `Tus próximas citas:\n${appts.map((a) => `• ${a.label}`).join('\n')}` : 'No tienes citas próximas activas.';
  // Pregunta escrita («¿a qué hora es mi cita?», «¿tengo cita el lunes?»): el modelo contesta EXACTAMENTE eso con estos
  // datos (redacción «grounded» vía n8n, validada); el botón «Mis citas» muestra la lista tal cual.
  if (!question) return [{ step: 'idle' }, { mode, menu: appts.length === 0, text }];
  const today = new Intl.DateTimeFormat('es-DO', { timeZone: ctx.tz, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(ctx.now);
  return [{ step: 'idle' }, { mode, menu: appts.length === 0, text, converse: 'grounded',
    facts: `Hoy es ${today}.\n${text}` }];
}

// ---------------------------------------------------------------------------
// Punto de entrada
// ---------------------------------------------------------------------------

/**
 * Rama de orquestación de un mensaje de texto, decidida con la interpretación VALIDADA del modelo (ya conciliada con el
 * texto y el estado) antes de ejecutar nada. n8n enruta por este valor (Switch) y la API comprueba en la ejecución que la
 * rama pedida es la misma: n8n muestra la decisión, pero no puede cambiarla. Es la misma clasificación que usa `step`.
 */
export const ROUTES = ['conversacion', 'informacion', 'disponibilidad', 'aclaracion', 'operacion', 'confirmacion', 'mis_citas', 'personal', 'fallo_modelo'] as const;
export type RouteName = (typeof ROUTES)[number];

export function routeOf(ev: EngineEvent, state: ConvState): RouteName {
  if (ev.type === 'llm_failed') return 'fallo_modelo';
  if (ev.type !== 'interpretation') throw new Error('Las acciones de botón no se enrutan por n8n');
  const i = reconcile(ev.interp, ev.text, state);
  if (infoTopic(i, ev.text)) return 'informacion';
  switch (i.intent) {
    case 'greeting': case 'help': case 'service_info': case 'clinical_question':
      return 'conversacion';
    case 'chat':
      return VAGUE_CUES.test(normalize(ev.text)) ? 'aclaracion' : 'conversacion';
    case 'out_of_scope': case 'unknown':
      return 'aclaracion';
    case 'book':
      return 'disponibilidad';
    case 'select_option':
      return state.step === 'clarifying_date' ? 'disponibilidad' : 'operacion';
    case 'cancel': case 'reschedule':
      return 'operacion';
    case 'affirm': case 'deny':
      return 'confirmacion';
    case 'list_appointments':
      return 'mis_citas';
    case 'handoff':
      return 'personal';
  }
}

export async function step(ctx: EngineCtx, state: ConvState, ev: EngineEvent, route?: RouteName): Promise<[ConvState, Reply]> {
  // Ejecución de una rama elegida en n8n: debe coincidir con la decidida por la API con el mismo estado e interpretación
  if (route && ev.type !== 'action' && routeOf(ev, state) !== route) {
    throw new ApiError(409, 'route_mismatch', 'La rama pedida no corresponde a la decisión de la API para este mensaje');
  }
  if (ev.type === 'llm_failed') {
    return [{ ...state, proposal: state.proposal }, { mode: 'fallback_menu', menu: true, options: state.step === 'choosing_slot' ? state.options : undefined,
      text: 'No pude interpretar tu mensaje con el asistente de IA en este momento. Usa los botones del menú; funcionan igual.' }];
  }
  if (ev.type === 'action') return onAction(ctx, state, ev.action);

  const i = reconcile(ev.interp, ev.text, state);
  const mode: Mode = 'ai';
  // Pregunta sobre los horarios que ya están en pantalla («¿quién es el médico de esos horarios?»): se responde con ellos
  // (datos de la propia oferta) y se mantienen los botones para elegir
  if (state.step === 'choosing_slot' && state.options?.length && ABOUT_OFFERED.test(normalize(ev.text))) {
    const docs = [...new Set(state.options.map((o) => `${o.doctor.replace(/ \(fictici[oa]\)/, '')} (${o.specialty})`))];
    const text = (docs.length === 1 ? `Esos horarios son con ${docs[0]}.` : `Esos horarios son con: ${docs.join('; ')}.`)
      + ' Elige uno con su botón o escribe su número.';
    return [state, { mode, text, options: state.options, converse: 'grounded', facts: text }];
  }
  const topic = infoTopic(i, ev.text);
  if (topic) {
    // Rama «informacion»: datos estructurados y vigentes (PostgreSQL + hechos documentados); si no hay dato, se reconoce
    // Filtro por especialidad SOLO si el paciente la nombra o ya está reservando una (no se usa la que «deduzca» el modelo):
    // una especialidad inventada daría una respuesta parcial y engañosa («no hay consultas los sábados»)
    const cat = await loadCatalog(ctx.c);
    const catalog = cat.specialties;
    const spec = topic === 'horarios' || topic === 'precios_seguros' || topic === 'especialidades'
      ? (matchSpecialty(ev.text, catalog)?.name ?? (topic !== 'especialidades' && state.step === 'choosing_slot' ? state.options?.[0]?.specialty ?? null : null)) : null;
    // Filtros de médicos tomados del TEXTO del paciente (no de lo que proponga el modelo)
    const doctorFilter = topic === 'especialidades' ? { doctorId: matchDoctor(ev.text, cat.doctors)?.id ?? null, gender: genderOf(ev.text) } : {};
    const info = await serviceInfo(ctx.c, topic, state.lang ?? 'es', spec, doctorFilter);
    const pending = pendingSummary(state);
    // El texto verificado es a la vez la respuesta de respaldo y los DATOS con los que el modelo redacta (vía n8n)
    return [state, { mode, text: info.text, prelocalized: info.lang, service_topic: topic, menu: !pending, ...(info.schedule ? { schedule: info.schedule } : {}),
      converse: 'grounded', facts: info.text,
      ...(pending ? { pending } : {}) }];
  }
  switch (i.intent) {
    case 'greeting':
    case 'help':
      return (await clarify(ctx, ev.text, mode)) ?? conversational(state, mode, i.intent, welcome(mode, ev.text, ctx.tz));
    case 'chat':
      // Mensaje vago que alude a «lo mío / eso / la cita / my thing»: aclaración con opciones concretas, no charla
      if (VAGUE_CUES.test(normalize(ev.text))) return (await clarify(ctx, ev.text, mode)) ?? vagueClarification(mode);
      // Solo con pistas explícitas de cita (no basta una palabra de fecha como «hoy» en una charla)
      if (looksLikeBooking(ev.text) || APPOINTMENT_CUES.some((w) => normalize(ev.text).includes(w))) {
        const c = await clarify(ctx, ev.text, mode);
        if (c) return c;
      }
      return conversational(state, mode, 'chat', { mode, text: 'Te leo. Si quieres, también puedo ayudarte con tus citas.' });
    case 'service_info':
      return conversational(state, mode, 'service_info', welcome(mode, ev.text, ctx.tz));
    case 'clinical_question': {
      // Sin diagnóstico ni triaje: frase empática del modelo + aviso de seguridad + ofrecer cita (de la especialidad
      // solo si el paciente la nombró). Sin «no entendí»: sí se entendió, simplemente no es algo que el asistente valore.
      const sp = matchSpecialty(ev.text, (await loadCatalog(ctx.c)).specialties);
      const text = 'Lamento que te sientas así. No puedo darte orientación médica, pero sí ayudarte a conseguir una cita para que te valore un médico. '
        + 'Si los síntomas son intensos, empeoran o es una urgencia, acude a emergencias o llama al 9-1-1.';
      return [state, { mode, menu: true, no_draft: true, topic: 'clinical_question', text,
        suggestions: [
          sp ? { label: `Reservar cita de ${sp.name}`, action: { type: 'book_with', specialty_id: sp.id } } : { label: 'Reservar una cita', action: { type: 'menu', item: 'book' } },
          { label: 'Hablar con el personal', action: { type: 'menu', item: 'handoff' } },
        ] }];
    }
    case 'out_of_scope':
      // Petición con pistas de abuso (datos ajenos, saltarse reglas): negativa clara, no «no entendí»
      return [state, { mode, menu: true, no_draft: true,
        text: 'No puedo hacer eso: no comparto datos de otros pacientes ni cambio mis reglas. Sí puedo ayudarte con tus propias citas o pasar tu consulta al personal.' }];
    case 'unknown':
      return (await clarify(ctx, ev.text, mode)) ?? [state, { mode, menu: true, clarification: true,
        text: `No entendí la solicitud o está fuera de lo que puedo hacer. ${MENU_TEXT} Elige una opción:`,
        suggestions: [
          { label: 'Reservar una cita', action: { type: 'menu', item: 'book' } },
          { label: 'Ver mis citas', action: { type: 'menu', item: 'my_appointments' } },
          { label: 'Cambiar o cancelar una cita', action: { type: 'menu', item: 'reschedule' } },
          { label: 'Hablar con el personal', action: { type: 'menu', item: 'handoff' } },
        ] }];
    case 'handoff':
      return createHandoff(ctx, mode, 'Solicitado por el paciente en la conversación');
    case 'list_appointments':
      return listAppointments(ctx, mode, ev.text);
    case 'book':
      return startBooking(ctx, state, mode, { specialtyText: i.specialty, doctorText: i.doctor, dateText: i.date_phrase,
                                               rawText: ev.text, timeOfDay: i.time_of_day });
    case 'cancel':
      return startAppointmentFlow(ctx, 'cancel', mode, { reference: groundedReference(i.booking_reference, ev.text) });
    case 'reschedule':
      return startAppointmentFlow(ctx, 'reschedule', mode, { reference: groundedReference(i.booking_reference, ev.text), dateText: i.date_phrase, timeOfDay: i.time_of_day, rawText: ev.text });
    case 'select_option':
      if (state.step === 'clarifying_date' && i.option_number) return onAction(ctx, state, { type: 'choose_date', index: i.option_number }, mode);
      if (i.option_number) return selectOption(state, i.option_number, mode);
      return [state, { mode, options: state.options, text: '¿Qué número de opción eliges?' }];
    case 'affirm':
      if (state.step === 'awaiting_confirmation') {
        return [state, { mode, proposal: state.proposal, text: 'Para confirmar necesito que pulses el botón «Confirmar». Así evitamos cambios por error.' }];
      }
      return [state, { mode, menu: true, text: `¿Qué quieres hacer? ${MENU_TEXT}` }];
    case 'deny':
      return [{ step: 'idle' }, { mode, menu: true, text: 'De acuerdo, no hice ningún cambio. ¿Necesitas algo más?' }];
  }
  // Seguimiento contextual: el paciente responde a una pregunta pendiente sin repetir la intención
  return [state, { mode, menu: true, text: MENU_TEXT }];
}

/**
 * Coherencia determinista entre la interpretación del modelo, el texto y el estado de la conversación.
 * - Una elección de opción solo tiene sentido si hay opciones vigentes; el número se toma del texto si aparece.
 * - Ante una propuesta pendiente, un «sí»/«no» corto se reconoce sin depender del modelo.
 * Nunca habilita operaciones: como máximo cambia qué pregunta o propuesta se muestra.
 */
export function reconcile(i: InterpretationT, text: string, s: ConvState): InterpretationT {
  const choosing = s.step === 'choosing_slot' || s.step === 'clarifying_date';
  if (s.step === 'awaiting_confirmation') {
    const yn = yesNo(text);
    if (yn) return { ...i, intent: yn };
  }
  if (choosing) {
    const n = ordinalInText(text);
    if (n !== null && (i.intent === 'select_option' || i.intent === 'unknown' || i.intent === 'book' && !looksLikeBooking(text))) {
      return { ...i, intent: 'select_option', option_number: n };
    }
  }
  // Pregunta clínica sin ninguna pista de salud en el texto («¿capital de Japón?»): es conversación general
  if (i.intent === 'clinical_question' && !looksClinical(text)) i = { ...i, intent: 'chat' };   // y siguen las demás reglas
  // «Fuera de alcance» solo si hay pistas reales de abuso (datos ajenos, saltarse reglas, credenciales); el resto
  // («¿quién ganó el mundial?») es conversación
  if (i.intent === 'out_of_scope' && !ABUSE.test(normalize(text))) i = { ...i, intent: 'chat' };
  // «¿Hay algo el martes en la mañana?»: pregunta de disponibilidad con fecha o franja → buscar horarios
  if (!OPERATIONAL.has(i.intent) && AVAIL_ASK.test(normalize(text)) && (WHEN_WORDS.test(normalize(text)) || detectTimeOfDay(text))) {
    return { ...i, intent: 'book', service_topic: undefined };
  }
  // «¿Qué es la presión arterial?»: pregunta general con un término de salud, sin hablar de sí mismo → explicación general
  if (i.intent === 'clinical_question' && isGeneralKnowledge(text) && !FIRST_PERSON.test(normalize(text))) i = { ...i, intent: 'chat' };
  // Pregunta de conocimiento general («¿qué hace un cardiólogo?», «¿qué es la presión arterial?»): la responde el modelo
  // en la conversación, no el catálogo. Si pregunta qué especialidades o médicos HAY, sí es información del servicio.
  if (!OPERATIONAL.has(i.intent) && i.intent !== 'clinical_question' && isGeneralKnowledge(text)) {
    return { ...i, intent: 'chat', service_topic: undefined };
  }
  // Pregunta sobre SUS citas («¿a qué hora es mi cita?», «¿cuándo tengo cita?»): se consultan sus citas, no los horarios
  // generales de consulta. Cancelar o cambiar siguen su propio flujo.
  if (APPOINTMENT_CUES.some((w) => normalize(text).includes(w)) && !hasCue(text, CANCEL_CUES) && !hasCue(text, RESCHEDULE_CUES)
      && !OPERATIONAL.has(i.intent)) {
    return { ...i, intent: 'list_appointments', service_topic: undefined };
  }
  // Pregunta por médicos (con sexo o disponibilidad) sin pedir una cita: consulta de datos de médicos
  const tt = normalize(text);
  if (!OPERATIONAL.has(i.intent) || i.intent === 'book') {
    if (DOCTOR_Q.test(tt) && (genderOf(text) || AVAIL_Q.test(tt)) && !BOOK_WORDS.test(tt) && i.intent !== 'clinical_question') {
      return { ...i, intent: 'service_info', service_topic: 'especialidades' } as unknown as InterpretationT;
    }
  }
  // El tema institucional que propone el modelo solo vale si el texto tiene alguna pista de ese tema: «¿capital de
  // Japón?» clasificada como «horarios» por el modelo es conversación, no una tarjeta de horarios.
  const topic = i.service_topic as ServiceTopic | null | undefined;
  if (topic && topic !== 'funciones' && topic !== 'otro' && !topicHasCue(topic, text)) {
    return { ...i, intent: i.intent === 'service_info' || i.intent === 'help' ? 'chat' : i.intent, service_topic: undefined };
  }
  if (i.intent === 'select_option' && !choosing) {
    return { ...i, intent: looksLikeBooking(text) || matchSpecialty(text, []) ? 'book' : 'unknown', option_number: null };
  }
  return i;
}

const GENERAL_Q = /\b(que|what)\s+(hace|es|son|significa|estudia|trata|tratan|atiende|atienden|does|is|are)\b|\bpara que sirve|\bdiferencia entre\b|\bque tipo de (medico|doctor)\b/;
const SERVICE_Q = /\b(hay|tienen|tiene el hospital|disponibles?|ofrecen|cuales|cuantos|horarios?|atencion|precios?|cuesta|cobran|seguros?|direccion|telefono|donde|reserv\w*|citas?|especialidades|medicos|comprobantes?|avisos?|hours|open|opening|price|cost|insurance|address|phone|where|appointments?|book\w*|available|doctors|specialties|receipts?)\b/;
const MALE = /\b(masculinos?|hombres?|varon(es)?|senor(es)?|males?|man|men)\b/;
const FEMALE = /\b(femeninas?|femeninos?|mujer(es)?|senoras?|doctoras|doctora|females?|woman|women)\b/;
/** Sexo del médico pedido en el texto («médico hombre», «una doctora»), o null */
export function genderOf(text: string): 'male' | 'female' | null {
  const t = normalize(text);
  return FEMALE.test(t) ? 'female' : MALE.test(t) ? 'male' : null;
}
const DOCTOR_Q = /\b(medic[oa]s?|doctor(a|es|as)?|especialistas?|cardiolog[oa]s?|pediatras?|internistas?|doctors?|physicians?)\b/;
const AVAIL_Q = /\b(disponible|disponibles|disponibilidad|libre|libres|atiende|atienden|available|availability|free)\b/;
const BOOK_WORDS = /\b(cita|reserv\w*|agend\w*|turno|book\w*|appointment)\b/;

const ABUSE = /(otro paciente|otros pacientes|otra persona|de alguien|datos de|contrasena|password|clave de|sql|base de datos|ignora|instrucciones|tus reglas|prompt|administrador|hack|tarjeta de credito|cedula de|other patient|ignore (your|the)|instructions)/;
const AVAIL_ASK = /\b(hay algo|hay algun|hay alguna|hay disponib\w*|hay espacio|hay cupo|hay turno|tienen algo|tienes algo|algo libre|algun hueco|queda algo|is there anything|anything (on|for)|any (slots?|openings?))\b/;
const WHEN_WORDS = /\b(hoy|manana|pasado manana|lunes|martes|miercoles|jueves|viernes|sabado|domingo|semana|mes|today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|week|\d{1,2} de \w+)\b/;
const FIRST_PERSON = /\b(me|mi|mis|tengo|siento|estoy|tomo|hijo|hija|bebe|esposo|esposa|madre|padre|i|my|me|i'm|im)\b/;
const OPERATIONAL = new Set(['book', 'cancel', 'reschedule', 'select_option', 'affirm', 'deny', 'list_appointments', 'handoff']);
const TOPIC_CUES: Partial<Record<ServiceTopic, RegExp>> = {
  horarios: /horario|hora|abre|abren|cierra|cierran|atiende|atienden|atencion|trabaj|dias?\b|fin(es)? de semana|sabado|domingo|hours|open|schedule|weekend|time|work|when/,
  comprobantes: /comprobante|pdf|recibo|factura|constancia|receipt/,
  politicas: /regla|norma|politica|anticipacion|plazo|cancel|cambi|reprogram|limite|rules?|policy|notice/,
  avisos: /aviso|notificacion|recordatorio|oferta|adelant|notice|reminder|offer/,
  acceso: /codigo|contrasena|clave|acceso|entrar|sesion|recuperacion|cuenta|login|password|access|account/,
  especialidades: /especialid|medic|doctor|doctora|especialista|cardio|pediatr|internist|specialt|physician/,
  ubicacion_contacto: /donde|direccion|ubica|telefono|llamar|correo|email|contacto|parqueo|estacionamiento|llegar|where|address|phone|contact|parking/,
  precios_seguros: /precio|cuesta|costo|cobra|pagar|pago|seguro|ars\b|tarifa|price|cost|insurance|pay|fee/,
};
function topicHasCue(topic: ServiceTopic, text: string): boolean {
  const re = TOPIC_CUES[topic];
  return !re || re.test(normalize(text));
}

/** Pregunta general (qué es / qué hace…) que no pide datos del servicio ni gestionar citas */
export function isGeneralKnowledge(text: string): boolean {
  const t = normalize(text);
  return GENERAL_Q.test(t) && !SERVICE_Q.test(t) && !APPOINTMENT_CUES.some((w) => t.includes(w));
}

const APPOINTMENT_CUES = ['mi cita', 'mis citas', 'my appointment', 'my appointments', 'minha consulta', 'mi proxima', 'mi turno', 'mis turnos', 'quedo mi', 'tengo cita', 'tengo pendientes', 'citas tengo'];
const CANCEL_CUES = ['cancelar', 'cancela', 'anular', 'anula', 'borra', 'borrar', 'no voy a ir', 'ya no voy'];
const RESCHEDULE_CUES = ['cambiar', 'mover', 'pasar', 'otra fecha', 'otro dia', 'reprogramar'];
const STAFF_CUES = ['persona', 'personal', 'oficina', 'llame', 'llamen', 'humano', 'recepcion', 'alguien'];

/**
 * Aclaración ante intención incierta: si el modelo devolvió una intención genérica pero el texto contiene pistas
 * concretas, se proponen acciones con botones en lugar de un saludo genérico. Devuelve null si no hay pistas.
 */
async function clarify(ctx: EngineCtx, text: string, mode: Mode, prefix?: string): Promise<[ConvState, Reply] | null> {
  const t = normalize(text);
  const cat = await loadCatalog(ctx.c);
  const doctor = matchDoctor(text, cat.doctors);
  const sp = matchSpecialty(text, cat.specialties) ?? (doctor ? cat.specialties.find((x) => x.id === doctor.specialty_id) : undefined);
  const date = resolveDate(text, ctx.now, ctx.tz);
  const tod = detectTimeOfDay(text);
  const aboutAppointment = APPOINTMENT_CUES.some((w) => t.includes(w));
  const wantsBooking = Boolean(sp || doctor || looksLikeBooking(text) || date.kind === 'range' || date.kind === 'ambiguous');
  const wantsStaff = hasCue(text, STAFF_CUES);
  if (!wantsBooking && !aboutAppointment && !wantsStaff) return null;

  const suggestions: { label: string; action: Action }[] = [];
  if (aboutAppointment || hasCue(text, CANCEL_CUES) || hasCue(text, RESCHEDULE_CUES)) {
    suggestions.push({ label: 'Ver mis citas', action: { type: 'menu', item: 'my_appointments' } });
    if (hasCue(text, CANCEL_CUES)) suggestions.push({ label: 'Cancelar una cita', action: { type: 'menu', item: 'cancel' } });
    if (hasCue(text, RESCHEDULE_CUES) || !hasCue(text, CANCEL_CUES)) suggestions.push({ label: 'Cambiar una cita', action: { type: 'menu', item: 'reschedule' } });
  }
  if (wantsBooking && !(aboutAppointment && !sp)) {
    const range = date.kind === 'range' ? date.range : undefined;
    const when = range ? ` ${range.label}` : '';
    suggestions.unshift({
      label: sp ? `Reservar cita de ${sp.name}${when}` : `Reservar una cita${when}`,
      action: { type: 'book_with', specialty_id: sp?.id, doctor_id: doctor?.id, date_from: range?.from, date_to: range?.to,
                date_label: range?.label, time_of_day: tod ?? undefined },
    });
  }
  suggestions.push({ label: 'Hablar con el personal', action: { type: 'menu', item: 'handoff' } });
  const first = suggestions[0]!;
  const question = wantsStaff && suggestions.length === 1 ? '¿Quieres que pase tu solicitud al personal administrativo?'
    : first.action.type === 'book_with' ? `¿Quieres ${first.label.charAt(0).toLowerCase()}${first.label.slice(1)}?`
    : '¿Qué quieres hacer con tus citas?';
  return [{ step: 'idle' }, { mode, clarification: true, suggestions: suggestions.slice(0, 4),
    text: `${prefix ? `${prefix} ` : ''}No estoy seguro de haber entendido. ${question} Elige una opción o escríbelo de otra forma.` }];
}

async function onAction(ctx: EngineCtx, s: ConvState, a: Action, mode: Mode = 'deterministic'): Promise<[ConvState, Reply]> {
  switch (a.type) {
    case 'menu':
      switch (a.item) {
        case 'help': return [s, welcome(mode, '', ctx.tz)];
        case 'book': {
          const cat = await loadCatalog(ctx.c);
          return [{ step: 'choosing_specialty', flow: 'book' }, { mode, specialty_choices: cat.specialties, text: '¿Para qué especialidad?' }];
        }
        case 'my_appointments': return listAppointments(ctx, mode);
        case 'cancel': return startAppointmentFlow(ctx, 'cancel', mode, {});
        case 'reschedule': return startAppointmentFlow(ctx, 'reschedule', mode, {});
        case 'handoff': return createHandoff(ctx, mode, 'Solicitado por el paciente desde el menú');
      }
      break;
    case 'book_with': {
      const range = a.date_from && a.date_to ? { from: a.date_from, to: a.date_to, label: a.date_label ?? 'las fechas indicadas' } : undefined;
      const next: ConvState = { step: 'idle', flow: 'book', specialty_id: a.specialty_id, doctor_id: a.doctor_id, range, time_of_day: a.time_of_day ?? null };
      if (!a.specialty_id) {
        const cat = await loadCatalog(ctx.c);
        return [{ ...next, step: 'choosing_specialty' }, { mode, clarification: true, specialty_choices: cat.specialties, text: '¿Para qué especialidad?' }];
      }
      return offerSlots(ctx, next, mode);
    }
    case 'choose_specialty': {
      const cat = await loadCatalog(ctx.c);
      const sp = cat.specialties.find((x) => x.id === a.specialty_id);
      if (!sp) return [s, { mode, specialty_choices: cat.specialties, text: 'Esa especialidad no está disponible. Elige otra.' }];
      const next: ConvState = { step: 'idle', flow: 'book', specialty_id: sp.id, range: s.range, time_of_day: s.time_of_day };
      if (s.date_choices?.length) {
        return [{ ...next, step: 'clarifying_date', date_choices: s.date_choices },
          { mode, text: '¿Qué fecha prefieres?', date_choices: s.date_choices.map((c, i) => ({ index: i + 1, label: c.label })) }];
      }
      return offerSlots(ctx, next, mode);
    }
    case 'choose_date': {
      const choice = s.date_choices?.[a.index - 1];
      if (s.step !== 'clarifying_date' || !choice) return [s, { mode, text: 'Esa opción de fecha ya no está vigente.' }];
      return offerSlots(ctx, { ...s, range: choice, date_choices: undefined }, mode);
    }
    case 'select_option':
      return selectOption(s, a.index, mode);
    case 'more_options':
      if (s.step !== 'choosing_slot') return [s, { mode, text: 'No hay una búsqueda activa.' }];
      return offerSlots(ctx, s, mode, { more: true });
    case 'choose_appointment':
      if (s.step !== 'choosing_appointment' || !s.flow || s.flow === 'book' ||
          !s.appointment_choices?.some((x) => x.appointment_id === a.appointment_id)) {
        return [s, { mode, text: 'Esa cita no forma parte de las opciones mostradas.' }];
      }
      return continueWithAppointment(ctx, s.flow, a.appointment_id, mode);
    case 'resume': {
      // Retomar la gestión tras cambiar de tema: se vuelve a mostrar lo que estaba pendiente, sin cambiar nada
      if (s.step === 'choosing_slot' && s.options?.length) return [s, optionsReply(mode, s.options, 'Seguimos. Estos son los horarios que te mostré:', true, s.flow === 'book')];
      if (s.step === 'awaiting_confirmation' && s.proposal) {
        return [s, { mode, proposal: s.proposal, text: `Seguimos con: ${period(s.proposal.summary)} Para hacerlo, pulsa «Confirmar». Si no, pulsa «Descartar».` }];
      }
      if (s.step === 'choosing_specialty') { const cat = await loadCatalog(ctx.c); return [s, { mode, specialty_choices: cat.specialties, text: '¿Para qué especialidad?' }]; }
      if (s.step === 'clarifying_date' && s.date_choices) return [s, { mode, text: '¿Qué fecha prefieres?', date_choices: s.date_choices.map((c, i) => ({ index: i + 1, label: c.label })) }];
      if (s.step === 'choosing_appointment' && s.appointment_choices) {
        return [s, { mode, appointment_choices: s.appointment_choices, text: `¿Qué cita quieres ${s.flow === 'cancel' ? 'cancelar' : 'cambiar'}?` }];
      }
      return [s, { mode, menu: true, text: `No hay ninguna gestión pendiente. ${MENU_TEXT}` }];
    }
    case 'discard_proposal':
      return [{ step: 'idle' }, { mode, menu: true, text: 'Descartado. No hice ningún cambio.' }];
    case 'intent_result': {
      // Informa el resultado leyendo la intención consumida en PostgreSQL; nunca a partir del modelo
      const r = await ctx.c.query(
        `SELECT status, result FROM action_intents WHERE id = $1 AND patient_id = $2`, [a.intent_id, ctx.patientId]);
      const row = r.rows[0];
      if (!row || row.status !== 'consumed' || !row.result) {
        return [s, { mode: 'system', text: 'Esa operación no se completó. No hubo cambios en tus citas.' }];
      }
      const res = row.result as { outcome: string; appointment: { booking_reference: string; slot: { label: string; doctor: { display_name: string } } } };
      const ap = res.appointment;
      const text = res.outcome === 'booked' ? period(`Listo: tu cita ${ap.booking_reference} con ${ap.slot.doctor.display_name} quedó confirmada para el ${ap.slot.label}`)
        : res.outcome === 'rescheduled' ? period(`Listo: tu cita ${ap.booking_reference} ahora es el ${ap.slot.label} con ${ap.slot.doctor.display_name}`)
        : res.outcome === 'cancelled' ? period(`Listo: la cita ${ap.booking_reference} del ${ap.slot.label} quedó cancelada`)
        : `La cita ${ap.booking_reference} ya estaba cancelada.`;
      return [{ step: 'idle' }, { mode: 'system', text }];
    }
  }
  return [s, { mode, menu: true, text: MENU_TEXT }];
}
