import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';
import { existsSync } from 'node:fs';

// Cabeceras de seguridad del panel: solo recursos del propio origen, sin incrustación en marcos.
const CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self'", "img-src 'self' data:", "font-src 'self'",
  "connect-src 'self'", "object-src 'none'", "base-uri 'self'", "form-action 'self'", "frame-ancestors 'none'",
].join('; ');

/**
 * Sirve el panel compilado (apps/admin-panel/dist) en /panel/, en el mismo origen que /api/v1:
 * la cookie de sesión HttpOnly y el CSRF funcionan sin CORS. Si no existe la compilación, no se registra.
 */
export async function registerPanel(app: FastifyInstance, dir: string | undefined) {
  if (!dir || !existsSync(dir)) {
    app.log.warn({ dir }, 'panel no compilado: /panel no disponible');
    return false;
  }
  await app.register(fastifyStatic, {
    root: dir, prefix: '/panel/', index: ['index.html'], immutable: true, maxAge: '365d', decorateReply: false,
    setHeaders: (res, path) => {
      res.header('content-security-policy', CSP);
      res.header('x-content-type-options', 'nosniff');
      res.header('referrer-policy', 'same-origin');
      if (path.endsWith('.html')) res.header('cache-control', 'no-cache');
    },
  });
  app.get('/panel', (_req, reply) => reply.redirect('/panel/'));
  app.get('/', (_req, reply) => reply.redirect('/panel/'));
  return true;
}
