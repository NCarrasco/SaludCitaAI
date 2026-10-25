import { describe, expect, it } from 'vitest';
import { detectTimeOfDay, resolveDate } from '../../src/modules/conversation/dates.js';

const TZ = 'America/Santo_Domingo';
// Martes 27 de octubre de 2026, 10:00 en Santo Domingo (UTC-4)
const TUESDAY = new Date('2026-10-27T14:00:00Z');
// Lunes 26 de octubre de 2026, 23:30 local = martes 27 03:30 UTC (comprueba que se usa la fecha local)
const MONDAY_NIGHT = new Date('2026-10-27T03:30:00Z');

describe('resolución de fechas en español', () => {
  it('«el martes» dicho un martes es ambiguo y ofrece hoy o el siguiente', () => {
    const r = resolveDate('quiero cita el martes', TUESDAY, TZ);
    expect(r.kind).toBe('ambiguous');
    if (r.kind === 'ambiguous') expect(r.choices.map((c) => c.from)).toEqual(['2026-10-27', '2026-11-03']);
  });

  it('«el jueves» dicho un martes es el jueves 29', () => {
    const r = resolveDate('el jueves', TUESDAY, TZ);
    expect(r).toMatchObject({ kind: 'range', range: { from: '2026-10-29', to: '2026-10-30', label: 'el jueves 29 de octubre' } });
  });

  it('usa la fecha local y no la UTC: «mañana» el lunes a las 23:30 es el martes 27', () => {
    expect(resolveDate('mañana', MONDAY_NIGHT, TZ)).toMatchObject({ kind: 'range', range: { from: '2026-10-27' } });
  });

  it('«por la mañana» es franja horaria, no el día siguiente', () => {
    expect(resolveDate('cardiología por la mañana', TUESDAY, TZ).kind).toBe('none');
    expect(detectTimeOfDay('cardiología por la mañana')).toBe('morning');
    expect(resolveDate('mañana por la tarde', TUESDAY, TZ)).toMatchObject({ range: { from: '2026-10-28' } });
    expect(detectTimeOfDay('mañana por la tarde')).toBe('afternoon');
  });

  it('fechas absolutas y relativas', () => {
    expect(resolveDate('el 5 de noviembre', TUESDAY, TZ)).toMatchObject({ range: { from: '2026-11-05' } });
    expect(resolveDate('30/10', TUESDAY, TZ)).toMatchObject({ range: { from: '2026-10-30' } });
    expect(resolveDate('pasado mañana', TUESDAY, TZ)).toMatchObject({ range: { from: '2026-10-29' } });
    expect(resolveDate('la próxima semana', TUESDAY, TZ)).toMatchObject({ range: { from: '2026-11-02', to: '2026-11-09' } });
    expect(resolveDate('el 3', TUESDAY, TZ)).toMatchObject({ range: { from: '2026-11-03' } }); // ya pasó este mes
  });

  it('una fecha pasada lejana se informa como pasada', () => {
    expect(resolveDate('el 2 de marzo', TUESDAY, TZ)).toMatchObject({ kind: 'past' });
  });

  it('«el próximo miércoles» dicho un martes es ambiguo (mañana o en ocho días)', () => {
    expect(resolveDate('el próximo miércoles', TUESDAY, TZ).kind).toBe('ambiguous');
  });

  it('día de semana que no coincide con el número es ambiguo', () => {
    expect(resolveDate('el viernes 29', TUESDAY, TZ).kind).toBe('ambiguous');
  });
});
