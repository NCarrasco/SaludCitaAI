// Capa 1: conversación general GENERADA por el modelo (segunda llamada, orquestada por n8n).
// El modelo conversa con libertad (saludos, preguntas variadas, cambios de tema, empatía) y puede usar SOLO la
// guía documentada del servicio (capa 2). No puede afirmar horarios, citas ni operaciones: eso pertenece a las
// capas 3 y 4 (API y confirmación con botón). Cada texto se valida; si no pasa, se usa el texto verificado.

import { detectLanguage, hasLanguageSignal, LANG_NAMES } from './lang.js';

export const CONVERSE_PROMPT_VERSION = 'converse-v3';

export const CONVERSE_FORMAT = { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } as const;

/**
 * reply: respuesta conversacional completa · empathy: una frase empática antes del texto de seguridad (pregunta clínica)
 * grounded: respuesta en lenguaje natural a una pregunta sobre datos, usando SOLO los datos que la API leyó de PostgreSQL
 */
export type ConverseMode = 'reply' | 'empathy' | 'grounded';

export interface ConverseInput {
  mode: ConverseMode;
  patientText: string;
  lang: string;                 // idioma en el que hay que responder
  history: { role: 'user' | 'assistant'; content: string }[];
  quoted?: { role: 'user' | 'assistant'; text: string } | null;
  guide: string;                // capa 2: hechos documentados
  pending?: string | null;      // gestión de cita en curso (para retomarla tras cambiar de tema)
  orient: boolean;              // ¿conviene ofrecer ayuda con la agenda en este turno?
  patientName?: string | null;
  /** Hora local del hospital y saludo que corresponde (buenos días / buenas tardes / buenas noches) */
  clock?: { time: string; greeting: string; greetingEn: string };
  topic: 'chat' | 'service_info' | 'greeting' | 'help' | 'clinical_question';
  /** grounded: datos verificados (texto) que responden la pregunta */
  facts?: string;
}

function systemPrompt(i: ConverseInput): string {
  const langName = LANG_NAMES[i.lang] ?? 'el mismo idioma del último mensaje del paciente';
  if (i.mode === 'grounded') {
    return [
      'Eres Salu, la asistente virtual de SaludCita (no eres una persona). El paciente hizo una pregunta y el sistema consultó la base de datos.',
      `Responde en ${langName}, de forma natural, cálida y breve, como en un chat, contestando EXACTAMENTE lo que preguntó.`,
      'Usa SOLO estos datos verificados (no añadas médicos, días, horas, precios ni nada que no aparezca aquí; copia horas y cifras tal cual):',
      '<<<DATOS',
      i.facts ?? '',
      'DATOS>>>',
      'Si los datos no responden del todo la pregunta, dilo con sencillez y ofrece lo que sí sabes. Puedes resumir u ordenar los datos.',
      'No afirmes que reservaste ni cambiaste nada (eso se hace con los botones). Una «propuesta pendiente» NO es una cita: '
        + 'di que está pendiente de que pulse «Confirmar». No des consejos médicos. No saludes si la conversación ya empezó.',
      i.patientName ? `El paciente se llama ${i.patientName}.` : '',
      'Máximo 6 frases o una lista corta. Si das una lista, pon cada elemento en su propia línea empezando con «• ». Devuelve solo JSON: {"text": "..."}',
    ].filter(Boolean).join('\n');
  }
  if (i.mode === 'empathy') {
    return [
      'Eres Salu, la asistente virtual de SaludCita (no eres una persona). El paciente acaba de mencionar un problema de salud.',
      `Escribe UNA sola frase breve y cálida de empatía en ${langName}. No des consejos, diagnósticos, medicamentos ni recomendaciones:`,
      'debajo de tu frase el sistema añadirá el aviso de seguridad oficial. Devuelve solo JSON: {"text": "..."}',
    ].join('\n');
  }
  return [
    'Eres Salu, la asistente virtual de SaludCita (no eres una persona y no lo finges; si te preguntan tu nombre, eres Salu). Conversas de forma natural, cálida y cercana, como una buena recepcionista por chat: frases cortas, sin tecnicismos ni tono de máquina.',
    `Responde en ${langName}, el idioma de la conversación.`,
    'Responde SOLO a lo que el paciente dijo en su último mensaje, de verdad y con contenido. Si solo saluda («hola», «buenas»), devuelve el saludo y ofrece ayuda: no digas «gracias por preguntar» ni contestes preguntas que no hizo. Puedes conversar de temas generales, explicar conceptos y responder preguntas de cultura general.',
    'Al abrir el chat, el paciente ya vio tu bienvenida (te presentaste como Salu y saludaste). No vuelvas a presentarte, no repitas tu nombre ni el saludo de bienvenida: '
      + 'si el paciente saluda, responde breve y natural, como alguien que ya está conversando («¡Hola! ¿En qué te ayudo?»), y varía tus frases.',
    i.clock ? `Hora actual en el hospital (Santo Domingo): ${i.clock.time}. Si es oportuno saludar (por ejemplo, el paciente dice «buenas»), usa el saludo de esa hora: «${i.clock.greeting}» (en inglés, «${i.clock.greetingEn}»; en otro idioma, su equivalente).` : '',
    'Puedes explicar en términos GENERALES qué trata una especialidad médica o qué es un concepto de salud (educación general), sin aplicarlo al caso de la persona.',
    'Ejemplos de tono:',
    '- «hola» → «¡Hola! ¿En qué te puedo ayudar?»',
    `- «buenas» → «¡${i.clock?.greeting ?? 'Hola'}! Dime, ¿en qué te ayudo?»`,
    '- «¿cómo estás?» → «¡Muy bien, gracias por preguntar! ¿Y tú qué tal? ¿En qué te ayudo?»',
    '- «¿qué hace un cardiólogo?» → «Un cardiólogo es el médico especialista en el corazón y los vasos sanguíneos: estudia, previene y trata sus enfermedades. Si quieres, te ayudo a ver citas de Cardiología.»',
    '- «gracias» → «¡Con gusto! Que tengas un buen día.»',
    'Nunca digas que estás «funcionando correctamente» ni hables de ti como un sistema. Reglas:',
    '- Si no sabes algo o es ambiguo, dilo; no inventes. No tienes internet ni noticias recientes: no digas que has consultado fuentes.',
    '- Sobre SaludCita usa SOLO estos hechos documentados; si algo no aparece aquí, di que no tienes esa información:',
    i.guide,
    '- Nunca afirmes horarios, fechas, citas, referencias ni que reservaste, cambiaste o cancelaste algo: eso lo hace el sistema con botones.',
    '- No afirmes días u horas de atención, comprobantes, normas, precios, seguros, direcciones ni teléfonos del hospital: esa información la da el sistema con datos verificados. Si te preguntan, di que puede preguntármelo directamente (por ejemplo «¿cuál es el horario de atención?»).',
    '- No diagnostiques ni recomiendes tratamientos o medicamentos. Ante urgencias, emergencias o el 9-1-1.',
    '- No pidas cédula, contraseñas ni códigos.',
    i.orient
      ? '- Al final, si encaja, ofrece con suavidad ayuda para gestionar sus citas (una sola frase).'
      : '- NO termines ofreciendo citas: ya se ofreció hace poco. Solo responde.',
    i.pending ? `- El paciente tenía una gestión en curso (${i.pending}). Recuérdale con una frase corta que puede retomarla cuando quiera.` : '',
    i.patientName ? `- El paciente se llama ${i.patientName}.` : '',
    i.quoted ? `- El paciente responde a este mensaje anterior: «${i.quoted.text.slice(0, 300)}»` : '',
    'Máximo 4 frases. Devuelve solo JSON: {"text": "..."}',
  ].filter(Boolean).join('\n');
}

export function buildConverseRequest(model: string, i: ConverseInput, opts: { think?: boolean } = {}) {
  return {
    model, stream: false, format: CONVERSE_FORMAT, keep_alive: '30m',
    ...(opts.think === undefined ? {} : { think: opts.think }),
    options: { temperature: i.mode === 'grounded' ? 0.3 : 0.6, num_ctx: 3072, num_predict: i.mode === 'empathy' ? 60 : i.mode === 'grounded' ? 320 : 200 },
    messages: [
      { role: 'system', content: systemPrompt(i) },
      ...i.history.slice(-10).map((h) => ({ role: h.role, content: h.content.slice(0, 400) })),
      { role: 'user', content: i.patientText },
    ],
  };
}

const W = '(?![\\wáéíóúñ])';
const CLAIMS = new RegExp(`(reserv[eé]|reservado|agend[eé]|agendado|confirm[eé]|cancel[eé]|booked|scheduled|reservei|agendei|réservé|annulé)${W}.{0,40}(cita|appointment|consulta|rendez-vous)`, 'i');
const FORBIDDEN: [RegExp, string][] = [
  [/\b\d{1,2}[:h]\d{2}\b|\b\d{1,2}\s?(a\.\s?m\.|p\.\s?m\.|am|pm)\b/i, 'menciona una hora'],
  [/\b(SC|AY)-[A-Z0-9]{4,}/i, 'menciona una referencia'],
  [CLAIMS, 'afirma una operación'],
  [/\b\d+\s?(mg|ml|mcg|gotas|drops|comprimidos|pastillas|tablets?)\b/i, 'dosis'],
  [/\b(ibuprofeno|ibuprofen|paracetamol|acetaminof[eé]n|aspirina|aspirin|amoxicilina|antibi[oó]tico|antibiotic|diclofenac)/i, 'medicamento'],
  [/(busqu[eé]|consult[eé]|searched|looked up|pesquisei|cherché).{0,30}(internet|web|google|noticias|news|online)/i, 'afirma consultar fuentes'],
  // Pedir datos sensibles (mencionar que existe el código de recuperación sí está permitido: es información del servicio)
  [/(dame|dime|me das|me pasas|me dices|cu[aá]l es (tu|su)|ind[ií]came|env[ií]ame|escr[ií]beme|comp[aá]rteme|proporci[oó]name|necesito (tu|su)|give me|send me|tell me|what is your|provide|share).{0,30}(c[eé]dula|contrase[nñ]a|password|c[oó]digo|code|PIN)/i, 'pide datos sensibles'],
  [/https?:|www\.|@[a-z]/i, 'enlace o contacto'],
  [/<|`/, 'marcado'],
  // Afirmaciones institucionales: solo las da la rama «información del servicio» con datos verificados
  [/(fin(es)? de semana|weekends?|s[aá]bados?|domingos?|lunes|martes|mi[eé]rcoles|jueves|viernes|monday|tuesday|wednesday|thursday|friday|saturday|sunday).{0,40}(atend|abr|cerr|consult|open|close|clos|horario|hours)|(atend|abr|cerr|open|close).{0,40}(fin(es)? de semana|weekends?|s[aá]bados?|domingos?|lunes|viernes|monday|friday|saturday|sunday)/i, 'afirma horarios de atención'],
  [/(horario de atenci[oó]n|opening hours|business hours|abrimos|cerramos|we open|we close)/i, 'afirma horarios de atención'],
  [/(comprobante|recibo|receipt|factura|invoice)/i, 'habla de comprobantes'],
  [/(precio|cuesta|costo|tarifa|seguro m[eé]dico|aseguradora|price|cost|fee|insurance)/i, 'habla de precios o seguros'],
  [/(direcci[oó]n (es|del|de la|de nuestro)|estamos ubicad|ubicad[oa]s? en|tel[eé]fono (del hospital|de contacto|es)|nuestro tel[eé]fono|address is|located at|phone number is|our phone)/i, 'afirma dirección o teléfono'],
];
const ADVICE = /\b(toma|tome|tomar|take|debes|deber[ií]as|should|recomiendo|recommend|aplica|bebe|drink|descansa|descansar|rest|hidr[aá]t\w*|hydrat\w*|stay|mantente|evita|avoid|try to|intenta|reposo|consult(e|a|ar)? (a|con) (un|tu)|see a doctor|consulta a un)\b/i;

export type ConverseCheck = { ok: true; text: string } | { ok: false; reason: string };

/** Validación independiente del texto generado (no garantiza exactitud: solo bloquea lo verificable). */
/** Números (horas, cifras, días del mes) de un texto, normalizados para compararlos con los datos */
function numbersOf(t: string): string[] {
  return [...t.matchAll(/\d+(?:[.,:]\d+)*/g)].map((m) => m[0].replace(/[.,](?=\d{3}\b)/g, '')).filter((x) => x.length > 0);
}

/**
 * Respuesta con datos: cada número (hora, precio, día) y cada médico que mencione debe estar en los datos verificados.
 * No comprueba que la respuesta sea completa: si omite algo, el paciente puede seguir preguntando.
 */
export function validateGrounded(content: unknown, lang: string, facts: string, doctorsInCatalog: string[]): ConverseCheck {
  if (typeof content !== 'string' || !content) return { ok: false, reason: 'respuesta vacía' };
  let raw: unknown;
  try { raw = JSON.parse(content); } catch { return { ok: false, reason: 'JSON no válido' }; }
  const text = (raw as { text?: unknown })?.text;
  if (typeof text !== 'string') return { ok: false, reason: 'sin campo text' };
  const t = text.replace(/[ \t]+/g, ' ').trim();
  if (t.length < 2) return { ok: false, reason: 'demasiado corto' };
  if (t.length > 1100) return { ok: false, reason: 'demasiado largo' };
  const factNums = new Set(numbersOf(facts));
  for (const x of numbersOf(t)) {
    if (!factNums.has(x) && !(x.includes(':') && factNums.has(x.replace(/^0/, '')))) return { ok: false, reason: `dato no verificado: ${x}` };
  }
  for (const m of t.matchAll(/\b(Dra?\.?|Doctora?|Dr\b)\s+([A-ZÁÉÍÓÚÑ][\wáéíóúñ]+)/g)) {
    if (!facts.includes(m[2]!) || !doctorsInCatalog.some((d) => d.includes(m[2]!))) return { ok: false, reason: 'médico no presente en los datos' };
  }
  if (CLAIMS.test(t)) return { ok: false, reason: 'afirma una operación' };
  // Con una propuesta sin confirmar, el texto no puede presentarla como una cita ya hecha
  if (/Propuesta pendiente:/.test(facts) && /(tu (pr[oó]xima )?cita (es|ser[aá]|est[aá]|queda)|tienes (una )?cita|your (next )?appointment (is|will be)|you have an appointment)/i.test(t)
      && !/(confirm|pendiente|pending)/i.test(t)) return { ok: false, reason: 'presenta una propuesta como cita' };
  for (const [re, reason] of FORBIDDEN.slice(3, 7)) if (re.test(t)) return { ok: false, reason };   // dosis, medicamentos, fuentes, datos sensibles
  if (/<|`/.test(t)) return { ok: false, reason: 'marcado' };
  // Enlaces o correos: solo los que están en los datos (p. ej., el correo del centro)
  for (const m of t.matchAll(/https?:\S+|www\.\S+|[\w.+-]+@[\w-]+\.[\w.]+/gi)) if (!facts.includes(m[0].replace(/[.,;]$/, ''))) return { ok: false, reason: 'enlace o contacto' };
  const got = detectLanguage(t);
  if (got && lang && got !== lang && LANG_NAMES[lang] && !hasLanguageSignal(t, lang)) return { ok: false, reason: `idioma ${got} en lugar de ${lang}` };
  return { ok: true, text: t };
}

export function validateConverse(content: unknown, i: Pick<ConverseInput, 'mode' | 'lang'>, doctorsInCatalog: string[] = [], allowedTimes: string[] = []): ConverseCheck {
  if (typeof content !== 'string' || !content) return { ok: false, reason: 'respuesta vacía' };
  let raw: unknown;
  try { raw = JSON.parse(content); } catch { return { ok: false, reason: 'JSON no válido' }; }
  const text = (raw as { text?: unknown })?.text;
  if (typeof text !== 'string') return { ok: false, reason: 'sin campo text' };
  const t = text.replace(/\s+/g, ' ').trim();
  if (t.length < 2) return { ok: false, reason: 'demasiado corto' };
  if (t.length > (i.mode === 'empathy' ? 220 : 700)) return { ok: false, reason: 'demasiado largo' };
  // La hora actual del hospital sí puede decirse («son las 9:15 p. m.»); cualquier otra hora sigue bloqueada
  const tc = allowedTimes.reduce((acc, h) => acc.split(h).join(' '), t);
  for (const [re, reason] of FORBIDDEN) if (re.test(tc)) return { ok: false, reason };
  if (i.mode === 'empathy' && ADVICE.test(t)) return { ok: false, reason: 'consejo en la frase de empatía' };
  // Empatía: UNA sola frase (el aviso de seguridad verificado va debajo)
  if (i.mode === 'empathy' && (t.match(/[.!?](\s|$)/g) ?? []).length > 1) return { ok: false, reason: 'empatía de más de una frase' };
  // Médicos: solo los del catálogo (con título)
  for (const m of t.matchAll(/\b(Dra?\.|Doctora?|Dr\b)\s+([A-ZÁÉÍÓÚÑ][\wáéíóúñ]+)/g)) {
    if (!doctorsInCatalog.some((d) => d.includes(m[2]!))) return { ok: false, reason: 'médico no documentado' };
  }
  // Idioma: si es detectable, debe coincidir con el de la conversación
  const got = detectLanguage(t);
  // En otro idioma que el español, una respuesta de cierta longitud debe tener señal clara de ese idioma
  // (evita copiar la guía en español en una conversación en inglés)
  if (i.lang && i.lang !== 'es' && LANG_NAMES[i.lang] && t.length > 40 && !hasLanguageSignal(t, i.lang)) return { ok: false, reason: `sin señal de ${i.lang}` };
  // (se admite citar palabras de otro idioma si la respuesta tiene señal clara del idioma de la conversación)
  if (got && i.lang && got !== i.lang && LANG_NAMES[i.lang] && !hasLanguageSignal(t, i.lang)) return { ok: false, reason: `idioma ${got} en lugar de ${i.lang}` };
  return { ok: true, text: t };
}
