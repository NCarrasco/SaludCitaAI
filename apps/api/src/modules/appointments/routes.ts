import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from 'typebox';
import type { Pool } from '../../db/pool.js';
import { patientOf, requirePatient } from '../../plugins/auth.js';
import { notFound } from '../../shared/errors.js';
import { decodeCursor, encodeCursor } from '../../shared/cursor.js';
import { BearerSecurity, DateTime, Uuid, errorResponses } from '../../shared/schemas.js';
import { APPOINTMENT_COLUMNS, SLOT_JOINS, getOwnAppointment, toAppointmentView } from '../scheduling/views.js';
import type { OfferConfig } from '../offers/service.js';
import { prepareIntent, type IntentInput } from './service.js';

const ReasonCode = Type.Union([
  Type.Literal('patient_request'), Type.Literal('provider_unavailable'),
  Type.Literal('scheduling_error'), Type.Literal('other'),
]);

const IntentBody = Type.Union([
  Type.Object({
    kind: Type.Literal('booking'),
    slot_id: Uuid,
    advance_opt_in: Type.Optional(Type.Boolean({ description: 'Acepta recibir ofertas para adelantar esta cita' })),
  }, { additionalProperties: false, title: 'BookingIntent' }),
  Type.Object({
    kind: Type.Literal('cancellation'),
    appointment_id: Uuid,
    expected_version: Type.Integer({ minimum: 1 }),
    reason_code: Type.Optional(ReasonCode),
  }, { additionalProperties: false, title: 'CancellationIntent' }),
  Type.Object({
    kind: Type.Literal('reschedule'),
    appointment_id: Uuid,
    expected_version: Type.Integer({ minimum: 1 }),
    new_slot_id: Uuid,
  }, { additionalProperties: false, title: 'RescheduleIntent' }),
]);

const IntentKind = Type.Union([Type.Literal('booking'), Type.Literal('cancellation'), Type.Literal('reschedule')]);

const PreparedIntent = Type.Object({
  intent_id: Uuid,
  kind: IntentKind,
  token: Type.String({ description: 'Token opaco de un solo uso; se envía en la confirmación. No lo recibe el modelo.' }),
  expires_at: DateTime,
  holds_slot: Type.Literal(false, { description: 'Una intención no retiene el horario; se revalida al confirmar' }),
  summary: Type.Object({
    slot: Type.Optional(Type.Ref('SlotView')),
    appointment: Type.Optional(Type.Ref('AppointmentView')),
    new_slot: Type.Optional(Type.Ref('SlotView')),
  }),
}, { $id: 'PreparedIntent', title: 'PreparedIntent' });

const ConfirmResult = Type.Object({
  intent_id: Uuid,
  kind: IntentKind,
  outcome: Type.Union([Type.Literal('booked'), Type.Literal('cancelled'), Type.Literal('already_cancelled'), Type.Literal('rescheduled')]),
  appointment: Type.Ref('AppointmentView'),
}, { $id: 'ConfirmResult', title: 'ConfirmResult' });

export const appointmentRoutes: FastifyPluginAsyncTypebox<{ pool: Pool; tz: string; intentTtlSeconds: number; offers: OfferConfig }> =
  async (app, { pool, tz, intentTtlSeconds, offers }) => {
    app.addSchema(PreparedIntent);
    app.addSchema(ConfirmResult);

    app.get('/appointments', {
      preHandler: requirePatient,
      schema: {
        tags: ['Citas'], operationId: 'listMyAppointments', summary: 'Citas del paciente autenticado', security: BearerSecurity,
        description: 'Solo devuelve citas propias. Orden: inicio ascendente para upcoming, descendente para past/all. Paginación por cursor.',
        querystring: Type.Object({
          scope: Type.Optional(Type.Union([Type.Literal('upcoming'), Type.Literal('past'), Type.Literal('all')], { default: 'upcoming' })),
          status: Type.Optional(Type.Union([Type.Literal('booked'), Type.Literal('cancelled'), Type.Literal('completed'), Type.Literal('no_show')])),
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 20 })),
          cursor: Type.Optional(Type.String({ maxLength: 200 })),
        }),
        response: {
          200: Type.Object({ items: Type.Array(Type.Ref('AppointmentView')), next_cursor: Type.Union([Type.String(), Type.Null()]) }),
          ...errorResponses(400, 401, 403),
        },
      },
    }, async (req) => {
      const { patientId } = patientOf(req);
      const scope = req.query.scope ?? 'upcoming';
      const cond = scope === 'upcoming' ? 'AND a.starts_at > now()' : scope === 'past' ? 'AND a.starts_at <= now()' : '';
      const asc = scope === 'upcoming';
      const limit = req.query.limit ?? 20;
      const params: unknown[] = [patientId, req.query.status ?? null, limit + 1];
      let after = '';
      if (req.query.cursor) {
        const [cs, cid] = decodeCursor(req.query.cursor);
        params.push(cs, cid);
        after = `AND (a.starts_at, a.id) ${asc ? '>' : '<'} ($4::timestamptz, $5::uuid)`;
      }
      const r = await pool.query(
        `SELECT ${APPOINTMENT_COLUMNS}, a.starts_at AS cursor_ts FROM appointments a JOIN slots s ON s.id = a.slot_id ${SLOT_JOINS}
         WHERE a.patient_id = $1 ${cond} AND ($2::text IS NULL OR a.status = $2) ${after}
         ORDER BY a.starts_at ${asc ? 'ASC' : 'DESC'}, a.id ${asc ? 'ASC' : 'DESC'} LIMIT $3`, params);
      const rows = r.rows.slice(0, limit);
      const last = rows[rows.length - 1];
      return {
        items: rows.map((x) => toAppointmentView(x, tz)) as any,
        next_cursor: r.rows.length > limit && last ? encodeCursor(last.cursor_ts, last.id) : null,
      };
    });

    app.get('/appointments/:id', {
      preHandler: requirePatient,
      schema: {
        tags: ['Citas'], operationId: 'getMyAppointment', summary: 'Detalle de una cita propia (404 si no existe o es ajena)', security: BearerSecurity,
        params: Type.Object({ id: Uuid }),
        response: { 200: Type.Object({ appointment: Type.Ref('AppointmentView') }), ...errorResponses(400, 401, 403, 404) },
      },
    }, async (req) => {
      const a = await getOwnAppointment(pool, patientOf(req).patientId, req.params.id, tz);
      if (!a) throw notFound('Cita');
      return { appointment: a as any };
    });

    app.post('/action-intents', {
      preHandler: requirePatient,
      schema: {
        tags: ['Intenciones y confirmación'],
        operationId: 'createActionIntent', summary: 'Prepara una reserva, cancelación o reprogramación pendiente de confirmación explícita',
        description: 'Valida la operación contra la agenda real y devuelve un token de un solo uso con caducidad. ' +
          'No modifica citas ni retiene el horario. Crear una intención nueva invalida las pendientes del paciente.',
        security: BearerSecurity,
        body: IntentBody,
        response: { 201: Type.Ref('PreparedIntent'), ...errorResponses(400, 401, 403, 404, 409) },
      },
    }, async (req, reply) => {
      const p = patientOf(req);
      const prepared = await prepareIntent(pool, { patientId: p.patientId, channel: 'api' }, req.body as IntentInput,
        { ttlSeconds: intentTtlSeconds, tz });
      return reply.code(201).send(prepared as any);
    });

    // La confirmación ya no se ejecuta en esta ruta: el paciente envía la orden (POST /action-intents/:id/submit) y
    // n8n la ejecuta como comando durable appointment.confirm (ver modules/commands).
  };
