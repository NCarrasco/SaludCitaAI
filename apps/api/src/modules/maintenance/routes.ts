import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type { FastifyRequest } from 'fastify';
import { Type, type TSchema } from 'typebox';
import type { Pool, PoolClient } from '../../db/pool.js';
import { withTransaction } from '../../db/tx.js';
import { adminOf, requireAdmin } from '../../plugins/auth.js';
import { PG, badRequest, conflict, notFound, pgCode, pgConstraint } from '../../shared/errors.js';
import { LocalDate, Uuid, errorResponses } from '../../shared/schemas.js';
import { spanishLabel, toZonedIso } from '../../shared/time.js';
import { AdminCookieSecurity } from '../auth/admin-routes.js';
import { CALENDAR_ID_RE, setBinding } from './calendar.js';
import { type ScheduleImpact, futureBookedCount, reconcileSchedule } from './schedule.js';
import { SERVICE_TOPICS, type ServiceTopic, serviceInfo } from '../conversation/service-info.js';

const TIMEZONES = new Set(Intl.supportedValuesOf('timeZone'));
const Time = Type.String({ pattern: '^([01][0-9]|2[0-3]):[0-5][0-9]$', description: 'Hora local HH:MM' });
const DryRun = Type.Object({ dry_run: Type.Optional(Type.Boolean({ description: 'Calcula el impacto sin guardar cambios' })) });

const Conflict = Type.Object({
  appointment_id: Uuid, booking_reference: Type.String(), starts_at: Type.String(), label: Type.String(), doctor: Type.String(),
  patient_name: Type.Union([Type.String(), Type.Null()]),
  reason: Type.Union([Type.Literal('outside_rules'), Type.Literal('doctor_absence'), Type.Literal('service_inactive')]),
});
const Impact = Type.Object({
  blocked_free_slots: Type.Integer(), reopened_slots: Type.Integer(), generated_slots: Type.Integer(),
  conflicts: Type.Array(Conflict, { description: 'Citas reservadas afectadas. NO se cancelan ni se mueven: requieren gestión explícita.' }),
}, { $id: 'ScheduleImpact', title: 'ScheduleImpact' });
const DeactivationImpact = Type.Object({ future_booked_appointments: Type.Integer({ description: 'Citas futuras que se conservan; no admiten nuevas reservas en ese recurso' }) });

/** Rollback deliberado de una simulación (dry_run). */
class DryRunRollback extends Error { constructor(public readonly value: unknown) { super('dry_run'); } }

export const maintenanceRoutes: FastifyPluginAsyncTypebox<{ pool: Pool; tz: string }> = async (app, { pool, tz }) => {
  app.addSchema(Impact);
  const admin = requireAdmin('admin');

  /** Transacción con auditoría y simulación opcional; traduce violaciones de unicidad a 409. */
  async function mutate<T>(req: FastifyRequest, dryRun: boolean | undefined, entity: string, action: string,
                           fn: (c: PoolClient) => Promise<{ id: string | null; before?: unknown; after?: unknown; impact?: unknown; result: T }>): Promise<T & { dry_run: boolean }> {
    try {
      return await withTransaction(pool, async (c) => {
        const out = await fn(c);
        if (dryRun) throw new DryRunRollback(out.result);
        await c.query(
          `INSERT INTO admin_audit_log (admin_user_id, action, entity, entity_id, before, after, impact) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [adminOf(req).adminUserId, action, entity, out.id, JSON.stringify(out.before ?? null), JSON.stringify(out.after ?? null),
           JSON.stringify(out.impact ?? null)]);
        return { ...out.result, dry_run: false };
      });
    } catch (e) {
      if (e instanceof DryRunRollback) return { ...(e.value as T), dry_run: true };
      if (pgCode(e) === PG.uniqueViolation) throw conflict('duplicate', 'Ya existe un registro con esos datos', { constraint: pgConstraint(e) });
      if (pgCode(e) === PG.checkViolation) throw badRequest('invalid_value', 'Algún valor no cumple las reglas del modelo', { constraint: pgConstraint(e) });
      if (pgCode(e) === PG.foreignKeyViolation) throw badRequest('invalid_reference', 'Referencia inexistente', { constraint: pgConstraint(e) });
      throw e;
    }
  }
  const tag = { tags: ['Administración: mantenimiento'], security: AdminCookieSecurity };
  const writeResp = (s: TSchema) => ({ 200: s, ...errorResponses(400, 401, 403, 404, 409) });

  // ---------------------------------------------------------------------------
  // Catálogo completo (incluye inactivos)
  // ---------------------------------------------------------------------------
  app.get('/admin/catalog', {
    preHandler: requireAdmin('viewer'),
    schema: { ...tag, operationId: 'getAdminCatalog', summary: 'Centros, especialidades, médicos y servicios, incluidos los inactivos',
      response: { 200: Type.Object({
        centers: Type.Array(Type.Object({ id: Uuid, name: Type.String(), address: Type.Union([Type.String(), Type.Null()]), timezone: Type.String(), active: Type.Boolean(),
          phone: Type.Union([Type.String(), Type.Null()]), email: Type.Union([Type.String(), Type.Null()]), info_notes: Type.Union([Type.String(), Type.Null()]),
          accepted_insurers: Type.Union([Type.Array(Type.String()), Type.Null()]), payment_methods: Type.Union([Type.Array(Type.String()), Type.Null()]) })),
        specialties: Type.Array(Type.Object({ id: Uuid, name: Type.String(), active: Type.Boolean() })),
        doctors: Type.Array(Type.Object({ id: Uuid, display_name: Type.String(), active: Type.Boolean() })),
        services: Type.Array(Type.Object({ id: Uuid, doctor_id: Uuid, center_id: Uuid, specialty_id: Uuid, consultation_kind: Type.String(),
          slot_minutes: Type.Integer(), booking_horizon_days: Type.Integer(), min_notice_minutes: Type.Integer(),
          patient_instructions: Type.Union([Type.String(), Type.Null()]), active: Type.Boolean(),
          price_dop: Type.Union([Type.Number(), Type.Null()], { description: 'Precio de la consulta en pesos dominicanos (ficticio)' }) })),
      }), ...errorResponses(401, 403) } },
  }, async () => ({
    centers: (await pool.query(`SELECT id, name, address, timezone, active, phone, email, info_notes, accepted_insurers, payment_methods
                                FROM centers ORDER BY name`)).rows,
    specialties: (await pool.query('SELECT id, name, active FROM specialties ORDER BY name')).rows,
    doctors: (await pool.query('SELECT id, display_name, active FROM doctors ORDER BY display_name')).rows,
    services: (await pool.query(`SELECT id, doctor_id, center_id, specialty_id, consultation_kind, slot_minutes, booking_horizon_days,
                                        min_notice_minutes, patient_instructions, active, price_dop::float8 AS price_dop
                                 FROM doctor_services ORDER BY doctor_id, specialty_id`)).rows,
  }));

  app.get('/admin/service-info', {
    preHandler: requireAdmin('viewer'),
    schema: { ...tag, operationId: 'previewServiceInfo',
      summary: 'Vista previa: lo que el asistente responde a una pregunta institucional con los datos actuales',
      description: 'Usa la misma función que la rama «información del servicio» del chat (sin modelo).',
      querystring: Type.Object({ topic: Type.Union(SERVICE_TOPICS.map((t) => Type.Literal(t))),
        lang: Type.Optional(Type.Union([Type.Literal('es'), Type.Literal('en')])), specialty: Type.Optional(Type.String({ maxLength: 120 })) }),
      response: { 200: Type.Object({ topic: Type.String(), lang: Type.String(), text: Type.String() }), ...errorResponses(400, 401, 403) } },
  }, async (req) => {
    const c = await pool.connect();
    try {
      const r = await serviceInfo(c, req.query.topic as ServiceTopic, req.query.lang ?? 'es', req.query.specialty ?? null);
      return { topic: req.query.topic, lang: r.lang, text: r.text };
    } finally { c.release(); }
  });

  // ---------------------------------------------------------------------------
  // Centros, especialidades y médicos: crear y editar (desactivar en lugar de borrar)
  // ---------------------------------------------------------------------------
  const simple = <B extends TSchema, P extends TSchema>(cfg: {
    path: string; entity: string; op: string; table: string; idName: string; create: B; patch: P;
    columns: string[]; validate?: (b: Record<string, unknown>) => void; impactWhere: string;
  }) => {
    const Row = Type.Object({ id: Uuid }, { additionalProperties: true });
    app.post(`/admin/${cfg.path}`, {
      preHandler: admin,
      schema: { ...tag, operationId: `create${cfg.op}`, summary: `Crea ${cfg.idName}`, body: cfg.create,
                response: writeResp(Type.Object({ item: Row, dry_run: Type.Boolean() })) },
    }, async (req) => {
      const b = req.body as Record<string, unknown>;
      cfg.validate?.(b);
      const cols = cfg.columns.filter((k) => b[k] !== undefined);
      return mutate(req, false, cfg.entity, 'create', async (c) => {
        const r = await c.query(`INSERT INTO ${cfg.table} (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
          cols.map((k) => b[k]));
        return { id: r.rows[0].id, after: r.rows[0], result: { item: r.rows[0] } };
      });
    });
    app.patch(`/admin/${cfg.path}/:id`, {
      preHandler: admin,
      schema: { ...tag, operationId: `update${cfg.op}`, params: Type.Object({ id: Uuid }), querystring: DryRun, body: cfg.patch,
                summary: `Edita o desactiva ${cfg.idName}. Desactivar impide nuevas reservas y conserva las existentes.`,
                response: writeResp(Type.Object({ item: Row, impact: DeactivationImpact, dry_run: Type.Boolean() })) },
    }, async (req) => {
      const b = req.body as Record<string, unknown>;
      cfg.validate?.(b);
      const cols = cfg.columns.filter((k) => b[k] !== undefined);
      if (!cols.length) throw badRequest('empty_patch', 'No hay cambios');
      const id = (req.params as { id: string }).id;
      return mutate(req, (req.query as { dry_run?: boolean }).dry_run, cfg.entity, 'update', async (c) => {
        const before = (await c.query(`SELECT * FROM ${cfg.table} WHERE id = $1 FOR UPDATE`, [id])).rows[0];
        if (!before) throw notFound(cfg.idName);
        const r = await c.query(`UPDATE ${cfg.table} SET ${cols.map((k, i) => `${k} = $${i + 2}`).join(', ')} WHERE id = $1 RETURNING *`,
          [id, ...cols.map((k) => b[k])]);
        const impact = { future_booked_appointments: await futureBookedCount(c, cfg.impactWhere, [id]) };
        return { id, before, after: r.rows[0], impact, result: { item: r.rows[0], impact } };
      });
    });
  };

  const Name = (max: number) => Type.String({ minLength: 1, maxLength: max });
  // Datos institucionales del centro: los usa el asistente para responder (rama «información del servicio»)
  const CENTER_INFO_COLUMNS = ['phone', 'email', 'info_notes', 'accepted_insurers', 'payment_methods'];
  const NullableText = (max: number) => Type.Optional(Type.Union([Type.String({ maxLength: max }), Type.Null()]));
  const TextList = (maxItems: number) => Type.Optional(Type.Union([Type.Array(Type.String({ maxLength: 80 }), { maxItems }), Type.Null()]));
  const CenterInfo = { phone: NullableText(40), email: NullableText(120), info_notes: NullableText(500),
                       accepted_insurers: TextList(30), payment_methods: TextList(10) };
  simple({
    path: 'centers', entity: 'center', op: 'Center', table: 'centers', idName: 'Centro',
    columns: ['name', 'address', 'timezone', 'active', ...CENTER_INFO_COLUMNS],
    create: Type.Object({ name: Name(200), address: Type.Optional(Type.Union([Type.String({ maxLength: 300 }), Type.Null()])),
                          timezone: Type.Optional(Type.String({ maxLength: 60 })), ...CenterInfo }, { additionalProperties: false }),
    patch: Type.Object({ name: Type.Optional(Name(200)), address: Type.Optional(Type.Union([Type.String({ maxLength: 300 }), Type.Null()])),
                         timezone: Type.Optional(Type.String({ maxLength: 60 })), active: Type.Optional(Type.Boolean()), ...CenterInfo },
      { additionalProperties: false, minProperties: 1 }),
    validate: (b) => {
      if (b.timezone !== undefined && !TIMEZONES.has(String(b.timezone))) throw badRequest('invalid_timezone', 'Zona horaria IANA no válida');
      if (typeof b.email === 'string' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(b.email)) throw badRequest('invalid_email', 'Correo no válido');
      // Listas sin elementos vacíos ni repetidos (se guardan recortadas)
      for (const k of ['accepted_insurers', 'payment_methods']) {
        if (Array.isArray(b[k])) b[k] = [...new Set((b[k] as string[]).map((x) => x.trim()).filter(Boolean))];
      }
      for (const k of ['phone', 'email', 'info_notes', 'address']) if (typeof b[k] === 'string' && !(b[k] as string).trim()) b[k] = null;
    },
    impactWhere: 'ds.center_id = $1',
  });
  simple({
    path: 'specialties', entity: 'specialty', op: 'Specialty', table: 'specialties', idName: 'Especialidad', columns: ['name', 'active'],
    create: Type.Object({ name: Name(120) }, { additionalProperties: false }),
    patch: Type.Object({ name: Type.Optional(Name(120)), active: Type.Optional(Type.Boolean()) }, { additionalProperties: false, minProperties: 1 }),
    impactWhere: 'ds.specialty_id = $1',
  });
  simple({
    path: 'doctors', entity: 'doctor', op: 'Doctor', table: 'doctors', idName: 'Médico', columns: ['display_name', 'active'],
    create: Type.Object({ display_name: Name(160) }, { additionalProperties: false }),
    patch: Type.Object({ display_name: Type.Optional(Name(160)), active: Type.Optional(Type.Boolean()) }, { additionalProperties: false, minProperties: 1 }),
    impactWhere: 'ds.doctor_id = $1',
  });

  // ---------------------------------------------------------------------------
  // Servicios (médico × centro × especialidad × tipo)
  // ---------------------------------------------------------------------------
  const ServiceFields = {
    slot_minutes: Type.Integer({ minimum: 5, maximum: 240 }),
    booking_horizon_days: Type.Integer({ minimum: 1, maximum: 365 }),
    min_notice_minutes: Type.Integer({ minimum: 0, maximum: 10080 }),
    patient_instructions: Type.Union([Type.String({ maxLength: 500 }), Type.Null()]),
    price_dop: Type.Union([Type.Number({ minimum: 0, maximum: 1_000_000 }), Type.Null()]),
  };
  app.post('/admin/doctor-services', {
    preHandler: admin,
    schema: { ...tag, operationId: 'createDoctorService', summary: 'Crea un servicio (sin reglas: no genera horarios hasta añadirlas)',
      body: Type.Object({ doctor_id: Uuid, center_id: Uuid, specialty_id: Uuid,
        consultation_kind: Type.Union([Type.Literal('initial'), Type.Literal('follow_up')]),
        slot_minutes: ServiceFields.slot_minutes, booking_horizon_days: Type.Optional(ServiceFields.booking_horizon_days),
        min_notice_minutes: Type.Optional(ServiceFields.min_notice_minutes), patient_instructions: Type.Optional(ServiceFields.patient_instructions),
        price_dop: Type.Optional(ServiceFields.price_dop) },
        { additionalProperties: false }),
      response: writeResp(Type.Object({ item: Type.Object({ id: Uuid }, { additionalProperties: true }), dry_run: Type.Boolean() })) },
  }, async (req) => mutate(req, false, 'doctor_service', 'create', async (c) => {
    const b = req.body;
    const r = await c.query(
      `INSERT INTO doctor_services (doctor_id, center_id, specialty_id, consultation_kind, slot_minutes, booking_horizon_days,
                                    min_notice_minutes, patient_instructions, price_dop)
       VALUES ($1, $2, $3, $4, $5, COALESCE($6, 30), COALESCE($7, 0), $8, $9) RETURNING *`,
      [b.doctor_id, b.center_id, b.specialty_id, b.consultation_kind, b.slot_minutes, b.booking_horizon_days ?? null,
       b.min_notice_minutes ?? null, b.patient_instructions ?? null, b.price_dop ?? null]);
    return { id: r.rows[0].id, after: r.rows[0], result: { item: r.rows[0] } };
  }));

  app.patch('/admin/doctor-services/:id', {
    preHandler: admin,
    schema: { ...tag, operationId: 'updateDoctorService', params: Type.Object({ id: Uuid }), querystring: DryRun,
      summary: 'Edita o desactiva un servicio y reconcilia la agenda futura (sin tocar citas reservadas)',
      body: Type.Object({ slot_minutes: Type.Optional(ServiceFields.slot_minutes), booking_horizon_days: Type.Optional(ServiceFields.booking_horizon_days),
        min_notice_minutes: Type.Optional(ServiceFields.min_notice_minutes), patient_instructions: Type.Optional(ServiceFields.patient_instructions),
        price_dop: Type.Optional(ServiceFields.price_dop), active: Type.Optional(Type.Boolean()) }, { additionalProperties: false, minProperties: 1 }),
      response: writeResp(Type.Object({ item: Type.Object({ id: Uuid }, { additionalProperties: true }), impact: Type.Ref('ScheduleImpact'), dry_run: Type.Boolean() })) },
  }, async (req) => mutate(req, req.query.dry_run, 'doctor_service', 'update', async (c) => {
    const before = (await c.query('SELECT * FROM doctor_services WHERE id = $1 FOR UPDATE', [req.params.id])).rows[0];
    if (!before) throw notFound('Servicio');
    const cols = Object.keys(req.body).filter((k) => (req.body as Record<string, unknown>)[k] !== undefined);
    const r = await c.query(`UPDATE doctor_services SET ${cols.map((k, i) => `${k} = $${i + 2}`).join(', ')} WHERE id = $1 RETURNING *`,
      [req.params.id, ...cols.map((k) => (req.body as Record<string, unknown>)[k])]);
    // Solo los campos que cambian la agenda la reconcilian; precio o instrucciones no tocan horarios
    const AGENDA = ['slot_minutes', 'booking_horizon_days', 'min_notice_minutes', 'active'];
    const impact = cols.some((k) => AGENDA.includes(k)) ? await reconcileSchedule(c, { doctorId: before.doctor_id }, tz)
      : { blocked_free_slots: 0, reopened_slots: 0, generated_slots: 0, conflicts: [] } satisfies ScheduleImpact;
    return { id: req.params.id, before, after: r.rows[0], impact, result: { item: r.rows[0], impact } };
  }));

  // ---------------------------------------------------------------------------
  // Reglas semanales y ausencias
  // ---------------------------------------------------------------------------
  const Rule = Type.Object({ id: Uuid, doctor_service_id: Uuid, weekday: Type.Integer(), local_start: Type.String(), local_end: Type.String(),
                             valid_from: LocalDate, valid_until: Type.Union([LocalDate, Type.Null()]) });
  const Exception = Type.Object({ id: Uuid, doctor_id: Uuid, starts_at: Type.String(), ends_at: Type.String(), label: Type.String(), reason: Type.String() });
  const ruleRow = (r: any) => ({ ...r, local_start: String(r.local_start).slice(0, 5), local_end: String(r.local_end).slice(0, 5) });
  const excRow = (e: any) => ({ id: e.id, doctor_id: e.doctor_id, starts_at: toZonedIso(e.starts_at, tz), ends_at: toZonedIso(e.ends_at, tz),
                                label: `${spanishLabel(e.starts_at, tz)} – ${spanishLabel(e.ends_at, tz)}`, reason: e.reason });

  app.get('/admin/doctor-services/:id/schedule', {
    preHandler: requireAdmin('admin'),
    schema: { ...tag, operationId: 'getServiceSchedule', params: Type.Object({ id: Uuid }),
      summary: 'Reglas del servicio, ausencias del médico y resumen de la agenda futura',
      response: { 200: Type.Object({ rules: Type.Array(Rule), exceptions: Type.Array(Exception),
        upcoming: Type.Object({ open_slots: Type.Integer(), blocked_slots: Type.Integer(), booked_appointments: Type.Integer() }) }),
        ...errorResponses(401, 403, 404) } },
  }, async (req) => {
    const svc = (await pool.query('SELECT doctor_id FROM doctor_services WHERE id = $1', [req.params.id])).rows[0];
    if (!svc) throw notFound('Servicio');
    const rules = (await pool.query(`SELECT id, doctor_service_id, weekday, local_start, local_end, to_char(valid_from, 'YYYY-MM-DD') valid_from,
      to_char(valid_until, 'YYYY-MM-DD') valid_until FROM schedule_rules WHERE doctor_service_id = $1 ORDER BY weekday, local_start`, [req.params.id])).rows;
    const exc = (await pool.query(`SELECT * FROM schedule_exceptions WHERE doctor_id = $1 AND ends_at > now() - interval '30 days' ORDER BY starts_at`, [svc.doctor_id])).rows;
    const up = (await pool.query(
      `SELECT count(*) FILTER (WHERE s.status = 'open')::int open_slots, count(*) FILTER (WHERE s.status = 'blocked')::int blocked_slots,
              count(a.id)::int booked_appointments
       FROM slots s LEFT JOIN appointments a ON a.slot_id = s.id AND a.status = 'booked'
       WHERE s.doctor_service_id = $1 AND s.starts_at > now()`, [req.params.id])).rows[0];
    return { rules: rules.map(ruleRow), exceptions: exc.map(excRow), upcoming: up };
  });

  const RuleBody = { weekday: Type.Integer({ minimum: 1, maximum: 7 }), local_start: Time, local_end: Time, valid_from: LocalDate,
                     valid_until: Type.Union([LocalDate, Type.Null()]) };
  const checkRule = (b: { local_start?: string; local_end?: string; valid_from?: string; valid_until?: string | null }, cur?: any) => {
    const ls = b.local_start ?? String(cur?.local_start ?? '').slice(0, 5);
    const le = b.local_end ?? String(cur?.local_end ?? '').slice(0, 5);
    if (ls && le && !(ls < le)) throw badRequest('invalid_rule', 'La hora de inicio debe ser anterior a la de fin');
    const vf = b.valid_from ?? cur?.valid_from;
    const vu = b.valid_until === undefined ? cur?.valid_until : b.valid_until;
    if (vf && vu && String(vu) < String(vf)) throw badRequest('invalid_rule', 'valid_until no puede ser anterior a valid_from');
  };

  app.post('/admin/schedule-rules', {
    preHandler: admin,
    schema: { ...tag, operationId: 'createScheduleRule', querystring: DryRun,
      summary: 'Añade una regla semanal y genera horarios; con dry_run=true solo calcula el impacto',
      body: Type.Object({ doctor_service_id: Uuid, ...RuleBody, valid_until: Type.Optional(RuleBody.valid_until) }, { additionalProperties: false }),
      response: writeResp(Type.Object({ item: Rule, impact: Type.Ref('ScheduleImpact'), dry_run: Type.Boolean() })) },
  }, async (req) => {
    checkRule(req.body);
    return mutate(req, req.query.dry_run, 'schedule_rule', 'create', async (c) => {
      const svc = (await c.query('SELECT doctor_id FROM doctor_services WHERE id = $1', [req.body.doctor_service_id])).rows[0];
      if (!svc) throw notFound('Servicio');
      const b = req.body;
      const r = await c.query(
        `INSERT INTO schedule_rules (doctor_service_id, weekday, local_start, local_end, valid_from, valid_until)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, doctor_service_id, weekday, local_start, local_end,
         to_char(valid_from, 'YYYY-MM-DD') valid_from, to_char(valid_until, 'YYYY-MM-DD') valid_until`,
        [b.doctor_service_id, b.weekday, b.local_start, b.local_end, b.valid_from, b.valid_until ?? null]);
      const impact = await reconcileSchedule(c, { doctorId: svc.doctor_id }, tz);
      return { id: r.rows[0].id, after: r.rows[0], impact, result: { item: ruleRow(r.rows[0]), impact } };
    });
  });

  app.patch('/admin/schedule-rules/:id', {
    preHandler: admin,
    schema: { ...tag, operationId: 'updateScheduleRule', params: Type.Object({ id: Uuid }), querystring: DryRun,
      summary: 'Modifica o finaliza (valid_until) una regla. Los slots libres que queden fuera se bloquean; las citas afectadas se informan como conflictos.',
      body: Type.Object({ weekday: Type.Optional(RuleBody.weekday), local_start: Type.Optional(Time), local_end: Type.Optional(Time),
        valid_from: Type.Optional(LocalDate), valid_until: Type.Optional(RuleBody.valid_until) }, { additionalProperties: false, minProperties: 1 }),
      response: writeResp(Type.Object({ item: Rule, impact: Type.Ref('ScheduleImpact'), dry_run: Type.Boolean() })) },
  }, async (req) => mutate(req, req.query.dry_run, 'schedule_rule', 'update', async (c) => {
    const before = (await c.query(`SELECT r.*, ds.doctor_id FROM schedule_rules r JOIN doctor_services ds ON ds.id = r.doctor_service_id
                                   WHERE r.id = $1 FOR UPDATE OF r`, [req.params.id])).rows[0];
    if (!before) throw notFound('Regla');
    checkRule(req.body, before); // las fechas DATE llegan como texto AAAA-MM-DD
    const cols = Object.keys(req.body).filter((k) => (req.body as Record<string, unknown>)[k] !== undefined);
    const r = await c.query(`UPDATE schedule_rules SET ${cols.map((k, i) => `${k} = $${i + 2}`).join(', ')} WHERE id = $1
      RETURNING id, doctor_service_id, weekday, local_start, local_end, to_char(valid_from, 'YYYY-MM-DD') valid_from, to_char(valid_until, 'YYYY-MM-DD') valid_until`,
      [req.params.id, ...cols.map((k) => (req.body as Record<string, unknown>)[k])]);
    const impact = await reconcileSchedule(c, { doctorId: before.doctor_id }, tz);
    return { id: req.params.id, before, after: r.rows[0], impact, result: { item: ruleRow(r.rows[0]), impact } };
  }));

  app.post('/admin/schedule-exceptions', {
    preHandler: admin,
    schema: { ...tag, operationId: 'createScheduleException', querystring: DryRun,
      summary: 'Registra una ausencia del médico. Bloquea slots libres; las citas reservadas se informan como conflictos y no se cancelan.',
      body: Type.Object({ doctor_id: Uuid, starts_at: Type.String({ format: 'date-time' }), ends_at: Type.String({ format: 'date-time' }),
        reason: Type.Union(['absence', 'holiday', 'training', 'other'].map((x) => Type.Literal(x))) }, { additionalProperties: false }),
      response: writeResp(Type.Object({ item: Exception, impact: Type.Ref('ScheduleImpact'), dry_run: Type.Boolean() })) },
  }, async (req) => {
    if (!(Date.parse(req.body.starts_at) < Date.parse(req.body.ends_at))) throw badRequest('invalid_range', 'El inicio debe ser anterior al fin');
    if (Date.parse(req.body.ends_at) <= Date.now()) throw badRequest('past_exception', 'La ausencia debe terminar en el futuro');
    return mutate(req, req.query.dry_run, 'schedule_exception', 'create', async (c) => {
      const r = await c.query(`INSERT INTO schedule_exceptions (doctor_id, starts_at, ends_at, reason) VALUES ($1, $2, $3, $4) RETURNING *`,
        [req.body.doctor_id, req.body.starts_at, req.body.ends_at, req.body.reason]);
      const impact = await reconcileSchedule(c, { doctorId: req.body.doctor_id }, tz);
      return { id: r.rows[0].id, after: r.rows[0], impact, result: { item: excRow(r.rows[0]), impact } };
    });
  });

  app.delete('/admin/schedule-exceptions/:id', {
    preHandler: admin,
    schema: { ...tag, operationId: 'deleteScheduleException', params: Type.Object({ id: Uuid }), querystring: DryRun,
      summary: 'Retira una ausencia futura y reabre los slots que vuelven a estar cubiertos por reglas',
      response: writeResp(Type.Object({ impact: Type.Ref('ScheduleImpact'), dry_run: Type.Boolean() })) },
  }, async (req) => mutate(req, req.query.dry_run, 'schedule_exception', 'delete', async (c) => {
    const before = (await c.query('SELECT * FROM schedule_exceptions WHERE id = $1 FOR UPDATE', [req.params.id])).rows[0];
    if (!before) throw notFound('Ausencia');
    if ((before.starts_at as Date).getTime() <= Date.now()) {
      throw conflict('exception_started', 'Una ausencia ya iniciada se conserva como historial; solo se retiran ausencias futuras');
    }
    await c.query('DELETE FROM schedule_exceptions WHERE id = $1', [req.params.id]);
    const impact = await reconcileSchedule(c, { doctorId: before.doctor_id }, tz);
    return { id: req.params.id, before, impact, result: { impact } };
  }));

  // ---------------------------------------------------------------------------
  // Vínculos de calendario por médico (admin)
  // ---------------------------------------------------------------------------
  const Binding = Type.Object({ doctor_id: Uuid, display_name: Type.String(), external_calendar_id: Type.Union([Type.String(), Type.Null()]),
    enabled: Type.Boolean(), sync_by_status: Type.Record(Type.String(), Type.Integer()) });
  app.get('/admin/calendar-bindings', {
    preHandler: requireAdmin('admin'),
    schema: { ...tag, operationId: 'listCalendarBindings', summary: 'Vínculo de calendario de cada médico y estado de sus sincronizaciones',
      response: { 200: Type.Object({ items: Type.Array(Binding) }), ...errorResponses(401, 403) } },
  }, async () => {
    const r = await pool.query(
      `SELECT d.id AS doctor_id, d.display_name, b.external_calendar_id, coalesce(b.enabled, false) AS enabled,
              coalesce((SELECT jsonb_object_agg(status, n) FROM (SELECT cs.status, count(*)::int n FROM calendar_sync cs
                 JOIN appointments a ON a.id = cs.appointment_id JOIN slots s ON s.id = a.slot_id WHERE s.doctor_id = d.id GROUP BY 1) t), '{}') AS sync_by_status
       FROM doctors d LEFT JOIN calendar_bindings b ON b.doctor_id = d.id ORDER BY d.display_name`);
    return { items: r.rows };
  });
  app.put('/admin/calendar-bindings/:doctorId', {
    preHandler: admin,
    schema: { ...tag, operationId: 'setCalendarBinding', params: Type.Object({ doctorId: Uuid }),
      summary: 'Vincula (o desvincula) el calendario de Google de un médico. Al habilitarlo se encolan las citas futuras del médico.',
      description: 'external_calendar_id es el ID del calendario de la cuenta de prueba (p. ej., …@group.calendar.google.com). ' +
        'No contiene secretos: las credenciales OAuth viven solo en n8n.',
      body: Type.Object({ external_calendar_id: Type.String({ minLength: 3, maxLength: 260 }), enabled: Type.Boolean() }, { additionalProperties: false }),
      response: writeResp(Type.Object({ doctor_id: Uuid, external_calendar_id: Type.String(), enabled: Type.Boolean(),
        requeued_appointments: Type.Integer(), dry_run: Type.Boolean() })) },
  }, async (req) => {
    if (!CALENDAR_ID_RE.test(req.body.external_calendar_id)) throw badRequest('invalid_calendar_id', 'ID de calendario no válido');
    return mutate(req, false, 'calendar_binding', req.body.enabled ? 'enable' : 'disable', async (c) => {
      const r = await setBinding(c, req.params.doctorId, req.body.external_calendar_id, req.body.enabled);
      if (!r) throw notFound('Médico');
      return { id: r.binding.id, before: r.before, after: r.binding, impact: { requeued_appointments: r.requeued_appointments },
               result: { doctor_id: req.params.doctorId, external_calendar_id: r.binding.external_calendar_id, enabled: r.binding.enabled,
                         requeued_appointments: r.requeued_appointments } };
    });
  });

  // ---------------------------------------------------------------------------
  // Búsqueda de citas (operator)
  // ---------------------------------------------------------------------------
  app.get('/admin/appointments', {
    preHandler: requireAdmin('operator'),
    schema: { tags: ['Administración: operación'], security: AdminCookieSecurity, operationId: 'searchAppointments',
      summary: 'Busca citas por fecha del slot, estado, centro, médico, especialidad o texto (referencia o nombre ficticio)',
      querystring: Type.Object({ from: LocalDate, to: LocalDate,
        status: Type.Optional(Type.Union(['active', 'booked', 'cancelled', 'completed', 'no_show'].map((x) => Type.Literal(x)),
          { description: '`active` = no canceladas (reservadas, asistió y no asistió). Sin valor: todas' })),
        center_id: Type.Optional(Uuid), doctor_id: Type.Optional(Uuid), specialty_id: Type.Optional(Uuid),
        q: Type.Optional(Type.String({ minLength: 2, maxLength: 80 })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 50 })), offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 10000, default: 0 })) }),
      response: { 200: Type.Object({ total: Type.Integer(),
        counts: Type.Record(Type.String(), Type.Integer(), { description: 'Citas por estado con los mismos filtros salvo el estado (para los contadores del panel)' }),
        items: Type.Array(Type.Object({
        id: Uuid, booking_reference: Type.String(), status: Type.String(), version: Type.Integer(), starts_at: Type.String(), label: Type.String(),
        patient: Type.Object({ id: Uuid, full_name: Type.Union([Type.String(), Type.Null()]) }),
        doctor: Type.String(), specialty: Type.String(), center: Type.String(), source_channel: Type.String(),
        attendance_allowed: Type.Boolean({ description: 'true si la cita está reservada y ya comenzó' }),
      })) }), ...errorResponses(400, 401, 403) } },
  }, async (req) => {
    const q = req.query;
    if (!(q.from < q.to)) throw badRequest('invalid_range', '`from` debe ser anterior a `to`');
    const params = [q.from, q.to, tz, q.status ?? null, q.center_id ?? null, q.doctor_id ?? null, q.specialty_id ?? null,
                    q.q ? `%${q.q.toLowerCase()}%` : null];
    const where = `a.starts_at >= ($1::date)::timestamp AT TIME ZONE $3 AND a.starts_at < ($2::date)::timestamp AT TIME ZONE $3
      AND ($4::text IS NULL OR ($4 = 'active' AND a.status <> 'cancelled') OR a.status = $4) AND ($5::uuid IS NULL OR ds.center_id = $5) AND ($6::uuid IS NULL OR ds.doctor_id = $6)
      AND ($7::uuid IS NULL OR ds.specialty_id = $7)
      AND ($8::text IS NULL OR lower(a.booking_reference) LIKE $8 OR lower(p.full_name) LIKE $8)`;
    const from = `FROM appointments a JOIN slots s ON s.id = a.slot_id JOIN doctor_services ds ON ds.id = s.doctor_service_id
      JOIN doctors d ON d.id = ds.doctor_id JOIN specialties sp ON sp.id = ds.specialty_id JOIN centers ce ON ce.id = ds.center_id
      JOIN patients p ON p.id = a.patient_id`;
    const total = (await pool.query(`SELECT count(*)::int n ${from} WHERE ${where}`, params)).rows[0].n;
    const byStatus = (await pool.query(`SELECT a.status, count(*)::int n ${from} WHERE ${where} GROUP BY a.status`, [...params.slice(0, 3), null, ...params.slice(4)])).rows;
    const counts: Record<string, number> = { booked: 0, completed: 0, no_show: 0, cancelled: 0 };
    for (const r of byStatus) counts[r.status] = r.n;
    const rows = (await pool.query(
      `SELECT a.id, a.booking_reference, a.status, a.version, a.starts_at, a.source_channel, p.id AS patient_id, p.full_name,
              d.display_name AS doctor, sp.name AS specialty, ce.name AS center
       ${from} WHERE ${where} ORDER BY a.starts_at, a.id LIMIT $9 OFFSET $10`, [...params, q.limit ?? 50, q.offset ?? 0])).rows;
    return { total, counts, items: rows.map((r) => ({
      id: r.id, booking_reference: r.booking_reference, status: r.status, version: r.version,
      starts_at: toZonedIso(r.starts_at, tz), label: spanishLabel(r.starts_at, tz),
      patient: { id: r.patient_id, full_name: r.full_name }, doctor: r.doctor, specialty: r.specialty, center: r.center,
      source_channel: r.source_channel, attendance_allowed: r.status === 'booked' && (r.starts_at as Date).getTime() <= Date.now(),
    })) };
  });

  // Detalle e historial de una cita (operator, solo lectura). El historial sale de appointment_events (append-only);
  // no expone actor_id (podría ser un id interno de paciente), solo el tipo de actor.
  app.get('/admin/appointments/:id', {
    preHandler: requireAdmin('operator'),
    schema: { tags: ['Administración: operación'], security: AdminCookieSecurity, operationId: 'getAppointmentDetail',
      summary: 'Detalle de una cita con su historial de cambios y asistencia',
      params: Type.Object({ id: Uuid }),
      response: { 200: Type.Object({
        id: Uuid, booking_reference: Type.String(), status: Type.String(), version: Type.Integer(), starts_at: Type.String(), label: Type.String(),
        patient: Type.Object({ id: Uuid, full_name: Type.Union([Type.String(), Type.Null()]) }),
        doctor: Type.String(), specialty: Type.String(), center: Type.String(), source_channel: Type.String(),
        advance_opt_in: Type.Boolean(), created_at: Type.String(), attendance_allowed: Type.Boolean(),
        contact: Type.Object({ phone: Type.Union([Type.String(), Type.Null()]), email: Type.Union([Type.String(), Type.Null()]) },
          { description: 'Contacto del paciente (ficticio) para localizarlo; solo operator/admin' }),
        events: Type.Array(Type.Object({
          type: Type.String(), occurred_at: Type.String(), status_before: Type.Union([Type.String(), Type.Null()]), status_after: Type.String(),
          from_starts_at: Type.Union([Type.String(), Type.Null()]), to_starts_at: Type.Union([Type.String(), Type.Null()]),
          actor_type: Type.String(), reason_code: Type.Union([Type.String(), Type.Null()]),
        })),
      }), ...errorResponses(401, 403, 404) } },
  }, async (req) => {
    const r = (await pool.query(
      `SELECT a.id, a.booking_reference, a.status, a.version, a.starts_at, a.source_channel, a.advance_opt_in, a.created_at,
              p.id AS patient_id, p.full_name, p.phone, p.email, d.display_name AS doctor, sp.name AS specialty, ce.name AS center
       FROM appointments a JOIN slots s ON s.id = a.slot_id JOIN doctor_services ds ON ds.id = s.doctor_service_id
       JOIN doctors d ON d.id = ds.doctor_id JOIN specialties sp ON sp.id = ds.specialty_id JOIN centers ce ON ce.id = ds.center_id
       JOIN patients p ON p.id = a.patient_id WHERE a.id = $1`, [req.params.id])).rows[0];
    if (!r) throw notFound('Cita');
    const ev = (await pool.query(
      `SELECT event_type, occurred_at, status_before, status_after, from_starts_at, to_starts_at, actor_type, reason_code
       FROM appointment_events WHERE appointment_id = $1 ORDER BY occurred_at, id`, [r.id])).rows;
    const z = (d: Date | null) => (d ? toZonedIso(d, tz) : null);
    return {
      id: r.id, booking_reference: r.booking_reference, status: r.status, version: r.version,
      starts_at: toZonedIso(r.starts_at, tz), label: spanishLabel(r.starts_at, tz),
      patient: { id: r.patient_id, full_name: r.full_name }, doctor: r.doctor, specialty: r.specialty, center: r.center,
      source_channel: r.source_channel, advance_opt_in: Boolean(r.advance_opt_in), created_at: toZonedIso(r.created_at, tz),
      attendance_allowed: r.status === 'booked' && (r.starts_at as Date).getTime() <= Date.now(),
      contact: { phone: r.phone ?? null, email: r.email ?? null },
      events: ev.map((e) => ({ type: e.event_type, occurred_at: toZonedIso(e.occurred_at, tz), status_before: e.status_before, status_after: e.status_after,
        from_starts_at: z(e.from_starts_at), to_starts_at: z(e.to_starts_at), actor_type: e.actor_type, reason_code: e.reason_code })),
    };
  });

};

export type { ScheduleImpact };
