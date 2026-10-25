import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from 'typebox';
import type { Pool } from '../../db/pool.js';
import { patientOf, requirePatient } from '../../plugins/auth.js';
import { badRequest } from '../../shared/errors.js';
import { BearerSecurity, LocalDate, errorResponses } from '../../shared/schemas.js';
import { localDate } from '../../shared/time.js';
import { getPatientView } from './service.js';

export const patientRoutes: FastifyPluginAsyncTypebox<{ pool: Pool; tz: string }> = async (app, { pool, tz }) => {
  app.patch('/patients/me', {
    preHandler: requirePatient,
    schema: {
      tags: ['Pacientes'],
      operationId: 'updatePatientMe', summary: 'Completa el perfil del paciente autenticado (solo nombre y fecha de nacimiento ficticios)',
      description: 'El paciente se obtiene de la sesión; el cuerpo no acepta patient_id. No se piden cédula ni datos clínicos.',
      security: BearerSecurity,
      body: Type.Object({
        full_name: Type.Optional(Type.String({ minLength: 1, maxLength: 160 })),
        birth_date: Type.Optional(LocalDate),
        phone: Type.Optional(Type.String({ maxLength: 30, description: 'Teléfono de contacto (7 a 15 dígitos). Para reservar basta teléfono O correo' })),
        email: Type.Optional(Type.Union([Type.String({ maxLength: 120 }), Type.Null()], { description: 'Correo de contacto; vacío o null lo quita' })),
      }, { additionalProperties: false, minProperties: 1 }),
      response: { 200: Type.Object({ patient: Type.Ref('PatientView') }), ...errorResponses(400, 401, 403) },
    },
  }, async (req) => {
    const { patientId } = patientOf(req);
    const { full_name, birth_date, phone, email } = req.body;
    let tel: string | null = null;
    if (phone !== undefined) {
      tel = phone.trim().replace(/\s+/g, ' ');
      const digits = tel.replace(/\D/g, '');
      if (!/^\+?[0-9(][0-9 ()-]{6,22}$/.test(tel) || digits.length < 7 || digits.length > 15) {
        throw badRequest('invalid_phone', 'Escribe un teléfono válido (7 a 15 dígitos), por ejemplo (809) 555-0123');
      }
    }
    let mail: string | null | undefined;
    if (email !== undefined) {
      mail = (email ?? '').trim().toLowerCase() || null;
      if (mail && !/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(mail)) throw badRequest('invalid_email', 'Escribe un correo válido, por ejemplo nombre@correo.com');
    }
    if (birth_date !== undefined) {
      if (birth_date > localDate(new Date(), tz)) throw badRequest('invalid_birth_date', 'La fecha de nacimiento no puede ser futura');
      if (birth_date < '1900-01-01') throw badRequest('invalid_birth_date', 'Fecha de nacimiento no válida');
    }
    const name = full_name?.trim();
    if (full_name !== undefined && !name) throw badRequest('invalid_full_name', 'El nombre no puede estar vacío');
    await pool.query(
      `UPDATE patients SET full_name = COALESCE($2, full_name), birth_date = COALESCE($3::date, birth_date),
              phone = COALESCE($4, phone), email = CASE WHEN $5 THEN $6 ELSE email END WHERE id = $1`,
      [patientId, name ?? null, birth_date ?? null, tel, email !== undefined, mail ?? null]);
    return { patient: (await getPatientView(pool, patientId))! };
  });
};
