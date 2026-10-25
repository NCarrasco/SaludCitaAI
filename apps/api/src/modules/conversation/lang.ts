// Idioma de la conversación. Determinista y explicable; el modelo solo aporta una pista.
// Política:
//  1) Una petición explícita («respóndeme en inglés», «answer in Spanish») fija el idioma hasta otra petición.
//  2) Un mensaje con señales claras de otro idioma cambia el idioma de la conversación.
//  3) Mensajes breves o ambiguos («ok», «3», «sí») conservan el idioma actual.

const STOP: Record<string, string[]> = {
  es: ['el', 'la', 'los', 'las', 'de', 'que', 'y', 'en', 'un', 'una', 'por', 'para', 'con', 'mi', 'quiero', 'cita', 'hola', 'gracias', 'como',
       'qué', 'cómo', 'estoy', 'tengo', 'necesito', 'puedo', 'buenas', 'buenos', 'días', 'señor', 'usted', 'es', 'no', 'sí', 'pero', 'muy', 'esto',
       'cuánto', 'cuanto', 'cuál', 'cual', 'cuáles', 'cuándo', 'cuando', 'dónde', 'donde', 'quién', 'hay', 'cuesta', 'horario', 'médico', 'medico',
       'médicos', 'doctora', 'mis', 'tienen', 'está', 'están', 'del', 'al', 'me', 'hora', 'citas', 'atiende', 'disponible', 'tiene', 'eres'],
  en: ['the', 'and', 'is', 'are', 'to', 'of', 'i', 'you', 'my', 'want', 'need', 'appointment', 'hello', 'hi', 'thanks', 'thank', 'what', 'how',
       'can', 'please', 'with', 'for', 'do', 'does', 'it', 'this', 'that', 'doctor', 'would', 'like', 'have', 'am', 'feel', 'today', 'could',
       'which', 'when', 'where', 'who', 'much', 'many', 'your', 'there', 'doctors', 'available', 'cost', 'hours', 'time', 'appointments'],
  pt: ['o', 'a', 'os', 'as', 'de', 'que', 'e', 'em', 'um', 'uma', 'para', 'com', 'meu', 'minha', 'quero', 'consulta', 'olá', 'obrigado',
       'obrigada', 'você', 'não', 'sim', 'estou', 'tenho', 'preciso', 'posso', 'bom', 'dia', 'tudo', 'bem', 'como', 'muito', 'isso', 'vocês'],
  fr: ['le', 'la', 'les', 'de', 'des', 'que', 'et', 'en', 'un', 'une', 'pour', 'avec', 'mon', 'ma', 'je', 'veux', 'rendez-vous', 'bonjour',
       'merci', 'vous', 'est', 'pas', 'oui', 'suis', 'ai', 'besoin', 'peux', 'comment', 'ça', 'très', 'cette', 'votre', 'pouvez', "j'ai"],
  it: ['il', 'lo', 'la', 'gli', 'di', 'che', 'e', 'un', 'una', 'per', 'con', 'mio', 'mia', 'voglio', 'appuntamento', 'ciao', 'grazie', 'sono',
       'non', 'sì', 'ho', 'bisogno', 'posso', 'buongiorno', 'come', 'molto', 'questo', 'vorrei'],
  de: ['der', 'die', 'das', 'und', 'ist', 'ich', 'sie', 'mein', 'meine', 'möchte', 'termin', 'hallo', 'danke', 'nicht', 'ja', 'bin', 'habe',
       'brauche', 'kann', 'guten', 'tag', 'wie', 'sehr', 'bitte', 'mit', 'für', 'einen'],
};
export const LANG_NAMES: Record<string, string> = { es: 'español', en: 'inglés', pt: 'portugués', fr: 'francés', it: 'italiano', de: 'alemán' };

const tokenize = (t: string) => t.toLowerCase().replace(/[¿?¡!.,;:()«»"“”]/g, ' ').split(/\s+/).filter(Boolean);

/** Idioma probable del texto o null si no hay señales suficientes (mensajes breves o ambiguos). */
export function detectLanguage(text: string): string | null {
  const toks = tokenize(text);
  if (toks.length === 0) return null;
  // «¿» y «¡» solo se usan en español: señal inequívoca aunque el mensaje sea corto
  if (/[¿¡]/.test(text)) return 'es';
  const scores = Object.entries(STOP).map(([lang, words]) => [lang, toks.filter((t) => words.includes(t)).length] as const)
    .sort((a, b) => b[1] - a[1]);
  const [best, second] = scores;
  // Señal mínima: 2 palabras propias y ventaja sobre el segundo (o 1 si el mensaje es de 1–2 palabras y no hay empate)
  const min = toks.length <= 2 ? 1 : 2;
  if (!best || best[1] < min || (second && best[1] - second[1] < 1)) return null;
  // Señales ortográficas que desempatan español/portugués
  if (best[0] === 'es' && /[ãõç]/.test(text)) return 'pt';
  return best[0];
}

// «en inglés», «in English», «em português» o «¿hablas/speak/parlez/falas/sprichst … ?»
const PREP = '(?:en|in|em|auf|hablas?|speak|parle[sz]?|falas?|sprichst|parli)';
const REQUEST: [RegExp, string][] = [
  [new RegExp(`\\b${PREP}\\s+(ingl[eé]s|english|anglais|inglese|englisch)`, 'i'), 'en'],
  [new RegExp(`\\b${PREP}\\s+(espa[nñ]ol|spanish|espagnol|spagnolo|spanisch|castellano)`, 'i'), 'es'],
  [new RegExp(`\\b${PREP}\\s+(portugu[eéê]s|portuguese|portugais|portoghese|portugiesisch)`, 'i'), 'pt'],
  [new RegExp(`\\b${PREP}\\s+(franc[eé]s|french|fran[cç]ais|francese|franz[oö]sisch)`, 'i'), 'fr'],
  [new RegExp(`\\b${PREP}\\s+(italiano|italian|italien|italienisch)`, 'i'), 'it'],
  [new RegExp(`\\b${PREP}\\s+(alem[aá]n|german|allemand|tedesco|deutsch)`, 'i'), 'de'],
];
const ASKS = /(hablas?|speak|parle[sz]?|falas?|sprichst|parli|resp[oó]nde|respondeme|h[aá]blame|hablemos|escr[ií]beme|cambia|answer|reply|respond|speak|talk|write|switch|fala|responda|r[ée]ponds|parle|rispondi|parla|antworte|sprich)/i;

/** Petición explícita de idioma («respóndeme en inglés», «can you answer in Spanish?», «ahora en español, por favor») o null. */
export function explicitLanguageRequest(text: string): string | null {
  // Con verbo de petición, o mensaje breve que solo pide el idioma («ahora en español otra vez, por favor»)
  if (!ASKS.test(text) && tokenize(text).length > 7) return null;
  for (const [re, code] of REQUEST) if (re.test(text)) return code;
  return null;
}

/** Idioma con el que responder y si queda fijado por petición explícita. */
export function resolveLanguage(current: { lang?: string; lang_locked?: boolean }, text: string, modelHint?: string | null):
  { lang: string; locked: boolean; changed: boolean } {
  const prev = current.lang ?? 'es';
  const asked = explicitLanguageRequest(text);
  if (asked) return { lang: asked, locked: true, changed: asked !== prev };
  if (current.lang_locked) return { lang: prev, locked: true, changed: false };
  const detected = detectLanguage(text);
  // La pista del modelo solo se acepta si coincide con la detección determinista (evita cambios por error)
  const lang = detected ?? (modelHint && modelHint === detectLanguage(text) ? modelHint : null) ?? prev;
  return { lang, locked: false, changed: lang !== prev };
}

/** ¿Tiene el texto suficientes palabras propias del idioma? (para no rechazar respuestas que citan palabras de otro idioma) */
export function hasLanguageSignal(text: string, lang: string): boolean {
  const words = STOP[lang];
  if (!words) return true;
  return tokenize(text).filter((t) => words.includes(t)).length >= 2;
}
