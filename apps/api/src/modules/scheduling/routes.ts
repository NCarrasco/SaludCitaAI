import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from 'typebox';
import type { Pool } from '../../db/pool.js';
import { requireAuthenticated } from '../../plugins/auth.js';
import { badRequest } from '../../shared/errors.js';
import { decodeCursor, encodeCursor } from '../../shared/cursor.js';
import { canonicalJson, sha256Hex } from '../../shared/crypto.js';
import { BearerSecurity, DateTime, Uuid, errorResponses } from '../../shared/schemas.js';
import { toZonedIso } from '../../shared/time.js';
import { SLOT_COLUMNS, SLOT_JOINS, toSlotView } from './views.js';

const MAX_RANGE_DAYS = 31;
const SEARCH_DEDUPE_MINUTES = 5;

export const schedulingRoutes: FastifyPluginAsyncTypebox<{ pool: Pool; tz: string }> = async (app, { pool, tz }) => {
  app.get('/availability', {
    preHandler: requireAuthenticated,
    schema: {
      tags: ['Disponibilidad'],
      operationId: 'searchAvailability', summary: 'Slots reservables en un intervalo [from, to)',
      description: 'Devuelve solo horarios reales reservables ahora: abiertos, futuros dentro de anticipación y ' +
        'horizonte del servicio, sin cita ocupante y sin ronda de ofertas abierta. Requiere doctor_service_id, ' +
        'doctor_id o specialty_id. Cada búsqueda de paciente registra un evento analítico deduplicado.',
      security: BearerSecurity,
      querystring: Type.Object({
        doctor_service_id: Type.Optional(Uuid),
        doctor_id: Type.Optional(Uuid),
        specialty_id: Type.Optional(Uuid),
        center_id: Type.Optional(Uuid),
        from: DateTime,
        to: DateTime,
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 20 })),
        cursor: Type.Optional(Type.String({ maxLength: 200 })),
      }),
      response: {
        200: Type.Object({
          timezone: Type.String(),
          generated_at: DateTime,
          filters: Type.Record(Type.String(), Type.Unknown()),
          items: Type.Array(Type.Ref('SlotView')),
          next_cursor: Type.Union([Type.String(), Type.Null()]),
        }),
        ...errorResponses(400, 401),
      },
    },
  }, async (req) => {
    const q = req.query;
    if (!q.doctor_service_id && !q.doctor_id && !q.specialty_id) {
      throw badRequest('filter_required', 'Indica doctor_service_id, doctor_id o specialty_id');
    }
    const from = new Date(q.from);
    const to = new Date(q.to);
    if (!(from < to)) throw badRequest('invalid_range', '`from` debe ser anterior a `to`');
    if (to.getTime() - from.getTime() > MAX_RANGE_DAYS * 86400_000) {
      throw badRequest('range_too_long', `El intervalo máximo es de ${MAX_RANGE_DAYS} días`);
    }
    const limit = q.limit ?? 20;
    const params: unknown[] = [from, to];
    const where = ['rs.starts_at >= $1', 'rs.starts_at < $2'];
    const add = (sql: string, v: unknown) => { params.push(v); where.push(sql.replace('?', `$${params.length}`)); };
    if (q.doctor_service_id) add('rs.doctor_service_id = ?', q.doctor_service_id);
    if (q.doctor_id) add('rs.doctor_id = ?', q.doctor_id);
    if (q.specialty_id) add('rs.specialty_id = ?', q.specialty_id);
    if (q.center_id) add('rs.center_id = ?', q.center_id);
    if (q.cursor) {
      const [cs, cid] = decodeCursor(q.cursor);
      params.push(cs, cid);
      where.push(`(rs.starts_at, rs.slot_id) > ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
    }
    params.push(limit + 1);
    const r = await pool.query(
      `SELECT ${SLOT_COLUMNS}
       FROM reservable_slots rs JOIN slots s ON s.id = rs.slot_id ${SLOT_JOINS}
       WHERE ${where.join(' AND ')}
       ORDER BY rs.starts_at, rs.slot_id
       LIMIT $${params.length}`, params);
    const rows = r.rows.slice(0, limit);
    const last = rows[rows.length - 1];
    const next = r.rows.length > limit && last ? encodeCursor(last.starts_at, last.slot_id) : null;

    // Evento analítico de búsqueda (solo pacientes), deduplicado por paciente+filtros+ventana de 5 min
    const principal = req.principal!;
    if (principal.kind === 'patient' && !q.cursor) {
      const filters = { doctor_service_id: q.doctor_service_id, doctor_id: q.doctor_id, specialty_id: q.specialty_id,
                        center_id: q.center_id, from: from.toISOString(), to: to.toISOString() };
      const bucket = Math.floor(Date.now() / (SEARCH_DEDUPE_MINUTES * 60_000));
      const dedupe = `search:${sha256Hex(`${principal.patientId}|${canonicalJson(filters)}|${bucket}`)}`;
      await pool.query(
        `INSERT INTO analytics_events (event_type, patient_id, doctor_service_id, dedupe_key, metadata)
         VALUES ('availability_search', $1, $2, $3, $4) ON CONFLICT (dedupe_key) DO NOTHING`,
        [principal.patientId, q.doctor_service_id ?? null, dedupe,
         JSON.stringify({ specialty_id: q.specialty_id ?? null, doctor_id: q.doctor_id ?? null,
                          range_days: Math.ceil((to.getTime() - from.getTime()) / 86400_000),
                          results_first_page: rows.length })]);
    }

    return {
      timezone: tz,
      generated_at: toZonedIso(new Date(), tz),
      filters: { doctor_service_id: q.doctor_service_id ?? null, doctor_id: q.doctor_id ?? null,
                 specialty_id: q.specialty_id ?? null, center_id: q.center_id ?? null, from: q.from, to: q.to },
      items: rows.map((x) => toSlotView(x, tz)),
      next_cursor: next,
    };
  });
};
