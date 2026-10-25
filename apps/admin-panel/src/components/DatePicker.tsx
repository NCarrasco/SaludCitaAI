import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { addDays, localDay } from '../format';

/**
 * Selector de fecha propio (sustituye al nativo, que en Safari sale en inglés, empieza en domingo y es diminuto).
 * - Español, semana de lunes a domingo, «hoy» marcado y la fecha elegida resaltada.
 * - Teclado: flechas (día/semana), Re Pág/Av Pág (mes), Inicio/Fin (semana), Enter elige, Escape cierra.
 * - La capa es `position: fixed` (no la recortan paneles con desplazamiento) y se abre hacia arriba si no cabe.
 * Valor: 'YYYY-MM-DD' o '' (solo si `optional`).
 */
const WD = ['L', 'M', 'X', 'J', 'V', 'S', 'D'];
const WD_LONG = ['lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado', 'domingo'];
const fmt = (iso: string, o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('es-DO', { ...o, timeZone: 'UTC' }).format(new Date(`${iso}T12:00:00Z`));
const monthOf = (iso: string) => iso.slice(0, 7);
const firstOf = (ym: string) => `${ym}-01`;
const shiftMonth = (ym: string, n: number) => {
  const [y, m] = ym.split('-').map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};
const dow = (iso: string) => (new Date(`${iso}T12:00:00Z`).getUTCDay() + 6) % 7; // 0 = lunes

export function DatePicker({ value, onChange, label, optional = false, min, max, invalid = false, id }: {
  value: string; onChange: (v: string) => void; label: string; optional?: boolean; min?: string; max?: string; invalid?: boolean; id?: string;
}) {
  const today = localDay(0);
  const [open, setOpen] = useState(false);
  const [month, setMonth] = useState(monthOf(value || today));
  const [focus, setFocus] = useState(value || today);
  const [pos, setPos] = useState<{ top: number; left: number; up: boolean } | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);

  const disabled = (d: string) => Boolean((min && d < min) || (max && d > max));
  const place = () => {
    const r = trigger.current?.getBoundingClientRect();
    if (!r) return;
    const W = 296, H = 350;
    const up = r.bottom + H + 8 > window.innerHeight && r.top > H + 8;
    setPos({ top: up ? r.top - H - 6 : r.bottom + 6, left: Math.max(8, Math.min(r.left, window.innerWidth - W - 8)), up });
  };
  const openIt = () => { setMonth(monthOf(value || today)); setFocus(value || today); place(); setOpen(true); };
  const close = (refocus = true) => { setOpen(false); if (refocus) trigger.current?.focus(); };
  const pick = (d: string) => { if (disabled(d)) return; onChange(d); close(); };

  useLayoutEffect(() => { if (open) place(); }, [open]);
  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e: MouseEvent) => { if (!pop.current?.contains(e.target as Node) && !trigger.current?.contains(e.target as Node)) close(false); };
    const onMove = () => place();
    document.addEventListener('mousedown', onDoc);
    window.addEventListener('resize', onMove); window.addEventListener('scroll', onMove, true);
    return () => { document.removeEventListener('mousedown', onDoc); window.removeEventListener('resize', onMove); window.removeEventListener('scroll', onMove, true); };
  }, [open]);
  // Mueve el foco al día activo al abrir y al navegar con teclado
  useEffect(() => { if (open) pop.current?.querySelector<HTMLButtonElement>(`[data-day="${focus}"]`)?.focus(); }, [open, focus, month]);

  const go = (d: string) => { setFocus(d); if (monthOf(d) !== month) setMonth(monthOf(d)); };
  const onKey = (e: React.KeyboardEvent) => {
    const k = e.key;
    const moves: Record<string, () => string> = {
      ArrowLeft: () => addDays(focus, -1), ArrowRight: () => addDays(focus, 1), ArrowUp: () => addDays(focus, -7), ArrowDown: () => addDays(focus, 7),
      Home: () => addDays(focus, -dow(focus)), End: () => addDays(focus, 6 - dow(focus)),
      PageUp: () => `${shiftMonth(monthOf(focus), -1)}-${focus.slice(8)}`, PageDown: () => `${shiftMonth(monthOf(focus), 1)}-${focus.slice(8)}`,
    };
    if (moves[k]) { e.preventDefault(); let d = moves[k](); if (Number.isNaN(Date.parse(d))) d = firstOf(monthOf(d)); go(d); return; }
    if (k === 'Escape') { e.preventDefault(); close(); }
    if (k === 'Tab') close(false);
  };

  const start = firstOf(month);
  const lead = dow(start);
  const cells: string[] = [];
  for (let i = -lead; i < 42 - lead; i++) cells.push(addDays(start, i));
  const shown = value ? fmt(value, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }) : 'Sin fecha';

  return (
    <span className="dp">
      <button ref={trigger} id={id} type="button" className={`dp-trigger${invalid ? ' invalid' : ''}${value ? '' : ' empty'}`} aria-haspopup="dialog" aria-expanded={open}
        aria-label={`${label}: ${value ? fmt(value, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) : 'sin fecha'}. Cambiar`}
        aria-invalid={invalid || undefined} data-value={value} onClick={() => (open ? close() : openIt())}
        onKeyDown={(e) => { if (e.key === 'ArrowDown' && !open) { e.preventDefault(); openIt(); } }}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="5" width="17" height="15.5" rx="2.5" /><path d="M3.5 10h17M8 3v4M16 3v4" /></svg>
        <span className="cap">{shown}</span>
      </button>
      {open && pos && (
        <div ref={pop} className={`dp-pop${pos.up ? ' up' : ''}`} role="dialog" aria-label={`Elegir ${label.toLowerCase()}`} style={{ top: pos.top, left: pos.left }} onKeyDown={onKey}>
          <div className="dp-head">
            <button type="button" className="dp-nav" onClick={() => setMonth(shiftMonth(month, -1))} aria-label="Mes anterior">‹</button>
            <strong className="cap" aria-live="polite">{fmt(start, { month: 'long', year: 'numeric' })}</strong>
            <button type="button" className="dp-nav" onClick={() => setMonth(shiftMonth(month, 1))} aria-label="Mes siguiente">›</button>
          </div>
          <div className="dp-grid" role="grid" aria-label={fmt(start, { month: 'long', year: 'numeric' })}>
            {WD.map((w, i) => <span key={w + i} className="dp-wd" role="columnheader" aria-label={WD_LONG[i]}>{w}</span>)}
            {cells.map((d) => (
              <button key={d} type="button" data-day={d} role="gridcell" tabIndex={d === focus ? 0 : -1} disabled={disabled(d)}
                className={`dp-day${monthOf(d) !== month ? ' out' : ''}${d === today ? ' today' : ''}`} aria-selected={d === value}
                aria-label={`${fmt(d, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}${d === today ? ', hoy' : ''}`}
                onClick={() => pick(d)}>
                {Number(d.slice(8))}
              </button>
            ))}
          </div>
          <div className="dp-foot">
            <button type="button" className="ghost small" onClick={() => pick(today)} disabled={disabled(today)}>Hoy</button>
            <button type="button" className="ghost small" onClick={() => pick(addDays(today, 1))} disabled={disabled(addDays(today, 1))}>Mañana</button>
            {optional && value && <button type="button" className="ghost small dp-clear" onClick={() => { onChange(''); close(); }}>Quitar fecha</button>}
          </div>
        </div>
      )}
    </span>
  );
}
