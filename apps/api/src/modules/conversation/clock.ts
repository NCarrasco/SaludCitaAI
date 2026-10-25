// Hora local del hospital y saludo que corresponde (buenos días / buenas tardes / buenas noches).

export interface LocalClock { time: string; greeting: string; greetingEn: string }

/** Formas de escribir la hora actual (y los dos minutos anteriores) que el asistente puede mencionar: 21:05 y 9:05 */
export function currentTimeVariants(tz: string, now: Date = new Date()): string[] {
  const out: string[] = [];
  for (let k = 0; k <= 2; k++) {
    const t = localClock(tz, new Date(now.getTime() - k * 60_000)).time; const [h, m] = t.split(':').map(Number) as [number, number];
    const h12 = h % 12 === 0 ? 12 : h % 12;
    out.push(t, `${h}:${String(m).padStart(2, '0')}`, `${h12}:${String(m).padStart(2, '0')}`);
  }
  return [...new Set(out)].sort((a, b) => b.length - a.length);
}

/** 05:00–11:59 buenos días · 12:00–18:59 buenas tardes · 19:00–04:59 buenas noches (hora local del centro). */
export function localClock(tz: string, now: Date = new Date()): LocalClock {
  const parts = new Intl.DateTimeFormat('es-DO', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  const h = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
  const m = parts.find((p) => p.type === 'minute')?.value ?? '00';
  const [greeting, greetingEn] = h >= 5 && h < 12 ? ['Buenos días', 'Good morning']
    : h >= 12 && h < 19 ? ['Buenas tardes', 'Good afternoon'] : ['Buenas noches', 'Good evening'];
  return { time: `${String(h).padStart(2, '0')}:${m}`, greeting, greetingEn };
}
