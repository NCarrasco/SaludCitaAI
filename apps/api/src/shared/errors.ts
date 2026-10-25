// Error de dominio con código estable y estado HTTP. Formato de respuesta:
// { error: { code, message, details }, request_id }
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export const badRequest = (code: string, message: string, details?: Record<string, unknown>) =>
  new ApiError(400, code, message, details);
export const unauthorized = (message = 'Autenticación requerida') => new ApiError(401, 'unauthorized', message);
export const forbidden = (message = 'Permisos insuficientes') => new ApiError(403, 'forbidden', message);
export const notFound = (what = 'Recurso') => new ApiError(404, 'not_found', `${what} no encontrado`);
export const conflict = (code: string, message: string, details?: Record<string, unknown>) =>
  new ApiError(409, code, message, details);
export const gone = (code: string, message: string) => new ApiError(410, code, message);

// Códigos de PostgreSQL usados para traducir violaciones de integridad
export const PG = {
  uniqueViolation: '23505',
  exclusionViolation: '23P01',
  foreignKeyViolation: '23503',
  checkViolation: '23514',
  serializationFailure: '40001',
  deadlockDetected: '40P01',
} as const;

export function pgCode(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null && 'code' in err ? String((err as { code: unknown }).code) : undefined;
}

export function pgConstraint(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null && 'constraint' in err
    ? String((err as { constraint: unknown }).constraint)
    : undefined;
}
