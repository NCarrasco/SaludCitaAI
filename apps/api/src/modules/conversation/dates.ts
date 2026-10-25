// Resolución determinista de expresiones de fecha en español contra la fecha local del servidor.
// El modelo solo transcribe la expresión ("el martes", "28 de octubre"); este módulo calcula el intervalo.

export interface DayRange { from: string; to: string; label: string } // fechas locales AAAA-MM-DD, [from, to)

export type DateResolution =
  | { kind: 'none' }
  | { kind: 'range'; range: DayRange }
  | { kind: 'ambiguous'; question: string; choices: DayRange[] }
  | { kind: 'past'; label: string };

export type TimeOfDay = 'morning' | 'afternoon';

const WEEKDAYS = ['lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado', 'domingo']; // ISO 1..7
const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const WEEKDAY_LABEL = ['lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado', 'domingo'];

export function normalize(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
}

// Aritmética de fechas civiles en UTC (sin horas) para no depender de la zona del proceso
interface Civil { y: number; m: number; d: number }
const toUtc = (c: Civil) => Date.UTC(c.y, c.m - 1, c.d);
const fromUtc = (t: number): Civil => { const x = new Date(t); return { y: x.getUTCFullYear(), m: x.getUTCMonth() + 1, d: x.getUTCDate() }; };
const addDays = (c: Civil, n: number) => fromUtc(toUtc(c) + n * 86400_000);
const isoWeekday = (c: Civil) => ((new Date(toUtc(c)).getUTCDay() + 6) % 7) + 1;
const fmt = (c: Civil) => `${c.y}-${String(c.m).padStart(2, '0')}-${String(c.d).padStart(2, '0')}`;
const valid = (c: Civil) => { const r = fromUtc(toUtc(c)); return r.y === c.y && r.m === c.m && r.d === c.d; };

export function dayLabel(c: Civil): string {
  return `${WEEKDAY_LABEL[isoWeekday(c) - 1]} ${c.d} de ${MONTHS[c.m - 1]}`;
}

function oneDay(c: Civil): DayRange {
  return { from: fmt(c), to: fmt(addDays(c, 1)), label: `el ${dayLabel(c)}` };
}

export function localToday(now: Date, tz: string): Civil {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(now).map((x) => [x.type, x.value]));
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day) };
}

/** Elimina expresiones de franja horaria para que «por la mañana» no se lea como «mañana» (día siguiente). */
function stripTimeOfDay(t: string): string {
  return t.replace(/\b(por|en|de|a|x) la (manana|tarde|noche)\b/g, ' ').replace(/\btemprano\b/g, ' ');
}

export function detectTimeOfDay(text: string): TimeOfDay | null {
  const t = normalize(text);
  if (/\b(por|en|de|a|x) la manana\b|\btemprano\b|\bantes del mediodia\b/.test(t)) return 'morning';
  if (/\b(por|en|de|a|x) la tarde\b|\bdespues del mediodia\b/.test(t)) return 'afternoon';
  return null;
}

export function resolveDate(text: string, now: Date, tz: string): DateResolution {
  const today = localToday(now, tz);
  const t = stripTimeOfDay(normalize(text));

  if (/\bpasado manana\b/.test(t)) return { kind: 'range', range: oneDay(addDays(today, 2)) };
  if (/\bmanana\b/.test(t)) return { kind: 'range', range: oneDay(addDays(today, 1)) };
  if (/\bhoy\b/.test(t)) return { kind: 'range', range: oneDay(today) };

  if (/\b(proxima semana|semana que viene|siguiente semana|semana proxima)\b/.test(t)) {
    const monday = addDays(today, 8 - isoWeekday(today));
    return { kind: 'range', range: { from: fmt(monday), to: fmt(addDays(monday, 7)), label: `la semana del ${dayLabel(monday)}` } };
  }
  if (/\besta semana\b/.test(t)) {
    const end = addDays(today, 8 - isoWeekday(today));
    return { kind: 'range', range: { from: fmt(today), to: fmt(end), label: 'esta semana' } };
  }

  // «28 de octubre», «28 octubre»
  const dm = t.match(/\b(\d{1,2}) (?:de )?(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre)\b/);
  if (dm) {
    const m = dm[2] === 'setiembre' ? 9 : MONTHS.indexOf(dm[2]!) + 1;
    return absolute(Number(dm[1]), m, today);
  }
  // «28/10»
  const sl = t.match(/\b(\d{1,2})\/(\d{1,2})\b/);
  if (sl) return absolute(Number(sl[1]), Number(sl[2]), today);

  const wdMatch = t.match(/\b(lunes|martes|miercoles|jueves|viernes|sabado|domingo)\b/);
  const num = t.match(/\b(?:el|dia|el dia)\s+(\d{1,2})\b/) ?? (wdMatch ? t.match(/\b(?:lunes|martes|miercoles|jueves|viernes|sabado|domingo)\s+(\d{1,2})\b/) : null);

  if (num) {
    // «el 28» o «el martes 28»: día del mes actual o, si ya pasó, del siguiente
    const d = Number(num[1]);
    let c: Civil = { y: today.y, m: today.m, d };
    if (!valid(c) || toUtc(c) < toUtc(today)) c = { y: today.m === 12 ? today.y + 1 : today.y, m: today.m === 12 ? 1 : today.m + 1, d };
    if (!valid(c)) return { kind: 'none' };
    if (wdMatch && WEEKDAYS.indexOf(wdMatch[1]!) + 1 !== isoWeekday(c)) {
      return { kind: 'ambiguous', question: `El ${d} es ${WEEKDAY_LABEL[isoWeekday(c) - 1]}, no ${wdMatch[1]}. ¿Qué fecha prefieres?`,
        choices: [oneDay(c), oneDay(nextWeekday(today, WEEKDAYS.indexOf(wdMatch[1]!) + 1, false))] };
    }
    return { kind: 'range', range: oneDay(c) };
  }

  if (wdMatch) {
    const wd = WEEKDAYS.indexOf(wdMatch[1]!) + 1;
    const explicitNext = /\b(proximo|proxima|que viene|siguiente)\b/.test(t);
    const thisOne = /\beste\b|\besta\b/.test(t);
    const todayWd = isoWeekday(today);
    if (wd === todayWd && !explicitNext && !thisOne) {
      // «el martes» dicho un martes: hoy o el de la semana siguiente
      return { kind: 'ambiguous', question: `Hoy es ${WEEKDAY_LABEL[wd - 1]}. ¿Te refieres a hoy o al de la próxima semana?`,
        choices: [oneDay(today), oneDay(addDays(today, 7))] };
    }
    if (explicitNext && (wd - todayWd + 7) % 7 === 1) {
      // «el próximo martes» dicho un lunes: mañana o dentro de ocho días
      const tomorrow = addDays(today, 1);
      return { kind: 'ambiguous', question: `¿«El próximo ${WEEKDAY_LABEL[wd - 1]}» es mañana o el de la semana siguiente?`,
        choices: [oneDay(tomorrow), oneDay(addDays(tomorrow, 7))] };
    }
    return { kind: 'range', range: oneDay(nextWeekday(today, wd, thisOne)) };
  }
  return { kind: 'none' };
}

function nextWeekday(today: Civil, wd: number, allowToday: boolean): Civil {
  let delta = (wd - isoWeekday(today) + 7) % 7;
  if (delta === 0 && !allowToday) delta = 7;
  return addDays(today, delta);
}

function absolute(d: number, m: number, today: Civil): DateResolution {
  if (m < 1 || m > 12) return { kind: 'none' };
  let c: Civil = { y: today.y, m, d };
  if (!valid(c)) return { kind: 'none' };
  if (toUtc(c) < toUtc(today)) {
    // Una fecha ya pasada este año se interpreta como del año siguiente solo si cae en los próximos 60 días
    const nextYear: Civil = { y: today.y + 1, m, d };
    if (valid(nextYear) && toUtc(nextYear) - toUtc(today) <= 60 * 86400_000) c = nextYear;
    else return { kind: 'past', label: `${d} de ${MONTHS[m - 1]}` };
  }
  return { kind: 'range', range: oneDay(c) };
}

/** Intervalo por defecto: próximos 14 días desde hoy. */
export function defaultRange(now: Date, tz: string, days = 14): DayRange {
  const today = localToday(now, tz);
  return { from: fmt(today), to: fmt(addDays(today, days)), label: `los próximos ${days} días` };
}
