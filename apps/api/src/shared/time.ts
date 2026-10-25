// Formato de instantes en la zona de negocio. Los instantes se almacenan como timestamptz.

const partsCache = new Map<string, Intl.DateTimeFormat>();
function partsFormatter(tz: string): Intl.DateTimeFormat {
  let f = partsCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    partsCache.set(tz, f);
  }
  return f;
}

function localParts(d: Date, tz: string) {
  const p = Object.fromEntries(partsFormatter(tz).formatToParts(d).map((x) => [x.type, x.value]));
  return { y: p.year!, mo: p.month!, d: p.day!, h: p.hour!, mi: p.minute!, s: p.second! };
}

/** RFC 3339 con el desplazamiento de la zona, p. ej. 2026-10-27T09:00:00-04:00 */
export function toZonedIso(d: Date, tz: string): string {
  const p = localParts(d, tz);
  const asUtc = Date.UTC(+p.y, +p.mo - 1, +p.d, +p.h, +p.mi, +p.s);
  const offsetMin = Math.round((asUtc - Math.floor(d.getTime() / 1000) * 1000) / 60000);
  const sign = offsetMin >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMin);
  const off = `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
  return `${p.y}-${p.mo}-${p.d}T${p.h}:${p.mi}:${p.s}${off}`;
}

const labelCache = new Map<string, Intl.DateTimeFormat>();
/** Fecha completa legible en español: «martes, 27 de octubre de 2026, 9:00 a. m.» */
export function spanishLabel(d: Date, tz: string): string {
  let f = labelCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('es-DO', {
      timeZone: tz, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
      hour: 'numeric', minute: '2-digit',
    });
    labelCache.set(tz, f);
  }
  return f.format(d);
}

/** Fecha local (YYYY-MM-DD) de un instante en la zona dada. */
export function localDate(d: Date, tz: string): string {
  const p = localParts(d, tz);
  return `${p.y}-${p.mo}-${p.d}`;
}
