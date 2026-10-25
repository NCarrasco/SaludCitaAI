import { describe, expect, it } from 'vitest';
import { OLLAMA_FORMAT, buildOllamaRequest, parseInterpretation } from '../../src/modules/conversation/llm.js';

const base = { intent: 'book', specialty: 'Cardiología', doctor: null, date_phrase: 'el martes', time_of_day: 'morning',
               option_number: null, booking_reference: null };

describe('validación de la salida del modelo', () => {
  it('acepta una interpretación válida', () => {
    expect(parseInterpretation(JSON.stringify(base))).toEqual({ ok: true, value: base });
  });
  it('rechaza JSON inválido, intenciones desconocidas y campos extra (p. ej., un slot_id inventado)', () => {
    expect(parseInterpretation('no es json').ok).toBe(false);
    expect(parseInterpretation(JSON.stringify({ ...base, intent: 'confirm_booking' })).ok).toBe(false);
    expect(parseInterpretation(JSON.stringify({ ...base, slot_id: '00000000-0000-4000-8000-000000000000' })).ok).toBe(false);
    expect(parseInterpretation(JSON.stringify({ ...base, patient_id: 'x' })).ok).toBe(false);
  });
  it('normaliza option_number 0 a null (salida habitual de modelos pequeños)', () => {
    const r = parseInterpretation(JSON.stringify({ ...base, option_number: 0 }));
    expect(r.ok && r.value.option_number).toBe(null);
    expect(parseInterpretation(JSON.stringify({ ...base, option_number: -1 })).ok).toBe(false);
  });
  it('normaliza cadenas vacías a null', () => {
    const r = parseInterpretation(JSON.stringify({ ...base, doctor: '' }));
    expect(r.ok && r.value.doctor).toBe(null);
  });
  it('la petición a Ollama restringe la salida con el esquema y no incluye datos de agenda ni identidad', () => {
    const req = buildOllamaRequest('m', 'hola', { step: 'idle', optionsOffered: 0, specialties: ['Cardiología'], history: [] });
    expect(req.format).toBe(OLLAMA_FORMAT);
    expect(req.options.temperature).toBe(0);
    expect(JSON.stringify(req)).not.toMatch(/patient_id|slot_id|[0-9a-f]{8}-[0-9a-f]{4}-/);
  });
});
