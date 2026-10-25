// Información INSTITUCIONAL del servicio con datos estructurados y vigentes (rama «informacion»).
// No la redacta el modelo: horarios de consulta, centros, especialidades y plazos salen de PostgreSQL en el momento de
// responder; el resto son hechos documentados (docs/guia-servicio.md) implementados y verificados. Si un dato no está
// registrado (p. ej., un centro sin teléfono o un servicio sin precio), la respuesta dice que no se puede confirmar.

import type { PoolClient } from '../../db/pool.js';
import { spanishLabel } from '../../shared/time.js';

export const SERVICE_TOPICS = ['horarios', 'comprobantes', 'funciones', 'politicas', 'avisos', 'acceso', 'especialidades',
  'ubicacion_contacto', 'precios_seguros', 'otro'] as const;
export type ServiceTopic = (typeof SERVICE_TOPICS)[number];
type Lang = 'es' | 'en';

const DAYS: Record<Lang, string[]> = {
  es: ['lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado', 'domingo'],
  en: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'],
};
const SPEC_EN: Record<string, string> = { 'Cardiología': 'Cardiology', 'Pediatría': 'Pediatrics', 'Medicina Interna': 'Internal Medicine',
  'Medicina General': 'General Medicine', 'Ginecología': 'Gynecology', 'Dermatología': 'Dermatology' };
const spec = (name: string, lang: Lang) => (lang === 'en' ? SPEC_EN[name] ?? name : name);
const fict = (s: string, lang: Lang) => (lang === 'en' ? s.replace(/\((ficticia|ficticio)\)/g, '(fictitious)') : s);

function clock(t: string, lang: Lang): string {
  const [h, m] = t.split(':').map(Number) as [number, number];
  const h12 = ((h + 11) % 12) + 1;
  const mm = String(m).padStart(2, '0');
  return lang === 'en' ? `${h12}:${mm} ${h < 12 ? 'AM' : 'PM'}` : `${h12}:${mm} ${h < 12 ? 'a. m.' : 'p. m.'}`;
}

function joinList(items: string[], lang: Lang): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} ${lang === 'en' ? 'and' : 'y'} ${items.at(-1)}`;
}

/** Horarios de consulta vigentes por especialidad y médico (reglas de agenda activas hoy). */
/** Horario estructurado para que la interfaz lo dibuje como tarjeta (el texto sigue siendo la versión accesible y de historial). */
export interface ScheduleCard {
  center: string; specialty: string | null; closed_days: number[];
  doctors: { specialty: string; doctor: string; ranges: { days: number[]; start: string; end: string }[] }[];
}

/**
 * Una regla semanal cuenta si todavía se aplica en la PRÓXIMA fecha de su día de la semana (hoy incluido, fecha local del
 * centro). Una regla finalizada hoy para un día que ya no volverá a ocurrir antes de su fin (p. ej., «domingos hasta el
 * sábado») no se anuncia: no generará horarios. Requiere los alias `sr` (schedule_rules) y `ce` (centers).
 */
const RULE_STILL_APPLIES = `(sr.valid_until IS NULL OR sr.valid_until >= (now() AT TIME ZONE ce.timezone)::date
  + ((sr.weekday - extract(isodow FROM (now() AT TIME ZONE ce.timezone)::date)::int + 7) % 7))`;

async function hours(c: PoolClient, lang: Lang, specialty: string | null): Promise<{ text: string; schedule?: ScheduleCard }> {
  const rows = (await c.query(
    `SELECT sp.name AS specialty, d.display_name AS doctor, ce.name AS center, sr.weekday,
            to_char(sr.local_start, 'HH24:MI') AS s, to_char(sr.local_end, 'HH24:MI') AS e
     FROM schedule_rules sr JOIN doctor_services ds ON ds.id = sr.doctor_service_id AND ds.active
       JOIN doctors d ON d.id = ds.doctor_id JOIN specialties sp ON sp.id = ds.specialty_id AND sp.active
       JOIN centers ce ON ce.id = ds.center_id AND ce.active
     WHERE sr.valid_from <= (now() AT TIME ZONE ce.timezone)::date
       AND ${RULE_STILL_APPLIES}
       AND ($1::text IS NULL OR sp.name = $1)
     ORDER BY sp.name, d.display_name, sr.local_start, sr.weekday`, [specialty])).rows;
  if (!rows.length) {
    return { text: lang === 'en'
      ? 'There are no consultation hours registered for that right now, so I cannot confirm any schedule.'
      : 'Ahora mismo no hay horarios de consulta registrados para eso, así que no puedo confirmarte ningún horario.' };
  }
  // Agrupa por médico y franja: «lunes, miércoles y viernes de 8:00 a. m. a 12:00 p. m.»
  const byDoctor = new Map<string, { specialty: string; center: string; slots: Map<string, number[]> }>();
  const days = new Set<number>();
  for (const r of rows) {
    const k = `${r.specialty}|${r.doctor}`;
    if (!byDoctor.has(k)) byDoctor.set(k, { specialty: r.specialty, center: r.center, slots: new Map() });
    const range = `${r.s}-${r.e}`;
    const g = byDoctor.get(k)!;
    g.slots.set(range, [...(g.slots.get(range) ?? []), Number(r.weekday)]);
    days.add(Number(r.weekday));
  }
  const lines = [...byDoctor.entries()].map(([k, g]) => {
    const doctor = fict(k.split('|')[1]!, lang);
    const parts = [...g.slots.entries()].map(([range, wd]) => {
      const [s, e] = range.split('-') as [string, string];
      const dl = joinList([...new Set(wd)].sort().map((x) => DAYS[lang][x - 1]!), lang);
      return lang === 'en' ? `${dl}, ${clock(s, lang)} to ${clock(e, lang)}` : `${dl} de ${clock(s, lang)} a ${clock(e, lang)}`;
    });
    return `• ${spec(g.specialty, lang)} — ${doctor}: ${parts.join('; ')}`;
  });
  const closedDays = [1, 2, 3, 4, 5, 6, 7].filter((d) => !days.has(d));
  const closed = closedDays.map((d) => lang === 'en' ? `${DAYS.en[d - 1]}s` : (d >= 6 ? `${DAYS.es[d - 1]}s` : DAYS.es[d - 1]!));
  const centers = [...new Set(rows.map((r) => String(r.center)))];
  const schedule: ScheduleCard = {
    center: centers.join(', '), specialty, closed_days: closedDays,
    doctors: [...byDoctor.entries()].map(([k, g]) => ({ specialty: g.specialty, doctor: k.split('|')[1]!,
      ranges: [...g.slots.entries()].map(([range, wd]) => { const [st, en] = range.split('-') as [string, string];
        return { days: [...new Set(wd)].sort(), start: st, end: en }; }) })),
  };
  if (lang === 'en') {
    return { schedule, text: [`Consultation hours registered in the current schedule${specialty ? ` for ${spec(specialty, lang)}` : ''} (${centers.join(', ')}):`,
      ...lines,
      closed.length ? `No consultations are registered on ${joinList(closed, lang)}.` : '',
      'These are the doctors’ scheduled hours, not guaranteed free slots: absences can change them. To see free times, choose «Book appointment».']
      .filter(Boolean).join('\n') };
  }
  return { schedule, text: [`Horarios de consulta registrados en la agenda vigente${specialty ? ` de ${specialty}` : ''} (${centers.join(', ')}):`,
    ...lines,
    closed.length ? `No hay consultas registradas los ${joinList(closed, lang)}.` : '',
    'Son las franjas de cada médico, no horarios libres garantizados: las ausencias pueden cambiarlas. Para ver horarios libres, elige «Reservar cita».']
    .filter(Boolean).join('\n') };
}

async function policies(c: PoolClient, lang: Lang): Promise<string> {
  const p = (await c.query(`SELECT min(min_notice_minutes) AS min_notice, max(min_notice_minutes) AS max_notice,
                                   min(booking_horizon_days) AS min_h, max(booking_horizon_days) AS max_h
                            FROM doctor_services WHERE active`)).rows[0];
  const hours = (m: number) => Math.round(Number(m) / 60);
  const notice = Number(p.max_notice) === 0 ? null
    : p.min_notice === p.max_notice ? `${hours(p.min_notice)} h` : `${hours(p.min_notice)}–${hours(p.max_notice)} h`;
  const horizon = p.min_h === p.max_h ? `${p.min_h}` : `${p.min_h}–${p.max_h}`;
  if (lang === 'en') {
    return ['SaludCita rules (current configuration):',
      '• Bookings, changes and cancellations are only made when you press «Confirm»; the time is checked again at that moment.',
      `• You can book up to ${horizon} days ahead${notice ? ` and with at least ${notice} notice, depending on the service` : ''}.`,
      '• Changing an appointment keeps the same doctor; cancelling frees the time and it may be offered to other patients.',
      '• If you asked for it, you may receive an earlier-slot offer with the same doctor; you have a limited time to accept it.',
      '• No diagnoses, treatments or medication advice. In an emergency, go to the emergency room or call 9-1-1.',
      '• This is a simulated hospital: all data is fictitious.'].join('\n');
  }
  return ['Reglas de SaludCita (configuración vigente):',
    '• Las reservas, cambios y cancelaciones solo se hacen cuando pulsas «Confirmar»; el horario se vuelve a comprobar en ese momento.',
    `• Puedes reservar hasta con ${horizon} días de antelación${notice ? ` y con al menos ${notice} de aviso, según el servicio` : ''}.`,
    '• Cambiar una cita mantiene el mismo médico; cancelarla libera el horario y puede ofrecerse a otros pacientes.',
    '• Si lo pediste, puedes recibir una oferta para adelantar tu cita con el mismo médico; tiene un plazo limitado para aceptarla.',
    '• No se dan diagnósticos, tratamientos ni recomendaciones de medicamentos. En una urgencia, acude a emergencias o llama al 9-1-1.',
    '• Es un hospital simulado: todos los datos son ficticios.'].join('\n');
}

export interface DoctorFilter { specialty?: string | null; doctorId?: string | null; gender?: 'male' | 'female' | null }

/**
 * Médicos con su especialidad, días de consulta y PRÓXIMO HORARIO LIBRE real (vista reservable_slots: abierto, sin
 * cita ni oferta, respetando antelación y horizonte). Filtros: especialidad, médico y sexo. El sexo se deduce del
 * título del nombre visible ficticio («Dr.» / «Dra.»); no hay un campo de sexo en el catálogo.
 */
async function specialties(c: PoolClient, lang: Lang, f: DoctorFilter = {}): Promise<string> {
  const rows = (await c.query(
    `SELECT d.id, d.display_name AS doctor, sp.name AS specialty, ce.timezone,
            (SELECT string_agg(DISTINCT sr.weekday::text, ',' ORDER BY sr.weekday::text) FROM schedule_rules sr
               WHERE sr.doctor_service_id = ds.id AND sr.valid_from <= (now() AT TIME ZONE ce.timezone)::date AND ${RULE_STILL_APPLIES}) AS weekdays,
            (SELECT min(rs.starts_at) FROM reservable_slots rs WHERE rs.doctor_service_id = ds.id) AS next_free,
            (SELECT count(*)::int FROM reservable_slots rs WHERE rs.doctor_service_id = ds.id AND rs.starts_at < now() + interval '7 days') AS free_7d
     FROM doctor_services ds JOIN specialties sp ON sp.id = ds.specialty_id AND sp.active JOIN doctors d ON d.id = ds.doctor_id
       JOIN centers ce ON ce.id = ds.center_id AND ce.active
     WHERE ds.active AND ($1::text IS NULL OR sp.name = $1) AND ($2::uuid IS NULL OR d.id = $2)
       AND ($3::text IS NULL OR ($3 = 'female' AND d.display_name ~* '^dra\\.?\\s') OR ($3 = 'male' AND d.display_name ~* '^dr\\.?\\s'))
     ORDER BY sp.name, d.display_name`, [f.specialty ?? null, f.doctorId ?? null, f.gender ?? null])).rows;
  const who = [f.specialty ? spec(f.specialty, lang) : '', f.gender === 'male' ? (lang === 'en' ? 'male' : 'hombres') : f.gender === 'female' ? (lang === 'en' ? 'female' : 'mujeres') : '']
    .filter(Boolean).join(' · ');
  if (!rows.length) {
    return lang === 'en' ? `There are no active doctors${who ? ` (${who})` : ''} in the catalog.` : `No hay médicos activos${who ? ` (${who})` : ''} en el catálogo.`;
  }
  const lines = rows.map((r) => {
    const days = r.weekdays ? joinList(String(r.weekdays).split(',').map((x) => DAYS[lang][Number(x) - 1]!), lang) : (lang === 'en' ? 'no current schedule' : 'sin horario vigente');
    const next = r.next_free
      ? (lang === 'en' ? `next free time: ${spanishLabel(r.next_free, r.timezone)}` : `próximo horario libre: ${spanishLabel(r.next_free, r.timezone)}`)
      : (lang === 'en' ? 'no free times in the booking window' : 'sin horarios libres en el periodo reservable');
    const week = lang === 'en' ? `${r.free_7d} free in the next 7 days` : `${r.free_7d} libres en los próximos 7 días`;
    return `• ${fict(r.doctor, lang)} — ${spec(r.specialty, lang)}; ${lang === 'en' ? 'consultation days' : 'días de consulta'}: ${days}; ${next}; ${week}`;
  });
  const head = lang === 'en' ? `Doctors (fictitious)${who ? ` · ${who}` : ''}:` : `Médicos (ficticios)${who ? ` · ${who}` : ''}:`;
  return [head, ...lines].join('\n');
}

const NOT_ON_RECORD: Record<Lang, (what: string) => string> = {
  es: (w) => `No hay ${w} registrado, así que no puedo confirmarlo.`,
  en: (w) => `There is no ${w} on record, so I cannot confirm it.`,
};

async function location(c: PoolClient, lang: Lang): Promise<string> {
  const rows = (await c.query(`SELECT name, address, phone, email, info_notes FROM centers WHERE active ORDER BY name`)).rows;
  const out: string[] = [lang === 'en' ? 'Registered centers (fictitious data):' : 'Centros registrados (datos ficticios):'];
  for (const r of rows) {
    out.push(`• ${r.name}`);
    const L = lang === 'en' ? { a: 'Address', p: 'Phone', e: 'Email', n: 'Notes' } : { a: 'Dirección', p: 'Teléfono', e: 'Correo', n: 'Notas' };
    out.push(r.address ? `  ${L.a}: ${r.address}` : `  ${NOT_ON_RECORD[lang](lang === 'en' ? 'address' : 'una dirección')}`);
    out.push(r.phone ? `  ${L.p}: ${r.phone}` : `  ${NOT_ON_RECORD[lang](lang === 'en' ? 'phone number' : 'un teléfono')}`);
    if (r.email) out.push(`  ${L.e}: ${r.email}`);
    if (r.info_notes) out.push(`  ${L.n}: ${r.info_notes}`);
  }
  out.push(lang === 'en' ? 'Anything else about the center that is not listed here is not on record, so I cannot confirm it.'
    : 'Cualquier otro dato del centro que no aparezca aquí no está registrado, así que no puedo confirmarlo.');
  return out.join('\n');
}

function money(v: string | number, lang: Lang): string {
  return `RD$${Number(v).toLocaleString(lang === 'en' ? 'en-US' : 'es-DO', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
}

async function prices(c: PoolClient, lang: Lang, specialty: string | null): Promise<string> {
  const rows = (await c.query(
    `SELECT sp.name AS specialty, min(ds.price_dop) AS min_p, max(ds.price_dop) AS max_p, bool_or(ds.price_dop IS NULL) AS missing
     FROM doctor_services ds JOIN specialties sp ON sp.id = ds.specialty_id AND sp.active
     WHERE ds.active AND ($1::text IS NULL OR sp.name = $1) GROUP BY sp.name ORDER BY sp.name`, [specialty])).rows;
  const centers = (await c.query(`SELECT name, accepted_insurers, payment_methods FROM centers WHERE active ORDER BY name`)).rows;
  const out: string[] = [lang === 'en' ? 'Consultation prices (fictitious data, first visit):' : 'Precios de la consulta (datos ficticios, primera consulta):'];
  for (const r of rows) {
    const p = r.min_p == null ? (lang === 'en' ? 'no price on record' : 'sin precio registrado')
      : r.min_p === r.max_p ? money(r.min_p, lang) : `${money(r.min_p, lang)}–${money(r.max_p, lang)}`;
    out.push(`• ${spec(r.specialty, lang)}: ${p}`);
  }
  for (const c0 of centers) {
    const ins = (c0.accepted_insurers ?? []) as string[];
    const pay = (c0.payment_methods ?? []) as string[];
    out.push(ins.length ? (lang === 'en' ? `Accepted insurers (${c0.name}): ${joinList(ins, lang)}.` : `Seguros aceptados (${c0.name}): ${joinList(ins, lang)}.`)
      : NOT_ON_RECORD[lang](lang === 'en' ? 'list of accepted insurers' : 'una lista de seguros aceptados'));
    if (pay.length) out.push(lang === 'en' ? `Payment methods: ${joinList(pay, lang)}.` : `Formas de pago: ${joinList(pay, lang)}.`);
  }
  out.push(lang === 'en' ? 'Payment is made at the center; this assistant does not charge or check insurance coverage.'
    : 'El pago se hace en el centro; este asistente no cobra ni verifica la cobertura de tu seguro.');
  return out.join('\n');
}

const STATIC: Record<Exclude<ServiceTopic, 'horarios' | 'politicas' | 'especialidades' | 'ubicacion_contacto' | 'precios_seguros'>, Record<Lang, string>> = {
  comprobantes: {
    es: 'Comprobantes: al confirmar o cambiar una cita se genera un comprobante en PDF con la referencia, el médico, la fecha y la hora. '
      + 'Te lo entrego aquí en el chat y también queda en «Mis citas». Cada cambio genera uno nuevo numerado y el anterior deja de valer. '
      + 'Si la generación falla, tu cita sigue confirmada y puedes reintentarlo desde «Mis citas».',
    en: 'Receipts: when you confirm or change an appointment, a PDF receipt is generated with the reference, doctor, date and time. '
      + 'I deliver it here in the chat and it also stays in «My appointments». Each change produces a new numbered receipt that replaces the previous one. '
      + 'If generation fails, your appointment stays confirmed and you can retry from «My appointments».',
  },
  funciones: {
    es: 'Puedo ayudarte a: reservar una cita nueva, ver tus citas, cambiarlas (con el mismo médico) o cancelarlas, informarte de horarios de consulta, '
      + 'comprobantes y avisos, y pasar tu solicitud al personal administrativo (queda en su bandeja; no es atención inmediata). '
      + 'Las operaciones solo se hacen cuando pulsas «Confirmar».',
    en: 'I can help you: book a new appointment, see your appointments, change them (same doctor) or cancel them, tell you the consultation hours, '
      + 'receipts and notices, and pass your request to the administrative staff (it goes to their inbox; it is not immediate care). '
      + 'Operations are only made when you press «Confirm».',
  },
  avisos: {
    es: 'Avisos: solo en la pestaña «Avisos» de esta aplicación: confirmaciones, recordatorios unas 24 h y 1 h antes de la cita, y ofertas de adelanto '
      + 'si se libera un horario antes con el mismo médico y lo pediste. No se envían SMS, correos ni llamadas.',
    en: 'Notices: only in the «Notices» tab of this app: confirmations, reminders about 24 h and 1 h before the appointment, and earlier-slot offers '
      + 'if a time frees up with the same doctor and you asked for it. No SMS, emails or calls are sent.',
  },
  acceso: {
    es: 'Acceso: no hace falta registrarse; tu sesión queda en este dispositivo. Para reservar se piden solo nombre y fecha de nacimiento (ficticios). '
      + 'Para volver desde otro dispositivo se usa tu código de recuperación junto con tu fecha de nacimiento.',
    en: 'Access: no sign-up is needed; your session stays on this device. To book, only a name and date of birth (fictitious) are asked. '
      + 'To come back from another device, use your recovery code together with your date of birth.',
  },
  otro: {
    es: 'No tengo esa información verificada, así que no puedo confirmarla. Sí puedo informarte sobre horarios de consulta, comprobantes, avisos, '
      + 'acceso, especialidades, reglas para reservar y lo que puedo hacer por ti.',
    en: 'I don’t have that information verified, so I cannot confirm it. I can tell you about consultation hours, receipts, notices, '
      + 'access, specialties, booking rules and what I can do for you.',
  },
};

/** Respuesta verificada para un tema institucional en es/en (otros idiomas: español con aviso, como la agenda). */
export async function serviceInfo(c: PoolClient, topic: ServiceTopic, lang: string, specialty: string | null, doctors: Omit<DoctorFilter, 'specialty'> = {}): Promise<{ text: string; lang: Lang; schedule?: ScheduleCard }> {
  const l: Lang = lang === 'en' ? 'en' : 'es';
  switch (topic) {
    case 'horarios': return { ...(await hours(c, l, specialty)), lang: l };
    case 'politicas': return { text: await policies(c, l), lang: l };
    case 'especialidades': return { text: await specialties(c, l, { specialty, ...doctors }), lang: l };
    case 'ubicacion_contacto': return { text: await location(c, l), lang: l };
    case 'precios_seguros': return { text: await prices(c, l, specialty), lang: l };
    default: return { text: STATIC[topic][l], lang: l };
  }
}
