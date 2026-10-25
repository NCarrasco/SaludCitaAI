// Anclaje determinista: una entidad extraída por el modelo solo se usa si el texto del paciente
// contiene una pista que la respalde (tolerando errores tipográficos). Evita que valores inventados
// por el modelo (p. ej., una franja horaria no mencionada) filtren horarios.

import { detectTimeOfDay, normalize } from './dates.js';

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const dp = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0]!;
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j]!;
      dp[j] = Math.min(dp[j]! + 1, dp[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length]!;
}

export function tokens(text: string): string[] {
  return normalize(text).replace(/[^a-z0-9ñ\s/]/g, ' ').split(/\s+/).filter(Boolean);
}

/** ¿Aparece alguna de las palabras (o una variante con hasta 2 errores si es larga) en el texto? */
export function hasCue(text: string, words: string[]): boolean {
  const toks = tokens(text);
  return words.some((w) => {
    const parts = w.split(' ');
    if (parts.length > 1) return normalize(text).includes(w);
    return toks.some((t) => t === w || (w.length >= 6 && t.length >= 5 && levenshtein(t, w) <= 2));
  });
}

export function groundedTimeOfDay(value: 'morning' | 'afternoon' | null, text: string): 'morning' | 'afternoon' | null {
  if (value === 'afternoon') return hasCue(text, ['tarde', 'mediodia']) ? value : null;
  // «mañana» suele ser el día siguiente: la franja matutina exige «por/en/de la mañana» o «temprano»
  if (value === 'morning') return detectTimeOfDay(text) === 'morning' ? value : null;
  return null;
}

const DATE_STOP = new Set(['el', 'la', 'los', 'las', 'de', 'del', 'para', 'en', 'por', 'a', 'al', 'proximo', 'proxima', 'este', 'esta', 'que', 'viene']);

/**
 * La fecha que propone el modelo solo se usa si sus palabras aparecen en el mensaje del paciente.
 * Evita fechas inventadas (p. ej., «hoy» en «necesito cita para mi hijo»).
 */
export function groundedDatePhrase(phrase: string | null | undefined, text: string): string | null {
  if (!phrase) return null;
  const words = tokens(phrase).filter((w) => !DATE_STOP.has(w));
  if (words.length === 0) return null;
  return words.every((w) => /^\d+$/.test(w) ? tokens(text).includes(w) : hasCue(text, [w])) ? phrase : null;
}

const ORDINALS: [RegExp, number][] = [
  [/\b(primer[ao]?|1(ra|ro|ª|º)?|uno|una)\b/, 1], [/\b(segund[ao]|2(da|do|ª|º)?|dos)\b/, 2],
  [/\b(tercer[ao]?|3(ra|ro|ª|º)?|tres)\b/, 3], [/\b(cuart[ao]|4(ta|to)?|cuatro)\b/, 4],
];

/** Número de opción mencionado en el texto («la segunda», «opción 1», «quiero la 3»), o null. */
export function ordinalInText(text: string): number | null {
  const t = normalize(text);
  if (t.split(' ').length > 6) return null; // frases largas: no se interpreta como elección
  for (const [re, n] of ORDINALS) if (re.test(t)) return n;
  return null;
}

/** Respuesta corta afirmativa o negativa a una propuesta pendiente. */
export function yesNo(text: string): 'affirm' | 'deny' | null {
  const t = normalize(text).replace(/[^a-z\s]/g, ' ').trim();
  if (/^(no|nop|mejor no|no gracias|descarta|dejalo|olvidalo)\b/.test(t)) return 'deny';
  if (/^(si|dale|ok|okay|vale|de acuerdo|perfecto|confirma|confirmala|confirmalo|claro|listo)\b/.test(t)) return 'affirm';
  return null;
}

/** ¿El texto pide una cita aunque el modelo haya devuelto otra intención incoherente con el estado? */
export function looksLikeBooking(text: string): boolean {
  return hasCue(text, ['cita', 'turno', 'consulta', 'agendar', 'agendame', 'reservar', 'disponibilidad', 'medico', 'doctor', 'doctora']);
}

/** ¿El texto habla de salud (síntomas, dolor, medicamentos, urgencias)? Varios idiomas; tolera errores leves. */
const HEALTH_CUES = ['duele', 'dolor', 'fiebre', 'sintoma', 'sintomas', 'enfermo', 'enferma', 'mareo', 'vomito', 'tos', 'medicamento', 'medicina',
  'pastilla', 'tomo', 'tomar', 'urgencia', 'emergencia', 'sangre', 'presion', 'diagnostico', 'tratamiento', 'me siento mal', 'me siento muy mal',
  'pain', 'hurts', 'fever', 'sick', 'symptom', 'symptoms', 'medicine', 'medication', 'pill', 'emergency', 'bleeding', 'dizzy', 'cough',
  'dor', 'febre', 'doente', 'remedio', 'douleur', 'fievre', 'malade', 'medicament'];
export function looksClinical(text: string): boolean {
  return hasCue(text, HEALTH_CUES);
}
