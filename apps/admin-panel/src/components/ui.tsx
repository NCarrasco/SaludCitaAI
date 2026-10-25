import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import type { ApiError } from '../api';
import type { Query } from '../hooks';

export function Card({ title, subtitle, actions, children, className }: { title?: ReactNode; subtitle?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`card ${className ?? ''}`}>
      {(title || actions) && (
        <header className="card-head">
          <div>{title && <h2>{title}</h2>}{subtitle && <p className="muted">{subtitle}</p>}</div>
          {actions && <div className="card-actions">{actions}</div>}
        </header>
      )}
      <div className="card-body">{children}</div>
    </section>
  );
}

/** Indicador con valor principal, detalle (numerador/denominador) y definición desplegable.
 *  Con `onOpen`, ofrece abrir el listado filtrado correspondiente. */
export function Kpi({ label, value, detail, definition, tone, onOpen }: { label: string; value: ReactNode; detail?: ReactNode; definition?: string; tone?: 'warn'; onOpen?: () => void }) {
  return (
    <div className={`kpi ${tone ?? ''}`}>
      <div className="kpi-label">{label}{definition && <Definition text={definition} />}</div>
      <div className="kpi-value">{value}</div>
      {detail && <div className="kpi-detail">{detail}</div>}
      {onOpen && <button type="button" className="ghost small kpi-open" onClick={onOpen}>Ver citas</button>}
    </div>
  );
}

export function Definition({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <span className="definition">
      <button type="button" className="info-btn" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)} title="Ver definición">i</button>
      {open && <span id={id} role="note" className="definition-text">{text}</span>}
    </span>
  );
}

export function ErrorBox({ error, onRetry }: { error: ApiError; onRetry?: () => void }) {
  return (
    <div className="state error" role="alert">
      <strong>No se pudieron cargar los datos.</strong> {error.message}
      {error.requestId && <span className="muted"> (ref. {error.requestId.slice(0, 8)})</span>}
      {onRetry && <button type="button" onClick={onRetry}>Reintentar</button>}
    </div>
  );
}

/** Envuelve una consulta con estados de carga, error y vacío. */
export function Async<T>({ q, empty, children }: { q: Query<T>; empty?: (d: T) => boolean; children: (d: T) => ReactNode }) {
  if (q.error && !q.data) return <ErrorBox error={q.error} onRetry={q.reload} />;
  if (q.loading || !q.data) return <div className="state loading" aria-busy="true"><span className="spinner" aria-hidden="true" />Cargando…</div>;
  if (empty?.(q.data)) return <div className="state empty">No hay datos para los filtros seleccionados.</div>;
  return (
    <>
      {q.stale && q.error && <div className="state stale" role="status">Datos de las {q.loadedAt?.toLocaleTimeString('es-DO')}: no se pudieron actualizar ({q.error.message}).
        <button type="button" className="small" onClick={q.reload}>Reintentar</button></div>}
      <div className="async-body" aria-busy={q.refreshing}>{children(q.data)}</div>
    </>
  );
}

export function Badge({ children, tone }: { children: ReactNode; tone?: 'ok' | 'warn' | 'bad' | 'info' | 'muted' }) {
  return <span className={`badge ${tone ?? ''}`}>{children}</span>;
}

export function Modal({ title, children, onClose, footer }: { title: string; children: ReactNode; onClose: () => void; footer?: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { const d = ref.current; if (d && !d.open) d.showModal(); }, []);
  return (
    <dialog ref={ref} className="modal" onClose={onClose} aria-labelledby="modal-title">
      <header><h2 id="modal-title">{title}</h2><button type="button" className="ghost" onClick={onClose} aria-label="Cerrar">✕</button></header>
      <div className="modal-body">{children}</div>
      {footer && <footer>{footer}</footer>}
    </dialog>
  );
}

export function Notice({ tone, children }: { tone?: 'info' | 'warn'; children: ReactNode }) {
  return <div className={`notice ${tone ?? 'info'}`} role="status">{children}</div>;
}

export function Updated({ q }: { q: Query<unknown> }) {
  if (!q.loadedAt) return null;
  return (
    <span className="updated">
      {q.refreshing ? 'Actualizando…' : `Datos de las ${q.loadedAt.toLocaleTimeString('es-DO', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`}
      <button type="button" className="ghost small" onClick={q.reload} disabled={q.refreshing}>Actualizar</button>
    </span>
  );
}

/**
 * Paginación local de una lista ya cargada: «1–5 de 30 · Anterior · Siguiente». Si la lista se acorta (aviso en vivo,
 * filtro), la página se ajusta para no quedar fuera de rango.
 */
export function usePaged<T>(items: T[], size: number, label: string) {
  const [page, setPage] = useState(0);
  const pages = Math.max(1, Math.ceil(items.length / size));
  const p = Math.min(page, pages - 1);
  const start = p * size;
  const shown = items.slice(start, start + size);
  const pager = items.length > size ? (
    <nav className="pager" aria-label={`Páginas de ${label}`}>
      <span aria-live="polite">{start + 1}–{start + shown.length} de {items.length}</span>
      <button type="button" className="small" disabled={p === 0} onClick={() => setPage(p - 1)}>Anterior</button>
      <button type="button" className="small" disabled={p >= pages - 1} onClick={() => setPage(p + 1)}>Siguiente</button>
    </nav>) : null;
  return { shown, pager, reset: () => setPage(0) };
}

/** Muestra los primeros `step` elementos y «Ver todas (N)»; la información completa sigue accesible (sin consultas nuevas). */
export function useShowMore<T>(items: T[], step: number) {
  const [all, setAll] = useState(false);
  const shown = all ? items : items.slice(0, step);
  const more = items.length > step
    ? <button type="button" className="ghost small show-more" aria-expanded={all} onClick={() => setAll(!all)}>{all ? 'Ver menos' : `Ver todas (${items.length})`}</button>
    : null;
  return { shown, more };
}
