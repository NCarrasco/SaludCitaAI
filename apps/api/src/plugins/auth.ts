import type { FastifyReply, FastifyRequest } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import fp from 'fastify-plugin';
import type { Pool } from '../db/pool.js';
import { forbidden, unauthorized } from '../shared/errors.js';
import { tokenHash } from '../shared/crypto.js';

export type AdminRole = 'viewer' | 'operator' | 'admin';

export type Principal =
  | { kind: 'patient'; id: string; patientId: string; accountId: string | null; sessionId: string; sessionKind: 'password' | 'guest' | 'recovery' }
  | { kind: 'service'; id: string; credentialId: string; name: string; scopes: string[] }
  | { kind: 'admin'; id: string; adminUserId: string; role: AdminRole; sessionId: string; csrfHash: Buffer };

export const ADMIN_COOKIE = 'sc_admin';
export const CSRF_COOKIE = 'sc_csrf';
const ROLE_RANK: Record<AdminRole, number> = { viewer: 1, operator: 2, admin: 3 };
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

declare module 'fastify' {
  interface FastifyRequest {
    principal?: Principal;
  }
}

function bearer(req: FastifyRequest): string | undefined {
  const h = req.headers.authorization;
  if (!h || !h.startsWith('Bearer ')) return undefined;
  const t = h.slice(7).trim();
  return t.length > 0 && t.length < 200 ? t : undefined;
}

/** Resuelve el principal a partir del token Bearer. No decide permisos: eso lo hacen las guardas. */
export const authPlugin = fp<{ pool: Pool }>(async (app, { pool }) => {
  app.decorateRequest('principal', undefined);
  app.addHook('onRequest', async (req) => {
    // Sesión administrativa: solo por cookie HttpOnly (nunca un secreto en JavaScript del panel)
    const adminToken = req.cookies?.[ADMIN_COOKIE];
    if (adminToken && adminToken.startsWith('adm_') && adminToken.length < 200) {
      const r = await pool.query(
        `SELECT s.id AS session_id, s.csrf_hash, u.id AS user_id, u.role
         FROM admin_sessions s JOIN admin_users u ON u.id = s.admin_user_id
         WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now() AND u.active`, [tokenHash(adminToken)]);
      const row = r.rows[0];
      if (row) {
        req.principal = { kind: 'admin', id: `admin:${row.user_id}`, adminUserId: row.user_id, role: row.role,
                          sessionId: row.session_id, csrfHash: row.csrf_hash };
        return;
      }
    }
    const token = bearer(req);
    if (!token) return;
    const hash = tokenHash(token);
    if (token.startsWith('pat_')) {
      // Sesión de paciente: con cuenta de demostración o de invitado (sin cuenta). La cuenta, si existe, debe estar activa.
      const r = await pool.query(
        `SELECT s.id AS session_id, s.kind, s.account_id, s.patient_id
         FROM patient_sessions s
         JOIN patients p ON p.id = s.patient_id
         LEFT JOIN patient_accounts a ON a.id = s.account_id
         WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()
           AND p.active AND (s.account_id IS NULL OR a.active)`, [hash]);
      const row = r.rows[0];
      if (row) {
        req.principal = { kind: 'patient', id: `patient:${row.patient_id}`, patientId: row.patient_id,
                          accountId: row.account_id, sessionId: row.session_id, sessionKind: row.kind };
      }
    } else if (token.startsWith('svc_')) {
      const r = await pool.query(
        `SELECT id, name, scopes FROM service_credentials
         WHERE secret_hash = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())`, [hash]);
      const row = r.rows[0];
      if (row) req.principal = { kind: 'service', id: `service:${row.id}`, credentialId: row.id, name: row.name, scopes: row.scopes };
    }
  });
});

export async function requireAuthenticated(req: FastifyRequest, _reply: FastifyReply) {
  if (!req.principal) throw unauthorized();
}

export async function requirePatient(req: FastifyRequest, _reply: FastifyReply) {
  if (!req.principal) throw unauthorized();
  if (req.principal.kind !== 'patient') throw forbidden('Operación disponible solo para pacientes autenticados');
}

export function patientOf(req: FastifyRequest): Extract<Principal, { kind: 'patient' }> {
  const p = req.principal;
  if (!p || p.kind !== 'patient') throw unauthorized();
  return p;
}

/** Guarda para credenciales de servicio (n8n). Nunca sustituye las comprobaciones de propiedad del paciente. */
export function requireServiceScope(scope: 'bot' | 'scheduler' | 'calendar-sync' | 'gateway') {
  return async (req: FastifyRequest, _reply: FastifyReply) => {
    if (!req.principal) throw unauthorized();
    if (req.principal.kind !== 'service' || !req.principal.scopes.includes(scope)) throw forbidden(`Requiere credencial de servicio con scope ${scope}`);
  };
}

/**
 * Guarda de rol administrativo. En métodos que modifican estado exige la cabecera X-CSRF-Token
 * igual al token emitido en el login (patrón de doble envío ligado a la sesión).
 */
export function requireAdmin(minRole: AdminRole) {
  return async (req: FastifyRequest, _reply: FastifyReply) => {
    const p = req.principal;
    if (!p) throw unauthorized();
    if (p.kind !== 'admin') throw forbidden('Requiere una sesión administrativa');
    if (ROLE_RANK[p.role] < ROLE_RANK[minRole]) throw forbidden(`Requiere rol ${minRole} o superior`);
    if (MUTATING.has(req.method)) {
      const header = req.headers['x-csrf-token'];
      const presented = typeof header === 'string' ? tokenHash(header) : null;
      if (!presented || presented.length !== p.csrfHash.length || !timingSafeEqual(presented, p.csrfHash)) {
        throw forbidden('Falta o no coincide la cabecera X-CSRF-Token');
      }
    }
  };
}

export function adminOf(req: FastifyRequest): Extract<Principal, { kind: 'admin' }> {
  const p = req.principal;
  if (!p || p.kind !== 'admin') throw unauthorized();
  return p;
}
