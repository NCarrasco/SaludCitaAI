import { describe, expect, it } from 'vitest';
import { detectLanguage, explicitLanguageRequest, resolveLanguage } from '../../src/modules/conversation/lang.js';
import { localizeReply } from '../../src/modules/conversation/localize.js';

describe('idioma', () => {
  it.each([
    ['Hola, quiero una cita con el cardiólogo', 'es'], ['Hi, I need an appointment please', 'en'], ['Olá, eu preciso de uma consulta', 'pt'],
    ['Bonjour, je voudrais un rendez-vous avec le médecin', 'fr'], ['ok', null], ['3', null],
  ])('detecta «%s» → %s', (t, l) => expect(detectLanguage(t)).toBe(l));
  it.each([
    ['respóndeme en inglés', 'en'], ['can you answer in Spanish?', 'es'], ['responda em português por favor', 'pt'], ['Bonjour, vous parlez français?', 'fr'], ['do you speak English?', 'en'], ['hablo inglés', null],
  ])('petición explícita «%s» → %s', (t, l) => expect(explicitLanguageRequest(t)).toBe(l));
  it('mensajes breves conservan el idioma; la petición explícita fija', () => {
    expect(resolveLanguage({ lang: 'en' }, 'ok').lang).toBe('en');
    expect(resolveLanguage({ lang: 'en', lang_locked: true }, 'Quiero ver mis citas por favor').lang).toBe('en');
    expect(resolveLanguage({ lang: 'es' }, 'respóndeme en inglés')).toEqual({ lang: 'en', locked: true, changed: true });
  });
});

describe('localización verificada', () => {
  it('convierte fechas, especialidades y frases sin tocar referencias ni nombres', () => {
    const r = localizeReply({ mode: 'system', text: 'Listo: tu cita SC-ABC234 con Dra. María Sosa (ficticia) quedó confirmada para el lunes, 26 de octubre de 2026, 8:30 a. m.' }, 'en');
    expect(r.text).toBe('Done: your appointment SC-ABC234 with Dra. María Sosa (fictitious) is confirmed for Monday, October 26, 2026, 8:30 AM.');
    expect(r.lang_fallback).toBeUndefined();
  });
  it('un texto sin regla queda en español y se marca', () => {
    expect(localizeReply({ mode: 'ai', text: 'Texto nuevo sin plantilla para la cita.' }, 'en').lang_fallback).toBe(true);
  });
});

describe('correcciones tras reserved-v4 (no evaluadas aún con una batería independiente)', () => {
  it('«ahora en español otra vez, por favor» es una petición explícita', () => expect(explicitLanguageRequest('ahora en español otra vez, por favor')).toBe('es'));
  it('una frase larga que solo menciona un idioma no lo es', () => expect(explicitLanguageRequest('mi hija estudia en inglés en el colegio y le va muy bien en todo')).toBeNull());
});
