// Acceso sin registro previo.
// - Sesión invitada: la crea el servidor (pasarela de Gradio con credencial «gateway»); el token es opaco, se guarda como
//   hash, caduca y se puede revocar. Nombre, fecha de nacimiento o referencias NUNCA autentican.
// - Código de recuperación: 125 bits generados por el servidor, mostrado una sola vez, guardado como hash,
//   con caducidad, revocación y ROTACIÓN en cada uso (el canje emite uno nuevo).

import { randomBytes } from 'node:crypto';
import type { Pool, PoolClient } from '../../db/pool.js';
import { withTransaction } from '../../db/tx.js';
import { newToken, tokenHash } from '../../shared/crypto.js';
import { ApiError } from '../../shared/errors.js';
import { getPatientView } from '../patients/service.js';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 32 símbolos (5 bits), sin 0/O/1/I
const GROUPS = 5;
const GROUP_LEN = 5; // 25 símbolos × 5 bits = 125 bits

export function generateRecoveryCode(): string {
  const bytes = randomBytes(GROUPS * GROUP_LEN);
  const chars = [...bytes].map((b) => ALPHABET[b % 32]); // 256 es múltiplo de 32: sin sesgo
  const groups = Array.from({ length: GROUPS }, (_, i) => chars.slice(i * GROUP_LEN, (i + 1) * GROUP_LEN).join(''));
  return `SCR-${groups.join('-')}`;
}

/** Normaliza lo que escribe el usuario (minúsculas, espacios, guiones) antes de calcular el hash. */
export function normalizeRecoveryCode(input: string): string | null {
  const raw = input.toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^SCR/, '');
  if (raw.length !== GROUPS * GROUP_LEN || [...raw].some((c) => !ALPHABET.includes(c))) return null;
  return `SCR-${raw.match(/.{5}/g)!.join('-')}`;
}

export interface GuestConfig { guestSessionTtlDays: number; recoveryCodeTtlDays: number }

async function newSession(c: PoolClient, patientId: string, kind: 'guest' | 'recovery', ttlDays: number) {
  const token = newToken('pat');
  const s = (await c.query(
    `INSERT INTO patient_sessions (patient_id, token_hash, expires_at, kind) VALUES ($1, $2, now() + make_interval(days => $3), $4)
     RETURNING expires_at`, [patientId, tokenHash(token), ttlDays, kind])).rows[0];
  return { token, expires_at: s.expires_at as Date };
}

export async function createGuest(pool: Pool, cfg: GuestConfig) {
  return withTransaction(pool, async (c) => {
    const p = (await c.query(`INSERT INTO patients (kind, last_seen_at) VALUES ('guest', now()) RETURNING id`)).rows[0];
    const s = await newSession(c, p.id, 'guest', cfg.guestSessionTtlDays);
    return { ...s, patient: (await getPatientView(c, p.id))! };
  });
}

async function issueCode(c: PoolClient, patientId: string, ttlDays: number, reasonForPrevious: 'rotated' | 'used') {
  await c.query(`UPDATE patient_recovery_codes SET revoked_at = now(), revoke_reason = coalesce(revoke_reason, $2)
                 WHERE patient_id = $1 AND revoked_at IS NULL`, [patientId, reasonForPrevious]);
  const code = generateRecoveryCode();
  const r = (await c.query(
    `INSERT INTO patient_recovery_codes (patient_id, code_hash, expires_at) VALUES ($1, $2, now() + make_interval(days => $3))
     RETURNING created_at, expires_at`, [patientId, tokenHash(code), ttlDays])).rows[0];
  return { recovery_code: code, created_at: r.created_at as Date, expires_at: r.expires_at as Date };
}

/** Genera (o rota) el código de recuperación del paciente. Se muestra una sola vez. */
export async function rotateRecoveryCode(pool: Pool, patientId: string, cfg: GuestConfig) {
  return withTransaction(pool, async (c) => {
    await c.query('SELECT id FROM patients WHERE id = $1 FOR UPDATE', [patientId]);
    return issueCode(c, patientId, cfg.recoveryCodeTtlDays, 'rotated');
  });
}

export async function recoveryCodeStatus(pool: Pool, patientId: string) {
  const r = (await pool.query(
    `SELECT created_at, expires_at FROM patient_recovery_codes WHERE patient_id = $1 AND revoked_at IS NULL AND expires_at > now()`,
    [patientId])).rows[0];
  return r ? { active: true, created_at: r.created_at as Date, expires_at: r.expires_at as Date } : { active: false, created_at: null, expires_at: null };
}

export async function revokeRecoveryCode(pool: Pool, patientId: string) {
  const r = await pool.query(`UPDATE patient_recovery_codes SET revoked_at = now(), revoke_reason = 'patient_revoked'
                              WHERE patient_id = $1 AND revoked_at IS NULL`, [patientId]);
  return { revoked: (r.rowCount ?? 0) > 0 };
}

/** Canjea un código: nueva sesión de dispositivo para su paciente y nuevo código (el anterior queda usado). */
/**
 * Canjea un código. Si el paciente tiene fecha de nacimiento registrada, también debe coincidir (segunda comprobación).
 * El código es el factor que autentica: nombre o fecha de nacimiento solos nunca dan acceso.
 */
export async function redeemRecoveryCode(pool: Pool, input: string, cfg: GuestConfig, birthDate?: string) {
  const code = normalizeRecoveryCode(input);
  // Mismo error para formato inválido, inexistente, caducado o revocado (no revela qué ocurrió)
  const invalid = new ApiError(401, 'invalid_recovery_code', 'El código de recuperación no es válido o ya no está vigente');
  if (!code) throw invalid;
  const MAX_BIRTH_FAILURES = 5;
  const r = await withTransaction(pool, async (c) => {
    const row = (await c.query(
      `SELECT r.id, r.patient_id, r.failed_attempts, p.birth_date::text AS birth_date FROM patient_recovery_codes r JOIN patients p ON p.id = r.patient_id
       WHERE r.code_hash = $1 AND r.revoked_at IS NULL AND r.expires_at > now() AND p.active FOR UPDATE OF r`, [tokenHash(code)])).rows[0];
    if (!row) return null;
    // Fecha de nacimiento incorrecta: el código no se consume, pero se cuenta; al 5.º fallo se invalida.
    // El error hacia fuera es siempre el mismo (no revela si el código existía).
    if (row.birth_date && row.birth_date !== birthDate) {
      const n = row.failed_attempts + 1;
      await c.query(`UPDATE patient_recovery_codes SET failed_attempts = $2::int,
                       revoked_at = CASE WHEN $2::int >= $3::int THEN now() END,
                       revoke_reason = CASE WHEN $2::int >= $3::int THEN 'too_many_attempts' END
                     WHERE id = $1`, [row.id, n, MAX_BIRTH_FAILURES]);
      return null;
    }
    await c.query(`UPDATE patient_recovery_codes SET revoked_at = now(), used_at = now(), revoke_reason = 'used' WHERE id = $1`, [row.id]);
    const s = await newSession(c, row.patient_id, 'recovery', cfg.guestSessionTtlDays);
    const next = await issueCode(c, row.patient_id, cfg.recoveryCodeTtlDays, 'used');
    return { ...s, patient: (await getPatientView(c, row.patient_id))!, new_recovery_code: next.recovery_code, new_recovery_code_expires_at: next.expires_at };
  });
  if (!r) throw invalid;
  return r;
}

/** Cierra las demás sesiones del paciente (p. ej., tras perder un dispositivo). */
export async function revokeOtherSessions(pool: Pool, patientId: string, currentSessionId: string) {
  const r = await pool.query(`UPDATE patient_sessions SET revoked_at = now() WHERE patient_id = $1 AND id <> $2 AND revoked_at IS NULL`,
    [patientId, currentSessionId]);
  return { revoked_sessions: r.rowCount ?? 0 };
}
