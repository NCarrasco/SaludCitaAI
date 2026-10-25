// Actualización en vivo del panel por eventos del servidor (SSE). El servidor solo avisa de QUÉ cambió (tema y tipo; id para
// operator/admin); cada pantalla vuelve a pedir sus datos a los endpoints autorizados, respetando filtros y paginación.
// Avisos cercanos se agrupan (400 ms) para no disparar muchas consultas. Al reconectar o volver a la pestaña se reconcilia
// todo (pudo perderse algún aviso). La conexión se cierra al cerrar sesión (el proveedor se desmonta).
import { type ReactNode, createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { API } from './api';

export type Topic = 'appointments' | 'handoffs' | 'offers' | 'catalog';
export const ALL_TOPICS: Topic[] = ['appointments', 'handoffs', 'offers', 'catalog'];
export interface ChangeEvent { topic: Topic; kind: string; id?: string; at: string }
type Status = 'connecting' | 'live' | 'reconnecting' | 'offline';
type Listener = (topics: Set<Topic>, events: ChangeEvent[]) => void;

interface LiveCtx { status: Status; lastEventAt: Date | null; subscribe: (fn: Listener) => () => void }
const Ctx = createContext<LiveCtx>({ status: 'offline', lastEventAt: null, subscribe: () => () => undefined });

const COALESCE_MS = 400;

export function LiveProvider({ children, onSessionEnded }: { children: ReactNode; onSessionEnded: () => void }) {
  const [status, setStatus] = useState<Status>('connecting');
  const [lastEventAt, setLastEventAt] = useState<Date | null>(null);
  const listeners = useRef(new Set<Listener>());
  const pending = useRef<{ topics: Set<Topic>; events: ChangeEvent[]; timer: number | null }>({ topics: new Set(), events: [], timer: null });

  const flush = useCallback(() => {
    const p = pending.current;
    const topics = p.topics; const events = p.events;
    p.topics = new Set(); p.events = []; p.timer = null;
    for (const fn of listeners.current) fn(topics, events);
  }, []);
  const queue = useCallback((topics: Topic[], ev?: ChangeEvent) => {
    const p = pending.current;
    topics.forEach((t) => p.topics.add(t));
    if (ev) p.events.push(ev);
    if (p.timer === null) p.timer = window.setTimeout(flush, COALESCE_MS);
  }, [flush]);

  useEffect(() => {
    let es: EventSource | null = null;
    let wasOpen = false;
    let closed = false;
    const open = () => {
      es = new EventSource(`${API}/admin/events`, { withCredentials: true });
      es.addEventListener('hello', () => {
        setStatus('live');
        // Reconexión: lo ocurrido mientras no había conexión se recupera volviendo a consultar todo
        if (wasOpen) queue(ALL_TOPICS);
        wasOpen = true;
      });
      es.addEventListener('change', (m) => {
        const ev = JSON.parse((m as MessageEvent).data) as ChangeEvent;
        setLastEventAt(new Date());
        queue([ev.topic], ev);
      });
      es.addEventListener('resync', () => queue(ALL_TOPICS));
      es.addEventListener('degraded', () => setStatus('reconnecting'));
      es.addEventListener('session-ended', () => { es?.close(); onSessionEnded(); });
      es.onerror = () => {
        if (closed) return;
        // EventSource reintenta solo (retry: 3 s); si el servidor responde con error, se cierra y se reabre
        setStatus(es?.readyState === EventSource.CLOSED ? 'offline' : 'reconnecting');
        if (es?.readyState === EventSource.CLOSED) window.setTimeout(() => { if (!closed) open(); }, 5000);
      };
    };
    open();
    const onVisible = () => { if (document.visibilityState === 'visible') queue(ALL_TOPICS); };
    const onOnline = () => queue(ALL_TOPICS);
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', onOnline);
    return () => {
      closed = true;
      es?.close();
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', onOnline);
      if (pending.current.timer !== null) clearTimeout(pending.current.timer);
    };
  }, [queue, onSessionEnded]);

  const subscribe = useCallback((fn: Listener) => { listeners.current.add(fn); return () => { listeners.current.delete(fn); }; }, []);
  return <Ctx.Provider value={{ status, lastEventAt, subscribe }}>{children}</Ctx.Provider>;
}

export const useLive = () => useContext(Ctx);

/** Ejecuta `fn` cuando cambia alguno de los temas indicados (agrupado). */
export function useLiveTopics(topics: Topic[] | undefined, fn: Listener) {
  const { subscribe } = useLive();
  const ref = useRef(fn);
  ref.current = fn;
  const key = (topics ?? []).join(',');
  useEffect(() => {
    if (!key) return undefined;
    const wanted = new Set(key.split(',') as Topic[]);
    return subscribe((changed, events) => {
      if ([...changed].some((t) => wanted.has(t))) ref.current(changed, events.filter((e) => wanted.has(e.topic)));
    });
  }, [key, subscribe]);
}
