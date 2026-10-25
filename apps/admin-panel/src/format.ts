export const TZ = 'America/Santo_Domingo';
const nf = new Intl.NumberFormat('es-DO');
export const n = (x: number | null | undefined) => (x === null || x === undefined ? '—' : nf.format(x));
export const pct = (x: number | null | undefined, digits = 1) =>
  x === null || x === undefined ? '—' : `${new Intl.NumberFormat('es-DO', { maximumFractionDigits: digits }).format(x * 100)} %`;

/** Fecha local AAAA-MM-DD en la zona de negocio, desplazada `days` días. */
export function localDay(days = 0): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(Date.now() + days * 86400_000));
}

export const shortDate = (iso: string) =>
  new Intl.DateTimeFormat('es-DO', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${iso}T12:00:00Z`));

export const dateTime = (iso: string) =>
  new Intl.DateTimeFormat('es-DO', { dateStyle: 'medium', timeStyle: 'short', timeZone: TZ }).format(new Date(iso));

/** Convierte una fecha y hora local ('AAAA-MM-DDTHH:MM') de la zona dada a ISO con desplazamiento correcto. */
export function zonedToIso(local: string, tz = TZ): string {
  const [d, t] = local.split('T');
  const [y, m, day] = d!.split('-').map(Number);
  const [h, mi] = (t ?? '00:00').split(':').map(Number);
  const guess = Date.UTC(y!, m! - 1, day!, h!, mi!);
  const offsetAt = (ms: number) => {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit',
      day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
    return Date.UTC(+p.year!, +p.month! - 1, +p.day!, +p.hour!, +p.minute!) - ms;
  };
  return new Date(guess - offsetAt(guess - offsetAt(guess))).toISOString();
}

export const WEEKDAYS = ['lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado', 'domingo'];

/** Suma días a una fecha local AAAA-MM-DD (aritmética de calendario, sin zona). */
export function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** «18–24 oct 2026» o «18 sept – 24 oct 2026»; un solo día: «24 oct 2026». */
export function rangeLabel(from: string, toIncluded: string): string {
  const f = (iso: string, o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('es-DO', { ...o, timeZone: 'UTC' }).format(new Date(`${iso}T12:00:00Z`));
  if (from === toIncluded) return f(from, { day: 'numeric', month: 'short', year: 'numeric' });
  if (from.slice(0, 7) === toIncluded.slice(0, 7)) return `${f(from, { day: 'numeric' })}–${f(toIncluded, { day: 'numeric', month: 'short', year: 'numeric' })}`;
  return `${f(from, { day: 'numeric', month: 'short' })} – ${f(toIncluded, { day: 'numeric', month: 'short', year: 'numeric' })}`;
}

export const timeOf = (iso: string) => new Intl.DateTimeFormat('es-DO', { hour: 'numeric', minute: '2-digit', timeZone: TZ }).format(new Date(iso));
export const dayLong = (iso: string) => new Intl.DateTimeFormat('es-DO', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }).format(new Date(`${iso}T12:00:00Z`));
export function ago(iso: string): string {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return 'hace un momento';
  if (s < 3600) return `hace ${Math.round(s / 60)} min`;
  if (s < 86400) return `hace ${Math.round(s / 3600)} h`;
  if (s < 30 * 86400) { const d = Math.floor(s / 86400); return `hace ${d} ${d === 1 ? 'día' : 'días'}`; }
  return dateTime(iso);
}

/** Formatos consistentes en todo el panel (zona de negocio). */
export const fmtDay = (iso: string) => new Intl.DateTimeFormat('es-DO', { weekday: 'short', day: 'numeric', month: 'short', timeZone: TZ })
  .format(new Date(iso)).replace(/\./g, '');
export const fmtTime = (iso: string) => new Intl.DateTimeFormat('es-DO', { hour: 'numeric', minute: '2-digit', timeZone: TZ }).format(new Date(iso));
export const fmtDayTime = (iso: string) => `${fmtDay(iso)} · ${fmtTime(iso)}`;
/** Lunes de la semana local de la fecha dada. */
export function weekStart(iso: string): string {
  const d = new Date(`${iso}T12:00:00Z`);
  return addDays(iso, -((d.getUTCDay() + 6) % 7));
}
