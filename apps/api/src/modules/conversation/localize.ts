// Localización DETERMINISTA de las respuestas verificadas (capas de agenda y operaciones).
// El modelo nunca traduce horarios, referencias ni nombres: estas reglas convierten los textos del motor (que
// siempre se generan en español con formatos propios y conocidos) a los idiomas con plantillas verificadas.
// Idiomas con plantillas verificadas: es (origen) y en. En otros idiomas la conversación general la redacta el
// modelo y los datos de agenda se muestran en español (se informa con `lang_fallback`).

import type { Reply } from './engine.js';

export const VERIFIED_LANGS = ['es', 'en'] as const;
export type VerifiedLang = (typeof VERIFIED_LANGS)[number];

const WEEKDAYS: Record<string, string> = { lunes: 'Monday', martes: 'Tuesday', 'miércoles': 'Wednesday', jueves: 'Thursday',
  viernes: 'Friday', 'sábado': 'Saturday', domingo: 'Sunday' };
const MONTHS: Record<string, string> = { enero: 'January', febrero: 'February', marzo: 'March', abril: 'April', mayo: 'May', junio: 'June',
  julio: 'July', agosto: 'August', septiembre: 'September', setiembre: 'September', octubre: 'October', noviembre: 'November', diciembre: 'December' };
const SPECIALTIES: Record<string, string> = { 'Cardiología': 'Cardiology', 'Pediatría': 'Pediatrics', 'Medicina Interna': 'Internal Medicine',
  'Medicina General': 'General Medicine', 'Ginecología': 'Gynecology', 'Dermatología': 'Dermatology' };

const WD = '(lunes|martes|miércoles|jueves|viernes|sábado|domingo)';
const MO = '(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre)';

/** «lunes, 26 de octubre de 2026, 8:00 a. m.» → «Monday, October 26, 2026, 8:00 AM» (formato propio de spanishLabel). */
function dates(t: string): string {
  return t
    .replace(new RegExp(`${WD}, (\\d{1,2}) de ${MO} de (\\d{4}), (\\d{1,2}):(\\d{2})\\s?([ap])\\.\\s?m\\.`, 'g'),
      (_m, wd, d, mo, y, h, mi, ap) => `${WEEKDAYS[wd]}, ${MONTHS[mo]} ${d}, ${y}, ${h}:${mi} ${ap === 'a' ? 'AM' : 'PM'}`)
    .replace(new RegExp(`${WD} (\\d{1,2}) de ${MO}`, 'g'), (_m, wd, d, mo) => `${WEEKDAYS[wd]}, ${MONTHS[mo]} ${d}`)
    .replace(new RegExp(`(\\d{1,2}) de ${MO}`, 'g'), (_m, d, mo) => `${MONTHS[mo]} ${d}`)
    .replace(/los próximos (\d+) días/g, 'the next $1 days')
    .replace(/la semana del /g, 'the week of ')
    .replace(/esta semana/g, 'this week')
    .replace(/los días siguientes/g, 'the following days');
}

function names(t: string): string {
  let out = t;
  for (const [es, en] of Object.entries(SPECIALTIES)) out = out.replaceAll(es, en);
  return out.replace(/\(ficticia\)|\(ficticio\)/g, '(fictitious)');
}

/** Reglas de frases (en orden). Cada una cubre un texto completo o un fragmento fijo del motor. */
const RULES: [RegExp, string | ((...m: string[]) => string)][] = [
  [/^Estos son los horarios disponibles para (.+?):$/m, 'These are the available times for $1:'],
  [/^Más horarios disponibles:$/m, 'More available times:'],
  [/^No encontré horarios disponibles para (.+?)\. Los más próximos después de esa fecha son:$/m, 'I found no available times for $1. The closest ones after that date are:'],
  [/Elige un horario con su botón o escribe su número\./g, 'Choose a time with its button or type its number.'],
  [/^(\d+)\. (.+?) · (.+?) con (.+)$/gm, '$1. $2 · $3 with $4'],
  [/Puedo ayudarte a reservar, consultar, reprogramar o cancelar citas, o pasar tu solicitud al personal administrativo\./g,
    'I can help you book, check, reschedule or cancel appointments, or pass your request to the administrative staff.'],
  [/Por ejemplo: «Quiero una cita de cardiología el martes por la mañana»\./g, 'For example: “I want a cardiology appointment on Tuesday morning”.'],
  [/^¡Hola! 👋 Soy el asistente de citas de SaludCita\./m, 'Hi! 👋 I’m the SaludCita appointment assistant.'],
  [/^¡Buenos días! 👋 Soy el asistente de citas de SaludCita\./m, 'Good morning! 👋 I’m the SaludCita appointment assistant.'],
  [/^¡Buenas tardes! 👋 Soy el asistente de citas de SaludCita\./m, 'Good afternoon! 👋 I’m the SaludCita appointment assistant.'],
  [/^¡Buenas noches! 👋 Soy el asistente de citas de SaludCita\./m, 'Good evening! 👋 I’m the SaludCita appointment assistant.'],
  [/^¡Con gusto! 😊 Si necesitas algo más con tus citas, aquí estoy\.$/m, 'You’re welcome! 😊 If you need anything else with your appointments, I’m here.'],
  [/^¡Hasta pronto! 👋 Cuando quieras, escríbeme para reservar o revisar tus citas\.$/m, 'See you soon! 👋 Write to me whenever you want to book or check your appointments.'],
  [/^¿Para qué especialidad necesitas la cita\? Disponibles: (.+)\.$/m, (_m, l) => `Which specialty do you need the appointment for? Available: ${l}.`],
  [/^¿Para qué especialidad\?$/m, 'Which specialty?'],
  [/^Esa especialidad no está disponible\. Elige otra\.$/m, 'That specialty is not available. Please choose another one.'],
  [/^El (.+) ya pasó\. ¿Para qué otra fecha buscas la cita\?$/m, '$1 has already passed. What other date are you looking for?'],
  [/^¿Qué fecha prefieres\?$/m, 'Which date do you prefer?'],
  [/^Esa opción de fecha ya no está vigente\.$/m, 'That date option is no longer valid.'],
  [/^No tienes citas próximas activas\.$/m, 'You have no upcoming active appointments.'],
  [/^No encontré una cita activa tuya con la referencia (\S+)\. ¿Cuál de estas quieres cancelar\?$/m, 'I couldn’t find an active appointment of yours with reference $1. Which of these do you want to cancel?'],
  [/^No encontré una cita activa tuya con la referencia (\S+)\. ¿Cuál de estas quieres cambiar\?$/m, 'I couldn’t find an active appointment of yours with reference $1. Which of these do you want to change?'],
  [/^¿Qué cita quieres cancelar\?$/m, 'Which appointment do you want to cancel?'],
  [/^¿Qué cita quieres cambiar\?$/m, 'Which appointment do you want to change?'],
  [/^Esa cita ya no está activa\.$/m, 'That appointment is no longer active.'],
  [/^Vas a cancelar la cita (.+?)\. Para hacerlo, pulsa «Confirmar»\. Si no, pulsa «Descartar»\.$/m, 'You are about to cancel the appointment $1. To do it, press “Confirmar” (Confirm). If not, press “Descartar” (Discard).'],
  [/Vas a cambiar la cita (\S+) con el mismo médico\. /g, 'You are about to change appointment $1 with the same doctor. '],
  [/^Reservar: (.+?)\. El horario no queda apartado hasta que pulses «Confirmar»; se vuelve a comprobar al confirmar\.$/m,
    'Book: $1. The time is not held until you press “Confirmar” (Confirm); it is checked again when you confirm.'],
  [/^Cambiar a: (?:al )?(.+?)\. El horario no queda apartado hasta que pulses «Confirmar»; se vuelve a comprobar al confirmar\.$/m,
    'Change to: $1. The time is not held until you press “Confirmar” (Confirm); it is checked again when you confirm.'],
  [/^No hay una opción (\d+)\. Elige entre 1 y (\d+)\.$/m, 'There is no option $1. Choose between 1 and $2.'],
  [/^No hay horarios ofrecidos en este momento\. Dime qué cita buscas\.$/m, 'There are no times on offer right now. Tell me which appointment you are looking for.'],
  [/^¿Qué número de opción eliges\?$/m, 'Which option number do you choose?'],
  [/^Para confirmar necesito que pulses el botón «Confirmar»\. Así evitamos cambios por error\.$/m, 'To confirm, please press the “Confirmar” (Confirm) button. That way we avoid changes by mistake.'],
  [/^De acuerdo, no hice ningún cambio\. ¿Necesitas algo más\?$/m, 'All right, I made no changes. Do you need anything else?'],
  [/^Descartado\. No hice ningún cambio\.$/m, 'Discarded. I made no changes.'],
  [/^¿Qué quieres hacer\? /m, 'What would you like to do? '],
  [/^Tus próximas citas:$/m, 'Your upcoming appointments:'],
  [/^• (\S+) · (.+?) con (.+?) · (.+)$/gm, '• $1 · $2 with $3 · $4'],
  [/^(\S+) · (.+?) con (.+?) · (.+)$/gm, '$1 · $2 with $3 · $4'],
  [/^Registré tu solicitud de ayuda administrativa con la referencia (\S+)\. El personal la verá en su bandeja; todavía nadie la ha respondido\. Mientras tanto puedes seguir usando el asistente\.$/m,
    'I registered your request for administrative help with reference $1. The staff will see it in their inbox; nobody has answered it yet. Meanwhile you can keep using the assistant.'],
  [/Solo puedo ayudarte con la gestión de citas; no doy orientación médica\. Si es una urgencia, acude a emergencias o llama al 9-1-1\./g,
    'I can only help with managing appointments; I don’t give medical advice. If it is an emergency, go to the emergency room or call 9-1-1.'],
  [/ ¿Quieres reservar una cita\?$/m, ' Would you like to book an appointment?'],
  [/^No entendí la solicitud o está fuera de lo que puedo hacer\. (.+?) Elige una opción:$/m, 'I didn’t understand the request or it is outside what I can do. $1 Choose an option:'],
  [/No estoy seguro de haber entendido\. (.+?) Elige una opción o escríbelo de otra forma\./g, 'I’m not sure I understood. $1 Choose an option or write it another way.'],
  [/^No pude interpretar tu mensaje con el asistente de IA en este momento\. Usa los botones del menú; funcionan igual\.$/m,
    'I couldn’t interpret your message with the AI assistant right now. Use the menu buttons; they work just the same.'],
  [/^Esa operación no se completó\. No hubo cambios en tus citas\.$/m, 'That operation was not completed. There were no changes to your appointments.'],
  [/^Listo: tu cita (\S+) con (.+?) quedó confirmada para el (.+?)\.$/m, 'Done: your appointment $1 with $2 is confirmed for $3.'],
  [/^Listo: tu cita (\S+) ahora es el (.+?) con (.+?)\.$/m, 'Done: your appointment $1 is now on $2 with $3.'],
  [/^Listo: la cita (\S+) del (.+?) quedó cancelada\.$/m, 'Done: the appointment $1 on $2 is cancelled.'],
  [/^La cita (\S+) ya estaba cancelada\.$/m, 'The appointment $1 was already cancelled.'],
  [/^Te leo\. Si quieres, también puedo ayudarte con tus citas\.$/m, 'I’m listening. If you like, I can also help with your appointments.'],
  [/^Seguimos\. Estos son los horarios que te mostré:$/m, 'Let’s continue. These are the times I showed you:'],
  [/^Seguimos con: (.+?)\. Para hacerlo, pulsa «Confirmar»\. Si no, pulsa «Descartar»\.$/m, 'Let’s continue with: $1. To do it, press “Confirmar” (Confirm). If not, press “Descartar” (Discard).'],
  [/^No hay ninguna gestión pendiente\. /m, 'There is nothing pending. '],
  [/^No estoy seguro de haber entendido\. ¿Te refieres a alguna de estas opciones\? Elige una opción o escríbelo de otra forma\.$/m,
    'I’m not sure I understood. Do you mean one of these options? Choose an option or write it another way.'],
  [/^Esa cita no forma parte de las opciones mostradas\.$/m, 'That appointment is not one of the options shown.'],
  [/^No hay una búsqueda activa\.$/m, 'There is no active search.'],
  [/^¿Qué opción quieres\?/m, 'Which option do you want?'],
];

const LABELS: [RegExp, string][] = [
  [/^Reservar una cita$/, 'Book an appointment'], [/^Ver mis citas$/, 'See my appointments'],
  [/^Cambiar o cancelar una cita$/, 'Change or cancel an appointment'], [/^Hablar con el personal$/, 'Talk to the staff'],
  [/^Cancelar una cita$/, 'Cancel an appointment'], [/^Cambiar una cita$/, 'Change an appointment'],
  [/^Reservar cita de (.+)$/, 'Book $1 appointment'], [/^Continuar con mi cita$/, 'Continue with my appointment'],
];

function translateText(t: string): { text: string; complete: boolean } {
  let out = t;
  for (const [re, rep] of RULES) out = out.replace(re, rep as never);
  out = names(dates(out)).replace(/ con (Dra?\.|Doctora?) /g, ' with $1 ');
  // Al convertir «a. m.» en «AM» se pierde el punto final de la frase: se repone
  if (/\.$/.test(t) && !/[.?!:]$/.test(out)) out += '.';
  // ¿Queda español sin traducir? (palabras funcionales frecuentes) → se marca para la evaluación
  const leftover = /\b(el|la|los|las|de|del|que|para|con|tu|tus|una|cita|citas|horario|horarios)\b/i.test(
    out.replace(/\b(SC|AY)-[A-Z0-9]{6}\b/g, '').replace(/(Dra?\.|Doctor[a]?) [^·,.\n]+/g, ''));
  return { text: out, complete: !leftover };
}

function label(l: string): string {
  let out = l;
  for (const [re, rep] of LABELS) out = out.replace(re, rep);
  return names(dates(out)).replace(/ con /g, ' with ');
}

/** Aviso (no conversación) cuando los datos verificados se muestran en español por falta de plantillas. */
const AGENDA_IN_SPANISH: Record<string, string> = {
  pt: '(Os detalhes da agenda aparecem em espanhol.)', fr: '(Les détails du rendez-vous sont affichés en espagnol.)',
  it: '(I dettagli degli appuntamenti sono mostrati in spagnolo.)', de: '(Die Termindetails werden auf Spanisch angezeigt.)',
};

/** Devuelve la respuesta en el idioma pedido. es: sin cambios. en: plantillas verificadas. Otros: español + bandera. */
export function localizeReply(reply: Reply, lang: string): Reply & { lang: string; lang_fallback?: boolean } {
  if (lang === 'es') return { ...reply, lang: 'es' };
  // Información institucional ya redactada en el idioma (plantillas verificadas es/en)
  if (reply.prelocalized === lang) return { ...reply, lang };
  if (reply.prelocalized && lang !== 'en') {
    const notice = AGENDA_IN_SPANISH[lang];
    return { ...reply, lang, lang_fallback: true, text: notice ? `${notice}\n\n${reply.text}` : reply.text };
  }
  if (lang !== 'en') {
    const notice = AGENDA_IN_SPANISH[lang];
    return { ...reply, lang, lang_fallback: true, text: notice ? `${notice}\n\n${reply.text}` : reply.text };
  }
  const t = translateText(reply.text);
  return {
    ...reply,
    text: t.text,
    lang: 'en',
    ...(t.complete ? {} : { lang_fallback: true }),
    options: reply.options?.map((o) => ({ ...o, label: label(o.label), specialty: names(o.specialty) })),
    date_choices: reply.date_choices?.map((d) => ({ ...d, label: label(d.label) })),
    appointment_choices: reply.appointment_choices?.map((a) => ({ ...a, label: label(a.label) })),
    specialty_choices: reply.specialty_choices?.map((s) => ({ ...s, name: names(s.name) })),
    suggestions: reply.suggestions?.map((s) => ({ ...s, label: label(s.label) })),
    proposal: reply.proposal ? { ...reply.proposal, summary: translateText(reply.proposal.summary.replace(/^Cambiar al /, 'Cambiar a ')).text
      .replace(/^Cancelar /, 'Cancel ').replace(/^Cambiar a /, 'Change to ').replace(/ con /g, ' with ') } : undefined,
  };
}
