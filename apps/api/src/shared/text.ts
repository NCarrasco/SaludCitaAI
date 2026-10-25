/** Cierra una frase con punto sin duplicarlo («9:00 a. m.» ya termina en punto). */
export const period = (s: string): string => (s.endsWith('.') ? s : `${s}.`);
