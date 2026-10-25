import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from 'typebox';
import type { Pool } from '../../db/pool.js';
import { patientOf, requirePatient } from '../../plugins/auth.js';
import { BearerSecurity, DateTime, Uuid, errorResponses } from '../../shared/schemas.js';
import { spanishLabel, toZonedIso } from '../../shared/time.js';
import type { OfferConfig } from './service.js';

const Offer = Type.Object({
  id: Uuid, status: Type.String(), expires_at: DateTime, offered_at: DateTime, demo_mode: Type.Boolean(),
  appointment: Type.Object({ id: Uuid, booking_reference: Type.String(), current_label: Type.String() }),
  offered_slot: Type.Object({ slot_id: Uuid, starts_at: DateTime, label: Type.String(), doctor: Type.String() }),
}, { $id: 'AdvanceOffer', title: 'AdvanceOffer' });

export const offerRoutes: FastifyPluginAsyncTypebox<{ pool: Pool; offers: OfferConfig }> = async (app, { pool, offers }) => {
  const tz = offers.tz;
  app.addSchema(Offer);

  app.get('/offers', {
    preHandler: requirePatient,
    schema: {
      operationId: 'listMyOffers', tags: ['Ofertas de adelanto'], security: BearerSecurity,
      summary: 'Ofertas de adelanto del paciente (pendientes primero; incluye las recientes cerradas)',
      response: { 200: Type.Object({ items: Type.Array(Type.Ref('AdvanceOffer')) }), ...errorResponses(401, 403) },
    },
  }, async (req) => {
    const r = await pool.query(
      `SELECT o.id, o.status, o.expires_at, o.offered_at, r.demo_mode, a.id AS appointment_id, a.booking_reference, a.starts_at AS current_start,
              s.id AS slot_id, s.starts_at, d.display_name AS doctor
       FROM advance_offers o JOIN offer_rounds r ON r.id = o.round_id JOIN slots s ON s.id = r.slot_id JOIN doctors d ON d.id = s.doctor_id
       JOIN appointments a ON a.id = o.appointment_id
       WHERE a.patient_id = $1 AND (o.status = 'pending' OR o.offered_at > now() - interval '7 days')
       ORDER BY (o.status = 'pending') DESC, o.offered_at DESC LIMIT 20`, [patientOf(req).patientId]);
    return { items: r.rows.map((x) => ({
      id: x.id, status: x.status === 'pending' && x.expires_at.getTime() <= Date.now() ? 'expired' : x.status,
      expires_at: toZonedIso(x.expires_at, tz), offered_at: toZonedIso(x.offered_at, tz), demo_mode: x.demo_mode,
      appointment: { id: x.appointment_id, booking_reference: x.booking_reference, current_label: spanishLabel(x.current_start, tz) },
      offered_slot: { slot_id: x.slot_id, starts_at: toZonedIso(x.starts_at, tz), label: spanishLabel(x.starts_at, tz), doctor: x.doctor },
    })) as any };
  });

  // Aceptar o rechazar ya no se ejecuta aquí: el paciente envía la respuesta (POST /offers/:id/answer) y n8n la
  // ejecuta como comando durable offer.answer (ver modules/commands).
};
