import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, api } from './api';
import { type Topic, useLiveTopics } from './live';

export interface Query<T> {
  data: T | null; error: ApiError | null;
  /** Cargando por primera vez para ESTA consulta (sin datos que mostrar) */
  loading: boolean;
  /** Volviendo a consultar la misma consulta (aviso en vivo, reconexión o «Actualizar»): se muestran los datos anteriores */
  refreshing: boolean;
  /** Hubo un error al actualizar y los datos que se muestran son de la última carga correcta */
  stale: boolean;
  reload: () => void; loadedAt: Date | null;
}

/**
 * Carga datos de la API.
 * - Los resultados pertenecen a una ruta concreta: al cambiar filtros no se muestran los de la consulta anterior.
 * - Cancela la petición anterior (AbortController) e ignora respuestas tardías.
 * - Con `topics`, se vuelve a consultar cuando llega un aviso en vivo de esos temas (manteniendo los datos mientras tanto).
 * - `everyMs`: actualización periódica (solo donde no hay avisos en vivo; se documenta como periódica).
 */
export function useApi<T>(path: string | null, opts: { topics?: Topic[]; everyMs?: number } = {}): Query<T> {
  const [state, setState] = useState<{ path: string | null; data: T | null; error: ApiError | null; loadedAt: Date | null }>(
    { path: null, data: null, error: null, loadedAt: null });
  const [inflight, setInflight] = useState(false);
  const [tick, setTick] = useState(0);
  const ctrl = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!path) { setInflight(false); return; }
    ctrl.current?.abort();
    const ac = new AbortController();
    ctrl.current = ac;
    setInflight(true);
    api<T>(path, { signal: ac.signal })
      .then((d) => { if (!ac.signal.aborted) setState({ path, data: d, error: null, loadedAt: new Date() }); })
      .catch((e: unknown) => {
        if (ac.signal.aborted) return;
        const err = e instanceof ApiError ? e : new ApiError(0, 'error', String(e));
        setState((s) => (s.path === path ? { ...s, error: err } : { path, data: null, error: err, loadedAt: null }));
      })
      .finally(() => { if (!ac.signal.aborted) setInflight(false); });
    return () => ac.abort();
  }, [path, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  useLiveTopics(opts.topics, reload);
  useEffect(() => {
    if (!opts.everyMs || !path) return undefined;
    const id = window.setInterval(() => { if (document.visibilityState === 'visible') reload(); }, opts.everyMs);
    return () => clearInterval(id);
  }, [opts.everyMs, path, reload]);

  const mine = state.path === path;
  const data = mine ? state.data : null;
  return {
    data, error: mine ? state.error : null, loading: Boolean(path) && data === null && (inflight || !mine),
    refreshing: inflight && data !== null, stale: mine && data !== null && state.error !== null,
    reload, loadedAt: mine ? state.loadedAt : null,
  };
}

/** Valor con retardo (p. ej., búsqueda por texto: no consultar por cada tecla). */
export function useDebounced<T>(value: T, ms = 350): T {
  const [v, setV] = useState(value);
  useEffect(() => { const id = window.setTimeout(() => setV(value), ms); return () => clearTimeout(id); }, [value, ms]);
  return v;
}
