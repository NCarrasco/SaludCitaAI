import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from 'typebox';
import type { Pool } from '../../db/pool.js';
import { patientOf, requirePatient } from '../../plugins/auth.js';
import { dummyPasswordHash, newToken, tokenHash, verifyPassword } from '../../shared/crypto.js';
import { ApiError } from '../../shared/errors.js';
import { BearerSecurity, DateTime, errorResponses } from '../../shared/schemas.js';
import { toZonedIso } from '../../shared/time.js';
import { getPatientView } from '../patients/service.js';

export const patientAuthRoutes: FastifyPluginAsyncTypebox<{ pool: Pool; tz: string; sessionTtlHours: number }> =
  async (app, { pool, tz, sessionTtlHours }) => {
    app.post('/patient-auth/login', {
      config: {
        rateLimit: {
          max: 10, timeWindow: '5 minutes', hook: 'preHandler', // tras parsear el cuerpo: la clave incluye el usuario
          keyGenerator: (req: any) => `${req.ip}|${String(req.body?.username ?? '').toLowerCase()}`,
        },
      },
      schema: {
        tags: ['Autenticación de pacientes'],
        operationId: 'patientLogin', security: [], summary: 'Inicia sesión con una cuenta ficticia de paciente',
        description: 'Devuelve un token Bearer opaco (prefijo pat_). Lo guarda el backend de Gradio; nunca se ' +
          'expone a otros pacientes. Límite: 10 intentos por IP y usuario cada 5 minutos.',
        body: Type.Object({
          username: Type.String({ minLength: 3, maxLength: 40 }),
          password: Type.String({ minLength: 1, maxLength: 200 }),
        }),
        response: {
          200: Type.Object({ token: Type.String(), token_type: Type.Literal('Bearer'), expires_at: DateTime,
                             patient: Type.Ref('PatientView') }),
          ...errorResponses(400, 401, 429),
        },
      },
    }, async (req) => {
      const username = req.body.username.trim().toLowerCase();
      const r = await pool.query(
        `SELECT a.id, a.patient_id, a.password_hash FROM patient_accounts a JOIN patients p ON p.id = a.patient_id
         WHERE a.username = $1 AND a.active AND p.active`, [username]);
      const acc = r.rows[0];
      // Verificación también cuando el usuario no existe, para no revelar cuentas por tiempo de respuesta
      const ok = await verifyPassword(req.body.password, acc?.password_hash ?? (await dummyPasswordHash()));
      if (!acc || !ok) throw new ApiError(401, 'invalid_credentials', 'Usuario o contraseña incorrectos');
      const token = newToken('pat');
      const s = await pool.query(
        `INSERT INTO patient_sessions (account_id, patient_id, token_hash, expires_at, kind)
         VALUES ($1, $4, $2, now() + make_interval(hours => $3), 'password') RETURNING expires_at`,
        [acc.id, tokenHash(token), sessionTtlHours, acc.patient_id]);
      const patient = await getPatientView(pool, acc.patient_id);
      return { token, token_type: 'Bearer' as const, expires_at: toZonedIso(s.rows[0].expires_at, tz), patient: patient! };
    });

    app.post('/patient-auth/logout', {
      preHandler: requirePatient,
      schema: { tags: ['Autenticación de pacientes'], operationId: 'patientLogout', summary: 'Revoca la sesión actual', security: BearerSecurity,
                response: { 204: Type.Null(), ...errorResponses(401, 403) } },
    }, async (req, reply) => {
      const p = patientOf(req);
      await pool.query('UPDATE patient_sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL', [p.sessionId]);
      return reply.code(204).send(null);
    });

    app.get('/patient-auth/me', {
      preHandler: requirePatient,
      schema: { tags: ['Autenticación de pacientes'], operationId: 'getPatientMe', summary: 'Paciente de la sesión', security: BearerSecurity,
                response: { 200: Type.Object({ patient: Type.Ref('PatientView') }), ...errorResponses(401, 403) } },
    }, async (req) => {
      const patient = await getPatientView(pool, patientOf(req).patientId);
      return { patient: patient! };
    });
  };
