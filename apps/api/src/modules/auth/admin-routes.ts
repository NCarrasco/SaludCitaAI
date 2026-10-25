import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from 'typebox';
import type { Pool } from '../../db/pool.js';
import { ADMIN_COOKIE, CSRF_COOKIE, adminOf, requireAdmin } from '../../plugins/auth.js';
import { dummyPasswordHash, newToken, tokenHash, verifyPassword } from '../../shared/crypto.js';
import { ApiError } from '../../shared/errors.js';
import { DateTime, Uuid, errorResponses } from '../../shared/schemas.js';
import { toZonedIso } from '../../shared/time.js';

export const AdminCookieSecurity = [{ adminCookie: [] }];

const AdminUser = Type.Object({
  id: Uuid, email: Type.String(), display_name: Type.Union([Type.String(), Type.Null()]),
  role: Type.Union([Type.Literal('viewer'), Type.Literal('operator'), Type.Literal('admin')]),
}, { $id: 'AdminUser', title: 'AdminUser' });

export const adminAuthRoutes: FastifyPluginAsyncTypebox<{ pool: Pool; tz: string; ttlHours: number; secure: boolean }> =
  async (app, { pool, tz, ttlHours, secure }) => {
    app.addSchema(AdminUser);
    const cookieBase = { path: '/', sameSite: 'lax' as const, secure };

    app.post('/auth/login', {
      config: { rateLimit: { max: 10, timeWindow: '5 minutes', hook: 'preHandler',
        keyGenerator: (req: any) => `${req.ip}|${String(req.body?.email ?? '').toLowerCase()}` } },
      schema: {
        operationId: 'adminLogin', tags: ['Administración: sesión'], security: [],
        summary: 'Inicia una sesión administrativa (panel). Devuelve cookies, no un token en JavaScript.',
        description: 'Establece la cookie HttpOnly `sc_admin` (sesión) y la cookie legible `sc_csrf`. Toda petición que ' +
          'modifique estado debe enviar la cabecera `X-CSRF-Token` con el valor de `csrf_token` (o de la cookie `sc_csrf`). ' +
          'Límite: 10 intentos por IP y correo cada 5 minutos.',
        body: Type.Object({ email: Type.String({ minLength: 3, maxLength: 200 }), password: Type.String({ minLength: 1, maxLength: 200 }) },
          { additionalProperties: false }),
        response: {
          200: Type.Object({ user: Type.Ref('AdminUser'), csrf_token: Type.String(), expires_at: DateTime }),
          ...errorResponses(400, 401, 429),
        },
      },
    }, async (req, reply) => {
      const email = req.body.email.trim().toLowerCase();
      const r = await pool.query(`SELECT id, email, display_name, role, password_hash FROM admin_users WHERE email = $1 AND active`, [email]);
      const u = r.rows[0];
      const ok = await verifyPassword(req.body.password, u?.password_hash ?? (await dummyPasswordHash()));
      if (!u || !ok) throw new ApiError(401, 'invalid_credentials', 'Correo o contraseña incorrectos');
      const token = newToken('adm');
      const csrf = newToken('csrf');
      const s = await pool.query(
        `INSERT INTO admin_sessions (admin_user_id, token_hash, csrf_hash, expires_at)
         VALUES ($1, $2, $3, now() + make_interval(hours => $4)) RETURNING expires_at`,
        [u.id, tokenHash(token), tokenHash(csrf), ttlHours]);
      const maxAge = ttlHours * 3600;
      reply.setCookie(ADMIN_COOKIE, token, { ...cookieBase, httpOnly: true, maxAge });
      reply.setCookie(CSRF_COOKIE, csrf, { ...cookieBase, httpOnly: false, maxAge });
      return { user: { id: u.id, email: u.email, display_name: u.display_name, role: u.role }, csrf_token: csrf,
               expires_at: toZonedIso(s.rows[0].expires_at, tz) };
    });

    app.post('/auth/logout', {
      preHandler: requireAdmin('viewer'),
      schema: { operationId: 'adminLogout', tags: ['Administración: sesión'], security: AdminCookieSecurity,
                summary: 'Revoca la sesión administrativa y borra las cookies (requiere X-CSRF-Token)',
                response: { 204: Type.Null(), ...errorResponses(401, 403) } },
    }, async (req, reply) => {
      await pool.query('UPDATE admin_sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL', [adminOf(req).sessionId]);
      reply.clearCookie(ADMIN_COOKIE, cookieBase).clearCookie(CSRF_COOKIE, cookieBase);
      return reply.code(204).send(null);
    });

    app.get('/auth/me', {
      preHandler: requireAdmin('viewer'),
      schema: { operationId: 'adminMe', tags: ['Administración: sesión'], security: AdminCookieSecurity,
                summary: 'Usuario administrativo de la sesión y su rol',
                response: { 200: Type.Object({ user: Type.Ref('AdminUser') }), ...errorResponses(401, 403) } },
    }, async (req) => {
      const r = await pool.query('SELECT id, email, display_name, role FROM admin_users WHERE id = $1', [adminOf(req).adminUserId]);
      return { user: r.rows[0] };
    });
  };
