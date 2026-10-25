// Avisos en vivo para el panel. PostgreSQL emite NOTIFY al confirmar cada cambio operativo (migración 0014); este
// proceso mantiene UNA conexión LISTEN (no una por navegador) y reenvía el aviso a las conexiones SSE abiertas.
// El aviso no contiene datos personales: tema, tipo y, solo para operator/admin, el id de la entidad.
import pg from 'pg';
import type { FastifyBaseLogger } from 'fastify';
import type { AdminRole } from '../../plugins/auth.js';

export interface LiveEvent { topic: string; kind: string; id: string | null; at: string }
export interface LiveClient { role: AdminRole; sessionId: string; send: (event: string, data: object) => void; end: () => void }

const CHANNEL = 'sc_admin_events';

export class LiveHub {
  private conn: pg.Client | null = null;
  private readonly clients = new Set<LiveClient>();
  private stopped = false;
  private retryMs = 1000;
  private everConnected = false;
  status: 'connecting' | 'listening' | 'down' = 'connecting';

  constructor(private readonly databaseUrl: string, private readonly log: FastifyBaseLogger) {}

  get size() { return this.clients.size; }

  start() { void this.connect(); }

  private async connect() {
    if (this.stopped) return;
    const c = new pg.Client({ connectionString: this.databaseUrl, application_name: 'saludcita-live' });
    c.on('notification', (n) => this.dispatch(n.payload));
    c.on('error', (e) => this.lost(c, e));
    c.on('end', () => this.lost(c));
    try {
      await c.connect();
      await c.query(`LISTEN ${CHANNEL}`);
      this.conn = c;
      this.status = 'listening';
      this.retryMs = 1000;
      // Tras una reconexión pudo perderse algún aviso: los navegadores vuelven a consultar todo
      if (this.everConnected) this.broadcast('resync', { reason: 'listener_reconnected', at: new Date().toISOString() });
      this.everConnected = true;
    } catch (e) {
      this.lost(c, e as Error);
    }
  }

  private lost(c: pg.Client, e?: Error) {
    if (this.conn && this.conn !== c) return;
    this.conn = null;
    if (this.stopped) return;
    if (this.status !== 'down') this.log.warn({ err: e?.message }, 'live: conexión LISTEN perdida; reintentando');
    this.status = 'down';
    this.broadcast('degraded', { at: new Date().toISOString() });
    c.removeAllListeners();
    void c.end().catch(() => undefined);
    const wait = this.retryMs;
    this.retryMs = Math.min(30_000, this.retryMs * 2);
    setTimeout(() => void this.connect(), wait).unref();
  }

  private dispatch(payload: string | undefined) {
    let p: { topic?: string; kind?: string; id?: string | null };
    try { p = JSON.parse(payload ?? '{}'); } catch { return; }
    if (!p.topic) return;
    const ev: LiveEvent = { topic: String(p.topic), kind: String(p.kind ?? ''), id: p.id ?? null, at: new Date().toISOString() };
    for (const cl of this.clients) {
      // viewer: solo tema y tipo (sin identificadores); operator/admin: también el id para revalidar lo que editan
      cl.send('change', cl.role === 'viewer' ? { topic: ev.topic, kind: ev.kind, at: ev.at } : ev);
    }
  }

  private broadcast(event: string, data: object) { for (const cl of this.clients) cl.send(event, data); }

  add(c: LiveClient) { this.clients.add(c); }
  remove(c: LiveClient) { this.clients.delete(c); }
  countForSession(sessionId: string) { let n = 0; for (const c of this.clients) if (c.sessionId === sessionId) n++; return n; }

  async stop() {
    this.stopped = true;
    for (const c of this.clients) c.end();
    this.clients.clear();
    const c = this.conn; this.conn = null;
    if (c) { c.removeAllListeners(); await c.end().catch(() => undefined); }
  }
}
