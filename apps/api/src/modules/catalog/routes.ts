import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from 'typebox';
import type { Pool } from '../../db/pool.js';
import { requireAuthenticated } from '../../plugins/auth.js';
import { BearerSecurity, Uuid, errorResponses } from '../../shared/schemas.js';

const Center = Type.Object({ id: Uuid, name: Type.String(), address: Type.Union([Type.String(), Type.Null()]), timezone: Type.String() });
const Specialty = Type.Object({ id: Uuid, name: Type.String() });
const DoctorService = Type.Object({
  doctor_service_id: Uuid,
  specialty: Specialty,
  center: Type.Object({ id: Uuid, name: Type.String() }),
  consultation_kind: Type.Union([Type.Literal('initial'), Type.Literal('follow_up')]),
  slot_minutes: Type.Integer(),
  booking_horizon_days: Type.Integer(),
  min_notice_minutes: Type.Integer(),
  patient_instructions: Type.Union([Type.String(), Type.Null()]),
});
const Doctor = Type.Object({ id: Uuid, display_name: Type.String(), services: Type.Array(DoctorService) });

export const catalogRoutes: FastifyPluginAsyncTypebox<{ pool: Pool }> = async (app, { pool }) => {
  const common = { preHandler: requireAuthenticated };

  app.get('/centers', {
    ...common,
    schema: { tags: ['Catálogos'], operationId: 'listCenters', summary: 'Centros activos', security: BearerSecurity,
              response: { 200: Type.Object({ items: Type.Array(Center) }), ...errorResponses(401) } },
  }, async () => {
    const r = await pool.query('SELECT id, name, address, timezone FROM centers WHERE active ORDER BY name');
    return { items: r.rows };
  });

  app.get('/specialties', {
    ...common,
    schema: { tags: ['Catálogos'], operationId: 'listSpecialties', summary: 'Especialidades activas con al menos un servicio activo', security: BearerSecurity,
              response: { 200: Type.Object({ items: Type.Array(Specialty) }), ...errorResponses(401) } },
  }, async () => {
    const r = await pool.query(
      `SELECT sp.id, sp.name FROM specialties sp
       WHERE sp.active AND EXISTS (SELECT 1 FROM doctor_services ds JOIN doctors d ON d.id = ds.doctor_id
                                   WHERE ds.specialty_id = sp.id AND ds.active AND d.active)
       ORDER BY sp.name`);
    return { items: r.rows };
  });

  app.get('/doctors', {
    ...common,
    schema: {
      tags: ['Catálogos'], operationId: 'listDoctors', summary: 'Médicos activos y sus servicios', security: BearerSecurity,
      querystring: Type.Object({ specialty_id: Type.Optional(Uuid), center_id: Type.Optional(Uuid) }),
      response: { 200: Type.Object({ items: Type.Array(Doctor) }), ...errorResponses(400, 401) },
    },
  }, async (req) => {
    const r = await pool.query(
      `SELECT d.id, d.display_name, ds.id AS doctor_service_id, ds.consultation_kind, ds.slot_minutes,
              ds.booking_horizon_days, ds.min_notice_minutes, ds.patient_instructions,
              sp.id AS specialty_id, sp.name AS specialty_name, c.id AS center_id, c.name AS center_name
       FROM doctors d
       JOIN doctor_services ds ON ds.doctor_id = d.id AND ds.active
       JOIN specialties sp ON sp.id = ds.specialty_id AND sp.active
       JOIN centers c ON c.id = ds.center_id AND c.active
       WHERE d.active AND ($1::uuid IS NULL OR sp.id = $1) AND ($2::uuid IS NULL OR c.id = $2)
       ORDER BY d.display_name, sp.name, ds.consultation_kind`,
      [req.query.specialty_id ?? null, req.query.center_id ?? null]);
    const byDoctor = new Map<string, { id: string; display_name: string; services: unknown[] }>();
    for (const x of r.rows) {
      let doc = byDoctor.get(x.id);
      if (!doc) { doc = { id: x.id, display_name: x.display_name, services: [] }; byDoctor.set(x.id, doc); }
      doc.services.push({
        doctor_service_id: x.doctor_service_id,
        specialty: { id: x.specialty_id, name: x.specialty_name },
        center: { id: x.center_id, name: x.center_name },
        consultation_kind: x.consultation_kind, slot_minutes: x.slot_minutes,
        booking_horizon_days: x.booking_horizon_days, min_notice_minutes: x.min_notice_minutes,
        patient_instructions: x.patient_instructions,
      });
    }
    return { items: [...byDoctor.values()] as any };
  });
};
