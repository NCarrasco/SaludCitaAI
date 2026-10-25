import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import type { Config } from './config/env.js';
import type { Pool } from './db/pool.js';
import { adminRoutes } from './modules/admin/routes.js';
import { appointmentRoutes } from './modules/appointments/routes.js';
import { adminAuthRoutes } from './modules/auth/admin-routes.js';
import { statsRoutes } from './modules/stats/routes.js';
import { LiveHub } from './modules/live/hub.js';
import { liveRoutes } from './modules/live/routes.js';
import { maintenanceRoutes } from './modules/maintenance/routes.js';
import { offerRoutes } from './modules/offers/routes.js';
import { guestRoutes } from './modules/guest/routes.js';
import { jobRoutes } from './modules/jobs/routes.js';
import { patientAuthRoutes } from './modules/auth/patient-routes.js';
import { catalogRoutes } from './modules/catalog/routes.js';
import { conversationRoutes } from './modules/conversation/routes.js';
import { commandRoutes } from './modules/commands/routes.js';
import { wakeCommands } from './modules/commands/wake.js';
import { notificationRoutes } from './modules/notifications/routes.js';
import { healthRoutes } from './modules/health/routes.js';
import { patientRoutes } from './modules/patients/routes.js';
import { schedulingRoutes } from './modules/scheduling/routes.js';
import { authPlugin } from './plugins/auth.js';
import { registerPanel } from './plugins/panel.js';
import { ApiError, PG, pgCode, pgConstraint } from './shared/errors.js';
import { sharedSchemas } from './shared/schemas.js';

export const API_PREFIX = '/api/v1';

export async function buildApp(cfg: Config, pool: Pool, opts: { logger?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger === false ? false : {
      level: cfg.logLevel,
      redact: ['req.headers.authorization', 'req.headers.cookie', 'req.body.password', 'req.body.token', 'req.body.code'],
    },
    genReqId: (req) => {
      const h = req.headers['x-request-id'];
      return typeof h === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(h) ? h : randomUUID();
    },
    ajv: { customOptions: { removeAdditional: false, coerceTypes: 'array', allErrors: false } },
    bodyLimit: 64 * 1024,
  }).withTypeProvider<TypeBoxTypeProvider>();

  app.addHook('onSend', async (req, reply) => {
    reply.header('x-request-id', req.id);
    if (req.url.startsWith(API_PREFIX)) reply.header('cache-control', 'no-store');
  });

  for (const s of sharedSchemas) app.addSchema(s);

  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'SaludCita AI API',
        version: '0.1.0',
        description: 'API de agenda de consulta externa de un hospital SIMULADO con datos ficticios. ' +
          'PostgreSQL es la fuente de verdad; toda escritura pasa por intenciones con confirmación explícita. ' +
          'Errores: {error:{code,message,details},request_id}. Fechas RFC 3339 con desplazamiento; zona de negocio ' +
          'America/Santo_Domingo.',
      },
      servers: [{ url: 'http://localhost:8080', description: 'Local (Docker Compose)' }],
      components: {
        securitySchemes: {
          bearerAuth: { type: 'http', scheme: 'bearer', description: 'Token de sesión de paciente (pat_…) o de servicio (svc_…)' },
          adminCookie: { type: 'apiKey', in: 'cookie', name: 'sc_admin',
            description: 'Sesión administrativa HttpOnly emitida por POST /auth/login. Las peticiones que modifican estado ' +
              'requieren además la cabecera X-CSRF-Token.' },
        },
      },
    },
    refResolver: { buildLocalReference: (json, _baseUri, _fragment, i) => String(json.$id ?? `def-${i}`) },
  });

  await app.register(rateLimit, { global: false });
  await app.register(cookie);
  // Orígenes del panel en lista blanca; con credenciales (cookies). Un origen no autorizado no recibe cabeceras CORS.
  await app.register(cors, {
    origin: (origin, cb) => cb(null, !origin || cfg.corsAllowedOrigins.includes(origin)),
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['content-type', 'x-csrf-token', 'idempotency-key', 'x-request-id'],
    exposedHeaders: ['x-request-id', 'idempotent-replayed'],
    maxAge: 600,
  });
  await app.register(authPlugin, { pool });

  app.setErrorHandler((err: FastifyError | ApiError | Error, req, reply) => {
    let status = 500;
    let code = 'internal_error';
    let message = 'Error interno';
    let details: Record<string, unknown> = {};
    if (err instanceof ApiError) {
      ({ status, code, message, details } = err);
    } else if ('validation' in err && err.validation) {
      status = 400; code = 'validation_error'; message = err.message;
      details = { issues: err.validation.map((v) => ({ path: v.instancePath, message: v.message })) };
    } else if ('statusCode' in err && err.statusCode === 429) {
      status = 429; code = 'rate_limited'; message = 'Demasiadas solicitudes; inténtalo más tarde';
    } else if ('statusCode' in err && typeof err.statusCode === 'number' && err.statusCode < 500) {
      status = err.statusCode; code = (err as FastifyError).code?.toLowerCase() ?? 'bad_request'; message = err.message;
    } else if (pgCode(err) === PG.uniqueViolation || pgCode(err) === PG.exclusionViolation) {
      // Defensa en profundidad: las restricciones de PostgreSQL detectaron un conflicto
      status = 409; code = 'conflict'; message = 'La operación entra en conflicto con el estado actual de la agenda';
      details = { constraint: pgConstraint(err) };
    }
    if (status >= 500) req.log.error({ err }, 'error no controlado');
    reply.code(status).send({ error: { code, message, details }, request_id: req.id });
  });

  app.setNotFoundHandler((req, reply) => {
    reply.code(404).send({ error: { code: 'route_not_found', message: 'Ruta no encontrada', details: {} }, request_id: req.id });
  });

  await registerPanel(app, cfg.panelDir);

  const tz = cfg.businessTimezone;
  // Avisos en vivo del panel: una sola conexión LISTEN por proceso (desactivable con LIVE_EVENTS=false)
  const hub = cfg.liveEvents ? new LiveHub(cfg.databaseUrl, app.log) : null;
  if (hub) {
    app.addHook('onReady', async () => hub.start());
    app.addHook('onClose', async () => hub.stop());
  }

  await app.register(async (api) => {
    await api.register(healthRoutes, { pool });
    await api.register(liveRoutes, { pool, tz, hub, heartbeatMs: cfg.liveHeartbeatMs });
    await api.register(patientAuthRoutes, { pool, tz, sessionTtlHours: cfg.patientSessionTtlHours });
    await api.register(patientRoutes, { pool, tz });
    await api.register(guestRoutes, { pool, tz, cfg: { guestSessionTtlDays: cfg.guestSessionTtlDays, recoveryCodeTtlDays: cfg.recoveryCodeTtlDays } });
    await api.register(catalogRoutes, { pool });
    await api.register(schedulingRoutes, { pool, tz });
    const offers = { windowSeconds: cfg.offerWindowSeconds, demoMode: cfg.offersDemoMode, tz };
    await api.register(appointmentRoutes, { pool, tz, intentTtlSeconds: cfg.intentTtlSeconds, offers });
    await api.register(notificationRoutes, { pool, tz });
    await api.register(adminAuthRoutes, { pool, tz, ttlHours: cfg.adminSessionTtlHours, secure: cfg.cookieSecure });
    await api.register(statsRoutes, { pool, tz });
    await api.register(adminRoutes, { pool, tz, ollamaUrl: cfg.ollamaUrl, ollamaModel: cfg.ollamaModel });
    await api.register(maintenanceRoutes, { pool, tz });
    await api.register(offerRoutes, { pool, offers });
    await api.register(jobRoutes, { pool, offers });
    // Tras confirmar, aceptar un adelanto o reintentar un comprobante: aviso inmediato a n8n (comandos durables)
    // (incluye la ejecución por n8n de una confirmación o respuesta: sus PDF y recordatorios se avisan al momento)
    const WAKE_ROUTES = /\/(action-intents\/[^/]+\/(?:confirm|submit)|offers\/[^/]+\/(?:accept|answer)|appointments\/[^/]+\/receipt\/retry|internal\/commands\/[^/]+\/(?:confirm|offer-answer))$/;
    api.addHook('onResponse', async (req, reply) => {
      if (req.method === 'POST' && (reply.statusCode === 200 || reply.statusCode === 202) && WAKE_ROUTES.test(req.url.split('?')[0]!)) {
        wakeCommands({ url: cfg.n8nCommandsWebhookUrl, secret: cfg.n8nWebhookSecret }, 'nuevos comandos');
      }
    });
    await api.register(commandRoutes, { pool, tz, cleanup: { abandonedAfterDays: cfg.guestAbandonedAfterDays, sessionRetentionDays: cfg.guestSessionRetentionDays }, offers });
    await api.register(conversationRoutes, { pool, cfg: {
      tz, ollamaUrl: cfg.ollamaUrl, ollamaModel: cfg.ollamaModel, ollamaThink: cfg.ollamaThink, llmTimeoutMs: cfg.llmTimeoutMs,
      leaseSeconds: cfg.conversationLeaseSeconds, converseEnabled: cfg.llmConverseEnabled, n8nWebhookUrl: cfg.n8nWebhookUrl, n8nWebhookSecret: cfg.n8nWebhookSecret,
      llmProvider: cfg.llmProvider, internalApiUrl: cfg.internalApiUrl,
    }, gateway: cfg.llmProvider === 'openai' && cfg.llmApiKey
      ? { apiBase: cfg.llmApiBase, apiKey: cfg.llmApiKey, model: cfg.llmApiModel, timeoutMs: cfg.llmTimeoutMs,
          ...(cfg.llmFallback ? { fallback: { ollamaUrl: cfg.ollamaUrl, model: cfg.ollamaModel } } : {}) } : undefined });
  }, { prefix: API_PREFIX });

  // Documentación interactiva (Swagger UI) y especificación OpenAPI. Los endpoints internos (/internal/*, solo n8n por la
  // red de Docker) no se publican. Con sesión del panel abierta, las llamadas de administración usan esa cookie y la
  // cabecera CSRF se toma de la cookie sc_csrf.
  app.get(`${API_PREFIX}/openapi.json`, { schema: { hide: true } }, async (req) => {
    const spec = structuredClone(app.swagger()) as { paths?: Record<string, unknown>; servers?: unknown[] };
    for (const k of Object.keys(spec.paths ?? {})) if (k.includes('/internal/')) delete spec.paths![k];
    const proto = String(req.headers['x-forwarded-proto'] ?? req.protocol);
    spec.servers = [{ url: `${proto}://${req.headers.host}`, description: 'Este servidor' }];
    return spec;
  });
  app.get(`${API_PREFIX}/docs`, { schema: { hide: true } }, async (_req, reply) => {
    reply.type('text/html; charset=utf-8').header('cache-control', 'no-cache');
    return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>SaludCita AI · API</title><meta name="robots" content="noindex">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5.17.14/swagger-ui.css">
<style>body{margin:0;background:#f6f4fc}.topbar{display:none}.swagger-ui .info .title{color:#3f1fae}</style></head><body><div id="ui"></div>
<script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5.17.14/swagger-ui-bundle.js"></script>
<script>
  const csrf = () => (document.cookie.split('; ').find((c) => c.startsWith('sc_csrf=')) || '').slice(8);
  SwaggerUIBundle({ url: '${API_PREFIX}/openapi.json', dom_id: '#ui', deepLinking: true, docExpansion: 'none', tryItOutEnabled: false,
    requestInterceptor: (r) => { r.credentials = 'include'; if (!/^(GET|HEAD|OPTIONS)$/i.test(r.method || 'GET') && csrf()) r.headers['X-CSRF-Token'] = decodeURIComponent(csrf()); return r; } });
</script></body></html>`;
  });

  return app;
}
