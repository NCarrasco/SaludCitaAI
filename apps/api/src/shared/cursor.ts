import { badRequest } from './errors.js';

// Cursor opaco de paginación por (instante, id)
export function encodeCursor(at: Date, id: string): string {
  return Buffer.from(JSON.stringify([at.toISOString(), id])).toString('base64url');
}

export function decodeCursor(cursor: string): [string, string] {
  try {
    const v = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (Array.isArray(v) && v.length === 2 && !Number.isNaN(Date.parse(v[0])) && /^[0-9a-f-]{36}$/.test(v[1])) return [v[0], v[1]];
  } catch { /* cursor inválido */ }
  throw badRequest('invalid_cursor', 'Cursor de paginación no válido');
}
