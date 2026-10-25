import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type, type TSchema } from 'typebox';
import type { Pool } from '../../db/pool.js';
import { requireAdmin } from '../../plugins/auth.js';
import { badRequest } from '../../shared/errors.js';
import { LocalDate, Uuid, errorResponses } from '../../shared/schemas.js';
import { toZonedIso } from '../../shared/time.js';
import { AdminCookieSecurity } from '../auth/admin-routes.js';
import { type StatsFilters, conversation, grouped, occupancyBuckets, offers, summary, timeseries } from './queries.js';

const MAX_DAYS = 366;

// Definiciones devueltas con cada respuesta (detalle y SQL de conciliación en docs/estadisticas.md)
export const DEFINITIONS = {
  periodo: 'Intervalo [from, to) de fechas locales en la zona de negocio; to se excluye.',
  searches: 'Eventos analytics_events.availability_search deduplicados (misma búsqueda del mismo paciente en 5 min = 1), por fecha de la búsqueda, terminen o no en reserva.',
  operations: 'Eventos appointment_events confirmados (booked, cancelled, rescheduled, advanced) por fecha de la operación. No son mensajes ni ejecuciones de n8n.',
  agenda_by_status: 'Citas cuyo slot actual empieza en el periodo, por estado actual (cohorte por fecha de cita, distinta de la de operaciones).',
  occupancy: 'occupied/enabled: slots abiertos del periodo con cita booked/completed/no_show sobre slots abiertos del periodo. Los slots retenidos por una oferta (held_by_offer) y los bloqueados se informan aparte y no cuentan como ocupados.',
  attendance: 'Sobre citas ya iniciadas del periodo: completed y no_show los marca el personal; unmarked = siguen en booked. rate = completed/(completed+no_show). Una reserva no acredita asistencia.',
  offers: 'advance_offers por fecha de envío y estado. acceptance_rate = accepted/(accepted+rejected+expired).',
  recovery: 'freed_eligible_slots: slots distintos liberados (cancelación, reprogramación o adelanto) antes de su inicio en el periodo. recovered_slots: de ellos, los que volvieron a ocuparse antes de su inicio. Medido hasta generated_at: slots futuros aún pueden recuperarse.',
  advance_minutes: 'Por cada evento advanced del periodo: inicio anterior − inicio nuevo, en minutos. Media, mediana y n.',
  conversation: 'Mensajes del asistente en el periodo por modo (ai, deterministic, fallback_menu, system). clarifications = respuestas que piden aclaración: un dato con opciones (fecha, especialidad o cita) o acciones sugeridas ante intención incierta. llm_errors = respuestas por fallo del modelo. Sin filtros de médico/especialidad.',
  filters: 'center_id, doctor_id y specialty_id filtran por el servicio del slot asociado. Búsquedas: se cuentan las hechas sobre un servicio que cumple todos los filtros; una búsqueda solo por especialidad (sin servicio concreto) cuenta únicamente cuando el filtro es solo de especialidad, porque no se puede atribuir a un centro ni a un médico.',
} as const;

const Filters = Type.Object({
  from: LocalDate, to: LocalDate,
  center_id: Type.Optional(Uuid), doctor_id: Type.Optional(Uuid), specialty_id: Type.Optional(Uuid),
});

const Ratio = Type.Union([Type.Number(), Type.Null()], { description: 'Proporción 0–1 con 4 decimales; null si el denominador es 0' });

const envelope = (data: TSchema) => Type.Object({
  filters: Type.Object({ from: Type.String(), to: Type.String(), center_id: Type.Union([Uuid, Type.Null()]),
                         doctor_id: Type.Union([Uuid, Type.Null()]), specialty_id: Type.Union([Uuid, Type.Null()]) }),
  timezone: Type.String(),
  generated_at: Type.String({ description: 'Hora de corte de los datos' }),
  definitions: Type.Record(Type.String(), Type.String()),
  data,
});

const Group = Type.Object({
  id: Uuid, name: Type.String(), bookings: Type.Integer(), cancellations: Type.Integer(), reschedules: Type.Integer(),
  advances: Type.Integer(), slots_enabled: Type.Integer(), slots_occupied: Type.Integer(), occupancy_rate: Ratio,
  completed: Type.Integer(), no_show: Type.Integer(), attendance_rate: Ratio,
});

const pick = (keys: (keyof typeof DEFINITIONS)[]) => Object.fromEntries(keys.map((k) => [k, DEFINITIONS[k]]));

export const statsRoutes: FastifyPluginAsyncTypebox<{ pool: Pool; tz: string }> = async (app, { pool, tz }) => {
  const parse = (q: { from: string; to: string; center_id?: string; doctor_id?: string; specialty_id?: string }): StatsFilters => {
    if (!(q.from < q.to)) throw badRequest('invalid_range', '`from` debe ser anterior a `to`');
    const days = (Date.parse(`${q.to}T00:00:00Z`) - Date.parse(`${q.from}T00:00:00Z`)) / 86400_000;
    if (days > MAX_DAYS) throw badRequest('range_too_long', `El intervalo máximo es de ${MAX_DAYS} días`);
    return { from: q.from, to: q.to, tz, center_id: q.center_id ?? null, doctor_id: q.doctor_id ?? null, specialty_id: q.specialty_id ?? null };
  };
  const wrap = (f: StatsFilters, defs: Record<string, string>, data: unknown) => ({
    filters: { from: f.from, to: f.to, center_id: f.center_id ?? null, doctor_id: f.doctor_id ?? null, specialty_id: f.specialty_id ?? null },
    timezone: tz, generated_at: toZonedIso(new Date(), tz), definitions: { periodo: DEFINITIONS.periodo, ...defs }, data: data as any,
  });
  // Métricas de negocio: viewer. El diagnóstico del asistente (modelo, latencia, tokens) es técnico: admin (sección Sistema)
  const common = (operationId: string, summaryText: string, data: TSchema, minRole: 'viewer' | 'admin' = 'viewer') => ({
    preHandler: requireAdmin(minRole),
    schema: { operationId, tags: ['Estadísticas (panel)'], security: AdminCookieSecurity, summary: summaryText,
              querystring: Filters, response: { 200: envelope(data), ...errorResponses(400, 401, 403) } },
  });

  app.get('/stats/summary', common('getStatsSummary', 'Resumen del periodo: búsquedas, operaciones, agenda, ocupación y asistencia', Type.Object({
    searches: Type.Integer(),
    operations: Type.Object({ bookings: Type.Integer(), cancellations: Type.Integer(), reschedules: Type.Integer(), advances: Type.Integer() }),
    agenda_by_status: Type.Object({ booked: Type.Integer(), cancelled: Type.Integer(), completed: Type.Integer(), no_show: Type.Integer() }),
    occupancy: Type.Object({ occupied: Type.Integer(), enabled: Type.Integer(), rate: Ratio, held_by_offer: Type.Integer(), blocked: Type.Integer() }),
    attendance: Type.Object({ completed: Type.Integer(), no_show: Type.Integer(), unmarked: Type.Integer(), rate: Ratio }),
  })), async (req) => {
    const f = parse(req.query);
    return wrap(f, pick(['searches', 'operations', 'agenda_by_status', 'occupancy', 'attendance', 'filters']), await summary(pool, f));
  });

  app.get('/stats/timeseries', common('getStatsTimeseries', 'Serie diaria (día local, días vacíos con 0)', Type.Array(Type.Object({
    date: LocalDate, searches: Type.Integer(), bookings: Type.Integer(), cancellations: Type.Integer(), reschedules: Type.Integer(),
    advances: Type.Integer(), slots_enabled: Type.Integer(), slots_occupied: Type.Integer(), occupancy_rate: Ratio,
  }))), async (req) => {
    const f = parse(req.query);
    return wrap(f, pick(['searches', 'operations', 'occupancy', 'filters']), await timeseries(pool, f));
  });

  app.get('/stats/doctors', common('getStatsByDoctor', 'Indicadores por médico', Type.Array(Group)), async (req) => {
    const f = parse(req.query);
    return wrap(f, pick(['operations', 'occupancy', 'attendance', 'filters']), await grouped(pool, f, 'doctor'));
  });

  app.get('/stats/specialties', common('getStatsBySpecialty', 'Indicadores por especialidad', Type.Array(Group)), async (req) => {
    const f = parse(req.query);
    return wrap(f, pick(['operations', 'occupancy', 'attendance', 'filters']), await grouped(pool, f, 'specialty'));
  });

  app.get('/stats/occupancy', common('getStatsOccupancy', 'Ocupación por día de la semana (1 = lunes) y hora local de inicio', Type.Array(Type.Object({
    weekday: Type.Integer({ minimum: 1, maximum: 7 }), hour: Type.Integer({ minimum: 0, maximum: 23 }),
    enabled: Type.Integer(), occupied: Type.Integer(), held_by_offer: Type.Integer(), rate: Ratio,
  }))), async (req) => {
    const f = parse(req.query);
    return wrap(f, pick(['occupancy', 'filters']), await occupancyBuckets(pool, f));
  });

  app.get('/stats/offers', common('getStatsOffers', 'Ofertas de adelanto, adelanto conseguido y recuperación de horarios', Type.Object({
    offers_by_status: Type.Record(Type.String(), Type.Integer()), acceptance_rate: Ratio,
    rounds_by_status: Type.Record(Type.String(), Type.Integer()),
    advance_minutes: Type.Object({ n: Type.Integer(), mean: Type.Union([Type.Number(), Type.Null()]), median: Type.Union([Type.Number(), Type.Null()]) }),
    recovery: Type.Object({ recovered_slots: Type.Integer(), freed_eligible_slots: Type.Integer(), rate: Ratio }),
  })), async (req) => {
    const f = parse(req.query);
    return wrap(f, pick(['offers', 'advance_minutes', 'recovery', 'filters']), await offers(pool, f));
  });

  app.get('/stats/conversation', common('getStatsConversation', 'Calidad del asistente: modos, aclaraciones, errores del modelo, latencia y tokens', Type.Object({
    replies: Type.Integer(), by_mode: Type.Record(Type.String(), Type.Integer()), clarifications: Type.Integer(),
    llm_errors: Type.Integer(), ai_by_intent: Type.Record(Type.String(), Type.Integer()), handoffs: Type.Integer(),
    model_latency_ms: Type.Object({ n: Type.Integer(), p50: Type.Union([Type.Integer(), Type.Null()]), p90: Type.Union([Type.Integer(), Type.Null()]) }),
    tokens: Type.Object({ prompt: Type.Integer(), completion: Type.Integer() }),
  }), 'admin'), async (req) => {
    const f = parse(req.query);
    return wrap(f, pick(['conversation']), await conversation(pool, f));
  });
};
