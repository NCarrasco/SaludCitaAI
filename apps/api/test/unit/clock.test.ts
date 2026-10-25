import { describe, expect, it } from 'vitest';
import { localClock } from '../../src/modules/conversation/clock.js';

// Santo Domingo es UTC−4 todo el año (sin horario de verano)
const at = (hhmm: string) => new Date(`2026-10-24T${hhmm}:00-04:00`);
describe('saludo según la hora local del hospital', () => {
  it.each([
    ['04:59', 'Buenas noches'], ['05:00', 'Buenos días'], ['11:59', 'Buenos días'],
    ['12:00', 'Buenas tardes'], ['18:59', 'Buenas tardes'], ['19:00', 'Buenas noches'], ['23:30', 'Buenas noches'],
  ])('%s → %s', (hhmm, greeting) => {
    const c = localClock('America/Santo_Domingo', at(hhmm));
    expect(c.greeting).toBe(greeting);
    expect(c.time).toBe(hhmm);
  });
});

import { validateConverse } from '../../src/modules/conversation/converse.js';
import { currentTimeVariants } from '../../src/modules/conversation/clock.js';

describe('el asistente puede decir la hora actual, pero no otras horas', () => {
  const now = at('21:15');
  const ok = (text: string) => validateConverse(JSON.stringify({ text }), { mode: 'chat', lang: 'es' }, [], currentTimeVariants('America/Santo_Domingo', now)).ok;
  it('acepta la hora actual en formato de 24 y de 12 horas', () => {
    expect(ok('Aquí en Santo Domingo son las 21:15.')).toBe(true);
    expect(ok('Ahora son las 9:15 p. m. en Santo Domingo.')).toBe(true);
  });
  it('sigue bloqueando cualquier otra hora (no puede inventar horarios de citas)', () => {
    expect(ok('Tu cita es a las 10:30 a. m.')).toBe(false);
  });
});
