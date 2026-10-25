import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from 'typebox';
import type { Pool } from '../../db/pool.js';
import { patientOf, requirePatient, requireServiceScope } from '../../plugins/auth.js';
import { BearerSecurity, DateTime, errorResponses } from '../../shared/schemas.js';
import { toZonedIso } from '../../shared/time.js';
import { type GuestConfig, createGuest, recoveryCodeStatus, redeemRecoveryCode, revokeOtherSessions, revokeRecoveryCode, rotateRecoveryCode } from './service.js';

const ClientIp = Type.String({ minLength: 2, maxLength: 64, description: 'IP del visitante según la pasarela (solo para el límite de intentos)' });
const SessionOut = Type.Object({ token: Type.String(), token_type: Type.Literal('Bearer'), expires_at: DateTime, patient: Type.Ref('PatientView') });

export const guestRoutes: FastifyPluginAsyncTypebox<{ pool: Pool; tz: string; cfg: GuestConfig }> = async (app, { pool, tz, cfg }) => {
  const gateway = requireServiceScope('gateway');
  const tag = (t: string) => ({ tags: [t], security: BearerSecurity });

  app.post('/gateway/guest-sessions', {
    preHandler: gateway,
    config: { rateLimit: { max: 30, timeWindow: '1 hour', hook: 'preHandler', keyGenerator: (req: any) => `guest|${req.body?.client_ip ?? req.ip}` } },
    schema: { ...tag('Acceso sin registro (pasarela)'), operationId: 'createGuestSession',
      summary: 'Crea un paciente invitado y su sesión de dispositivo. Solo la pasarela de Gradio (scope gateway).',
      description: 'El token se guarda en una cookie HttpOnly del servidor de Gradio; nunca llega a JavaScript ni al modelo. ' +
        'Límite: 30 sesiones por hora y IP de visitante.',
      body: Type.Object({ client_ip: ClientIp }, { additionalProperties: false }),
      response: { 200: SessionOut, ...errorResponses(400, 401, 403, 429) } },
  }, async () => {
    const r = await createGuest(pool, cfg);
    return { token: r.token, token_type: 'Bearer' as const, expires_at: toZonedIso(r.expires_at, tz), patient: r.patient as any };
  });

  app.post('/gateway/recover', {
    preHandler: gateway,
    config: { rateLimit: { max: 5, timeWindow: '15 minutes', hook: 'preHandler', keyGenerator: (req: any) => `recover|${req.body?.client_ip ?? req.ip}` } },
    schema: { ...tag('Acceso sin registro (pasarela)'), operationId: 'redeemRecoveryCode',
      summary: 'Canjea un código de recuperación: nueva sesión en este dispositivo y nuevo código (el anterior queda usado)',
      description: 'Límite: 5 intentos cada 15 minutos por IP de visitante. Si el paciente tiene fecha de nacimiento, debe coincidir; ' +
        'si no coincide, el error es el mismo y el código no se consume. El código nunca se registra en logs ni viaja en URLs.',
      body: Type.Object({ code: Type.String({ minLength: 10, maxLength: 60 }), client_ip: ClientIp,
        birth_date: Type.Optional(Type.String({ format: 'date', description: 'Segunda comprobación: obligatoria si el paciente la tiene registrada' })) },
        { additionalProperties: false }),
      response: { 200: Type.Object({ token: Type.String(), token_type: Type.Literal('Bearer'), expires_at: DateTime, patient: Type.Ref('PatientView'),
        new_recovery_code: Type.String({ description: 'Mostrar una sola vez' }), new_recovery_code_expires_at: DateTime }), ...errorResponses(400, 401, 403, 429) } },
  }, async (req) => {
    const r = await redeemRecoveryCode(pool, req.body.code, cfg, req.body.birth_date);
    return { token: r.token, token_type: 'Bearer' as const, expires_at: toZonedIso(r.expires_at, tz), patient: r.patient as any,
             new_recovery_code: r.new_recovery_code, new_recovery_code_expires_at: toZonedIso(r.new_recovery_code_expires_at, tz) };
  });

  const CodeStatus = Type.Object({ active: Type.Boolean(), created_at: Type.Union([DateTime, Type.Null()]), expires_at: Type.Union([DateTime, Type.Null()]) });
  app.get('/patient-auth/recovery-code', {
    preHandler: requirePatient,
    schema: { ...tag('Autenticación de pacientes'), operationId: 'getRecoveryCodeStatus', summary: 'Estado del código de recuperación (nunca devuelve el código)',
      response: { 200: CodeStatus, ...errorResponses(401, 403) } },
  }, async (req) => {
    const s = await recoveryCodeStatus(pool, patientOf(req).patientId);
    return { active: s.active, created_at: s.created_at ? toZonedIso(s.created_at, tz) : null, expires_at: s.expires_at ? toZonedIso(s.expires_at, tz) : null };
  });

  app.post('/patient-auth/recovery-code', {
    preHandler: requirePatient,
    config: { rateLimit: { max: 10, timeWindow: '1 hour', hook: 'preHandler', keyGenerator: (req: any) => `rotate|${req.principal?.id ?? req.ip}` } },
    schema: { ...tag('Autenticación de pacientes'), operationId: 'rotateRecoveryCode',
      summary: 'Genera un código de recuperación nuevo (revoca el anterior). Se devuelve una sola vez.',
      response: { 200: Type.Object({ recovery_code: Type.String(), created_at: DateTime, expires_at: DateTime }), ...errorResponses(401, 403, 429) } },
  }, async (req, reply) => {
    reply.header('cache-control', 'no-store');
    const r = await rotateRecoveryCode(pool, patientOf(req).patientId, cfg);
    return { recovery_code: r.recovery_code, created_at: toZonedIso(r.created_at, tz), expires_at: toZonedIso(r.expires_at, tz) };
  });

  app.delete('/patient-auth/recovery-code', {
    preHandler: requirePatient,
    schema: { ...tag('Autenticación de pacientes'), operationId: 'revokeRecoveryCode', summary: 'Revoca el código de recuperación vigente',
      response: { 200: Type.Object({ revoked: Type.Boolean() }), ...errorResponses(401, 403) } },
  }, async (req) => revokeRecoveryCode(pool, patientOf(req).patientId));

  app.post('/patient-auth/sessions/revoke-others', {
    preHandler: requirePatient,
    schema: { ...tag('Autenticación de pacientes'), operationId: 'revokeOtherSessions', summary: 'Cierra las demás sesiones del paciente (otros dispositivos)',
      response: { 200: Type.Object({ revoked_sessions: Type.Integer() }), ...errorResponses(401, 403) } },
  }, async (req) => { const p = patientOf(req); return revokeOtherSessions(pool, p.patientId, p.sessionId); });
};
