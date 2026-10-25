import type { PoolClient } from '../db/pool.js';
import { ApiError, badRequest, conflict } from './errors.js';
import { canonicalJson, sha256Hex } from './crypto.js';

export interface StoredResponse { status: number; body: unknown }

const KEY_RE = /^[A-Za-z0-9_.:-]{8,200}$/;
export function requireIdempotencyKey(header: unknown): string {
  if (typeof header !== 'string' || !KEY_RE.test(header)) {
    throw badRequest('idempotency_key_required', 'Cabecera Idempotency-Key obligatoria (8–200 caracteres [A-Za-z0-9_.:-])');
  }
  return header;
}

/**
 * Ejecuta una escritura de forma idempotente dentro de la transacción recibida.
 * - Mismo principal + ruta + clave con el mismo cuerpo → devuelve la respuesta persistida.
 * - Misma clave con distinto cuerpo → 409.
 * - Los errores de dominio (ApiError 4xx) también se persisten tras revertir sus cambios
 *   con un savepoint, para que el reintento obtenga la misma respuesta.
 */
export async function idempotent(
  c: PoolClient,
  opts: { principalId: string; route: string; key: string; request: unknown; ttlHours?: number },
  fn: () => Promise<StoredResponse>,
): Promise<StoredResponse & { replayed: boolean }> {
  const requestHash = sha256Hex(canonicalJson(opts.request));
  // Serializa peticiones concurrentes con la misma clave
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`${opts.principalId}|${opts.route}|${opts.key}`]);
  const prev = await c.query(
    `SELECT request_hash, response_status, response_body FROM idempotency_records
     WHERE principal_id = $1 AND route = $2 AND key = $3`, [opts.principalId, opts.route, opts.key]);
  if (prev.rows[0]) {
    if (prev.rows[0].request_hash !== requestHash) {
      throw conflict('idempotency_key_reused', 'La clave de idempotencia ya se usó con otra petición');
    }
    return { status: prev.rows[0].response_status, body: prev.rows[0].response_body, replayed: true };
  }

  await c.query('SAVEPOINT idem_op');
  let res: StoredResponse;
  try {
    res = await fn();
    await c.query('RELEASE SAVEPOINT idem_op');
  } catch (err) {
    if (!(err instanceof ApiError) || err.status >= 500) throw err;
    await c.query('ROLLBACK TO SAVEPOINT idem_op');
    res = { status: err.status, body: { error: { code: err.code, message: err.message, details: err.details } } };
  }
  await c.query(
    `INSERT INTO idempotency_records (principal_id, route, key, request_hash, status, response_status, response_body, expires_at)
     VALUES ($1, $2, $3, $4, 'completed', $5, $6, now() + make_interval(hours => $7))`,
    [opts.principalId, opts.route, opts.key, requestHash, res.status, JSON.stringify(res.body), opts.ttlHours ?? 24 * 30]);
  return { ...res, replayed: false };
}
