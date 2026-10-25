import { describe, expect, it } from 'vitest';
import { matchSpecialty } from '../../src/modules/conversation/engine.js';
import { groundedDatePhrase, groundedTimeOfDay, hasCue } from '../../src/modules/conversation/grounding.js';

const SPECIALTIES = [
  { id: '1', name: 'Cardiología' }, { id: '2', name: 'Medicina Interna' }, { id: '3', name: 'Pediatría' },
];

describe('anclaje de entidades del modelo en el texto del paciente', () => {
  it('descarta una franja horaria inventada', () => {
    expect(groundedTimeOfDay('morning', 'Necesito cita con medicina interna mañana')).toBe(null);
    expect(groundedTimeOfDay('morning', 'cita mañana por la mañana')).toBe('morning');
    expect(groundedTimeOfDay('morning', 'nesesito cita x la mañana')).toBe('morning');
    expect(groundedTimeOfDay('afternoon', 'algo en la tarde')).toBe('afternoon');
    expect(groundedTimeOfDay('afternoon', 'quiero cita el lunes')).toBe(null);
  });

  it('reconoce especialidades con sinónimos y errores tipográficos, sin inventarlas', () => {
    expect(matchSpecialty('kiero sita de cardiolojia el martes', SPECIALTIES)?.name).toBe('Cardiología');
    expect(matchSpecialty('dame una cita del corazón', SPECIALTIES)?.name).toBe('Cardiología');
    expect(matchSpecialty('llevar a mi hijo al pediatra', SPECIALTIES)?.name).toBe('Pediatría');
    expect(matchSpecialty('busco un internista', SPECIALTIES)?.name).toBe('Medicina Interna');
    expect(matchSpecialty('Quiero una cita', SPECIALTIES)).toBeUndefined();
    expect(matchSpecialty('Necesito ver un médico el martes', SPECIALTIES)).toBeUndefined();
  });

  it('hasCue tolera hasta 2 errores solo en palabras largas', () => {
    expect(hasCue('pediatria', ['pediatra'])).toBe(true);
    expect(hasCue('bebé', ['bebe'])).toBe(true);
    expect(hasCue('nene', ['nino'])).toBe(false);
  });
});

import { reconcile } from '../../src/modules/conversation/engine.js';
import { ordinalInText, yesNo } from '../../src/modules/conversation/grounding.js';

const I = { intent: 'select_option' as const, specialty: null, doctor: null, date_phrase: null, time_of_day: null,
            option_number: 1, booking_reference: null };

describe('coherencia entre modelo, texto y estado', () => {
  it('toma el ordinal del texto cuando hay opciones vigentes', () => {
    expect(ordinalInText('la segunda')).toBe(2);
    expect(ordinalInText('quiero la 3')).toBe(3);
    expect(reconcile(I, 'la segunda', { step: 'choosing_slot' }).option_number).toBe(2);
  });
  it('select_option sin opciones vigentes se reinterpreta como reserva si el texto pide una cita', () => {
    expect(reconcile(I, 'Necesito cita con medicina interna mañana', { step: 'idle' }).intent).toBe('book');
    expect(reconcile(I, 'bla bla', { step: 'idle' }).intent).toBe('unknown');
  });
  it('un sí/no corto ante una propuesta pendiente no depende del modelo y nunca confirma', () => {
    expect(yesNo('sí, confírmala')).toBe('affirm');
    expect(yesNo('no, mejor no')).toBe('deny');
    expect(reconcile({ ...I, intent: 'book' }, 'sí, confírmala', { step: 'awaiting_confirmation' }).intent).toBe('affirm');
  });
});

describe('fecha anclada al texto del paciente', () => {
  it.each([
    ['hoy', 'necesito cita para mi hijo', null],
    ['mañana', 'quiero una cita con pediatria', null],
    ['el martes', 'cita de cardiología el martes', 'el martes'],
    ['28 de octubre', 'para el 28 de octubre por favor', '28 de octubre'],
    ['28 de octubre', 'para el 29 de octubre', null],
    ['la próxima semana', 'la proxima semana si se puede', 'la próxima semana'],
    ['el miércoles', 'el miercoles', 'el miércoles'],
  ])('«%s» con «%s» → %s', (phrase, text, expected) => {
    expect(groundedDatePhrase(phrase, text)).toBe(expected);
  });
});

describe('pistas clínicas', () => {
  it.each([['me duele la cabeza', true], ['tengo fiebre desde ayer', true], ['I have a fever', true], ['¿cuál es la capital de Japón?', false],
    ['what time is it in Tokyo?', false], ['me siento muy mal', true]])('«%s» → %s', async (t, v) => {
    const { looksClinical } = await import('../../src/modules/conversation/grounding.js');
    expect(looksClinical(t)).toBe(v);
  });
});
