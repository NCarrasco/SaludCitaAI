import type { Pool, PoolClient } from './pool.js';
import { PG, pgCode } from '../shared/errors.js';

/**
 * Ejecuta fn en una transacción READ COMMITTED. Reintenta de forma limitada ante
 * interbloqueos o fallos de serialización; cualquier otro error revierte y se propaga.
 */
export async function withTransaction<T>(pool: Pool, fn: (c: PoolClient) => Promise<T>, maxAttempts = 3): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      const code = pgCode(err);
      const retryable = code === PG.deadlockDetected || code === PG.serializationFailure;
      if (!retryable || attempt >= maxAttempts) throw err;
      await new Promise((r) => setTimeout(r, 20 * attempt + Math.random() * 30));
    } finally {
      client.release();
    }
  }
}
