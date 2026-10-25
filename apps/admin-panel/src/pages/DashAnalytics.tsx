import { useMemo, useState } from 'react';
import { type Bucket, type Dashboard, type Day, type Envelope, type Group, type Summary, qs } from '../api';
import { ChartView, cssVar, useTheme } from '../components/Chart';
import { Async } from '../components/ui';
import { addDays, n, pct, shortDate } from '../format';
import { useApi } from '../hooks';

export interface Scope { center_id: string; specialty_id: string; doctor_id: string }
const scoped = (s: Scope, from: string, to: string) => qs({ from, to, center_id: s.center_id, specialty_id: s.specialty_id, doctor_id: s.doctor_id });

// ---------------------------------------------------------------------------
// Tendencia: dos líneas (reservas · cancelaciones) distinguibles también por trazo, y totales del periodo debajo
// ---------------------------------------------------------------------------
const RANGES = [14, 30, 90] as const;

export function TrendCard({ date, scope, filtered }: { date: string; scope: Scope; filtered: boolean }) {
  const [days, setDays] = useState<(typeof RANGES)[number]>(30);
  const ts = useApi<Envelope<Day[]>>(`/stats/timeseries${scoped(scope, addDays(date, -(days - 1)), addDays(date, 1))}`, { topics: ['appointments'] });
  return (
    <section className="card dash-trend" aria-labelledby="trend-title">
      <div className="card-head">
        <div><h2 id="trend-title">Reservas y cancelaciones</h2>
          <p className="muted small">Por fecha de registro · {days} días hasta {shortDate(date)}{filtered ? ' · con filtros' : ''}</p></div>
        <div className="segmented compact-seg" role="group" aria-label="Días mostrados">
          {RANGES.map((r) => <button key={r} type="button" aria-pressed={days === r} onClick={() => setDays(r)}>{r} d</button>)}
        </div>
      </div>
      <div className="card-body">
        <Async q={ts} empty={(e) => e.data.every((x) => x.bookings + x.cancellations + x.reschedules === 0)}>
          {({ data }) => <Trend days={data} />}
        </Async>
      </div>
    </section>
  );
}

function Trend({ days }: { days: Day[] }) {
  const theme = useTheme();
  const last = days.length - 1;
  const config = useMemo(() => {
    const dot = (color: string) => ({ pointRadius: days.map((_, i) => (i === last ? 4 : 0)), pointBackgroundColor: color, pointHoverRadius: 4 });
    return {
      type: 'line' as const,
      data: { labels: days.map((x) => shortDate(x.date)), datasets: [
        { label: 'Reservas', data: days.map((x) => x.bookings), borderColor: cssVar('--c1'), backgroundColor: cssVar('--c1-soft'), fill: true,
          borderWidth: 2.5, tension: 0.25, ...dot(cssVar('--c1')) },
        { label: 'Cancelaciones', data: days.map((x) => x.cancellations), borderColor: cssVar('--c3'), backgroundColor: cssVar('--c3-soft'), fill: true, borderDash: [6, 4],
          borderWidth: 2.5, tension: 0.25, ...dot(cssVar('--c3')) },
      ] },
      options: {
        interaction: { mode: 'index' as const, intersect: false },
        scales: { x: { grid: { display: false }, ticks: { maxRotation: 0, autoSkipPadding: 16 } },
                  y: { beginAtZero: true, grace: '10%', ticks: { precision: 0, maxTicksLimit: 5 }, title: { display: true, text: 'operaciones' } } },
        plugins: { legend: { display: false } },
      },
    };
  }, [days, theme]); // eslint-disable-line react-hooks/exhaustive-deps
  const t = days.reduce((a, x) => ({ b: a.b + x.bookings, c: a.c + x.cancellations, r: a.r + x.reschedules }), { b: 0, c: 0, r: 0 });
  return (
    <>
      <div className="trend-summary">
        <div className="figure">
          <span className="figure-value">{n(t.b)}<span className="figure-dot" aria-hidden="true" /></span>
          <span className="figure-label">Reservas registradas</span>
        </div>
        <ul className="trend-legend">
          <li><span className="swatch line" aria-hidden="true" /><strong>{n(t.b)}</strong> reservas</li>
          <li><span className="swatch line dashed bad" aria-hidden="true" /><strong>{n(t.c)}</strong> cancelaciones · {t.b ? pct(t.c / t.b) : '—'} de las reservas</li>
          <li><span className="swatch" aria-hidden="true" style={{ background: 'var(--c2)' }} /><strong>{n(t.r)}</strong> cambios de horario</li>
        </ul>
      </div>
      <ChartView config={config as never} height={220} label={`Reservas y cancelaciones por día: ${t.b} reservas y ${t.c} cancelaciones en ${days.length} días`}
        table={{ caption: 'Operaciones por día', columns: ['Día', 'Reservas', 'Cancelaciones', 'Cambios'], rows: days.map((x) => [shortDate(x.date), x.bookings, x.cancellations, x.reschedules]) }} />
    </>
  );
}

// ---------------------------------------------------------------------------
// Analítica: rankings y distribuciones (plegada por defecto; se carga solo al abrirla)
// ---------------------------------------------------------------------------
const STATE_ROWS = [['booked', 'Reservadas (pendientes o sin marcar)', '--c1'], ['completed', 'Asistió', '--c2'], ['no_show', 'No asistió', '--c4'], ['cancelled', 'Canceladas', '--c3']] as const;

export function Analytics({ date, scope, availability }: { date: string; scope: Scope; availability: Dashboard['availability_7d'] }) {
  const next = scoped(scope, date, addDays(date, 7));
  const past = scoped(scope, addDays(date, -29), addDays(date, 1));
  const doctors = useApi<Envelope<Group[]>>(`/stats/doctors${next}`, { topics: ['appointments', 'catalog'] });
  const sum = useApi<Envelope<Summary>>(`/stats/summary${past}`, { topics: ['appointments'] });
  const occ = useApi<Envelope<Bucket[]>>(`/stats/occupancy${past}`, { topics: ['appointments'] });
  return (
    <div className="analytics-grid">
      <article className="card">
        <div className="card-head"><div><h3>Ocupación por médico</h3><p className="muted small">Próximos 7 días · horarios ocupados de los habilitados</p></div></div>
        <div className="card-body">
          <Async q={doctors} empty={(e) => e.data.every((x) => x.slots_enabled === 0)}>
            {({ data }) => <Ranking rows={data.filter((x) => x.slots_enabled > 0).sort((a, b) => (b.occupancy_rate ?? 0) - (a.occupancy_rate ?? 0))
              .map((x) => ({ key: x.id, label: x.name.replace(/ \(fictici[oa]\)/, ''), value: x.occupancy_rate ?? 0,
                text: `${pct(x.occupancy_rate)} · ${n(x.slots_occupied)} de ${n(x.slots_enabled)}` }))} />}
          </Async>
        </div>
      </article>

      <article className="card">
        <div className="card-head"><div><h3>Disponibilidad por especialidad</h3><p className="muted small">7 días desde {shortDate(date)} · libres, ocupados y reservados para oferta</p></div></div>
        <div className="card-body">
          {availability.length === 0 ? <p className="state empty">No hay horarios habilitados en esos días.</p> : (
            <ul className="stack-bars">
              {availability.map((r) => (
                <li key={r.specialty} aria-label={`${r.specialty}: ${r.free} libres, ${r.occupied} ocupados, ${r.held} reservados para oferta, de ${r.enabled}`}>
                  <div className="bar-head"><span>{r.specialty}</span><span className="num"><strong>{n(r.free)}</strong> libres de {n(r.enabled)}</span></div>
                  <div className="bar-track" aria-hidden="true">
                    <span className="seg free" style={{ width: `${(r.free / Math.max(1, r.enabled)) * 100}%` }} />
                    <span className="seg occupied" style={{ width: `${(r.occupied / Math.max(1, r.enabled)) * 100}%` }} />
                    <span className="seg held" style={{ width: `${(r.held / Math.max(1, r.enabled)) * 100}%` }} />
                  </div>
                </li>))}
            </ul>)}
          <ul className="legend-inline" aria-hidden="true"><li><span className="swatch free" />Libres</li><li><span className="swatch occupied" />Ocupados</li><li><span className="swatch held" />Reservados para oferta</li></ul>
        </div>
      </article>

      <article className="card">
        <div className="card-head"><div><h3>Estado de las citas</h3><p className="muted small">Citas con fecha en los últimos 30 días · estado actual</p></div></div>
        <div className="card-body">
          <Async q={sum} empty={(e) => Object.values(e.data.agenda_by_status).every((v) => v === 0)}>
            {({ data }) => <Donut counts={data.agenda_by_status} />}
          </Async>
        </div>
      </article>

      <article className="card">
        <div className="card-head"><div><h3>Ocupación por hora del día</h3><p className="muted small">Últimos 30 días · hora local de inicio</p></div></div>
        <div className="card-body">
          <Async q={occ} empty={(e) => e.data.every((x) => x.enabled === 0)}>
            {({ data }) => <HourOccupancy buckets={data} />}
          </Async>
        </div>
      </article>
    </div>
  );
}

/** Ranking horizontal ordenado de mayor a menor, con el valor escrito (no solo la longitud de la barra). */
function Ranking({ rows }: { rows: { key: string; label: string; value: number; text: string }[] }) {
  if (rows.length === 0) return <p className="state empty">Sin horarios habilitados.</p>;
  return (
    <ol className="ranking">
      {rows.map((r) => (
        <li key={r.key}>
          <div className="bar-head"><span>{r.label}</span><span className="num">{r.text}</span></div>
          <div className="bar-track" aria-hidden="true"><span className="seg free" style={{ width: `${Math.min(100, r.value * 100)}%` }} /></div>
        </li>))}
    </ol>
  );
}

/** Dona con el total en el centro; leyenda con cantidad y porcentaje (el color nunca es el único dato). */
function Donut({ counts }: { counts: Summary['agenda_by_status'] }) {
  const total = STATE_ROWS.reduce((a, [k]) => a + counts[k], 0);
  const R = 46, C = 2 * Math.PI * R;
  let offset = 0;
  return (
    <div className="donut-wrap">
      <svg viewBox="0 0 120 120" className="donut" role="img" aria-label={`${total} citas: ${STATE_ROWS.map(([k, l]) => `${counts[k]} ${l}`).join(', ')}`}>
        <circle cx="60" cy="60" r={R} className="donut-track" />
        {STATE_ROWS.map(([k, , c]) => {
          const len = total ? (counts[k] / total) * C : 0;
          const el = len > 0 ? <circle key={k} cx="60" cy="60" r={R} fill="none" stroke={`var(${c})`} strokeWidth="14"
            strokeDasharray={`${len} ${C - len}`} strokeDashoffset={-offset} transform="rotate(-90 60 60)" /> : null;
          offset += len;
          return el;
        })}
        <text x="60" y="58" textAnchor="middle" className="donut-total">{n(total)}</text>
        <text x="60" y="75" textAnchor="middle" className="donut-label">citas</text>
      </svg>
      <ul className="donut-legend">
        {STATE_ROWS.map(([k, l, c]) => (
          <li key={k}><span className="swatch" style={{ background: `var(${c})` }} />{l}<span className="num"><strong>{n(counts[k])}</strong> · {pct(total ? counts[k] / total : null)}</span></li>))}
      </ul>
    </div>
  );
}

function HourOccupancy({ buckets }: { buckets: Bucket[] }) {
  const theme = useTheme();
  const hours = useMemo(() => {
    const m = new Map<number, { e: number; o: number }>();
    for (const b of buckets) { const x = m.get(b.hour) ?? { e: 0, o: 0 }; x.e += b.enabled; x.o += b.occupied; m.set(b.hour, x); }
    return [...m.entries()].filter(([, x]) => x.e > 0).sort((a, b) => a[0] - b[0]);
  }, [buckets]);
  const label = (h: number) => `${h % 12 || 12} ${h < 12 ? 'a. m.' : 'p. m.'}`;
  const config = useMemo(() => ({
    type: 'bar' as const,
    data: { labels: hours.map(([h]) => label(h)), datasets: [{ label: 'Ocupación', data: hours.map(([, x]) => (x.o / x.e) * 100),
      backgroundColor: cssVar('--c1'), borderRadius: 4, maxBarThickness: 36 }] },
    options: { scales: { y: { beginAtZero: true, max: 100, ticks: { callback: (v: unknown) => `${v} %`, maxTicksLimit: 5 } }, x: { grid: { display: false } } },
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c: { dataIndex: number }) => {
        const x = hours[c.dataIndex]![1]; return `${x.o} de ${x.e} horarios (${pct(x.o / x.e)})`; } } } } },
  }), [hours, theme]); // eslint-disable-line react-hooks/exhaustive-deps
  return <ChartView config={config as never} height={200} label="Porcentaje de horarios ocupados por hora de inicio"
    table={{ caption: 'Ocupación por hora', columns: ['Hora', 'Ocupados', 'Habilitados', 'Ocupación'], rows: hours.map(([h, x]) => [label(h), x.o, x.e, pct(x.o / x.e)]) }} />;
}

// ---------------------------------------------------------------------------
// Mosaico de Inicio: mini calendario, semana en barras apiladas y anillos de cobertura
// ---------------------------------------------------------------------------
const WD = ['L', 'M', 'X', 'J', 'V', 'S', 'D'];
const monthName = (iso: string) => new Intl.DateTimeFormat('es-DO', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${iso}T12:00:00Z`));

/**
 * Mini calendario para elegir el día de la portada. Los días con citas ocupadas llevan un punto (dato real de
 * /stats/timeseries); el día elegido y hoy se distinguen también por texto (aria-current, aria-pressed).
 */
export function MiniCalendar({ date, today, scope, onPick }: { date: string; today: string; scope: Scope; onPick: (d: string) => void }) {
  const [month, setMonth] = useState(date.slice(0, 7));
  const first = `${month}-01`;
  const next = (() => { const [y, m] = month.split('-').map(Number) as [number, number]; return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`; })();
  const prev = (() => { const [y, m] = month.split('-').map(Number) as [number, number]; return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`; })();
  const ts = useApi<Envelope<Day[]>>(`/stats/timeseries${scoped(scope, first, next)}`, { topics: ['appointments'] });
  const busy = new Map((ts.data?.data ?? []).map((x) => [x.date, x.slots_occupied]));
  const lead = (new Date(`${first}T12:00:00Z`).getUTCDay() + 6) % 7;
  const days: string[] = [];
  for (let d = first; d < next; d = addDays(d, 1)) days.push(d);
  return (
    <div className="mini-cal">
      <div className="mini-cal-head">
        <button type="button" className="ghost small" onClick={() => setMonth(prev)} aria-label="Mes anterior">‹</button>
        <strong className="cap">{monthName(first)}</strong>
        <button type="button" className="ghost small" onClick={() => setMonth(next.slice(0, 7))} aria-label="Mes siguiente">›</button>
      </div>
      <div className="mini-cal-grid" role="group" aria-label={`Elegir día de ${monthName(first)}`}>
        {WD.map((w) => <span key={w} className="mini-cal-wd" aria-hidden="true">{w}</span>)}
        {Array.from({ length: lead }, (_, i) => <span key={`b${i}`} />)}
        {days.map((d) => {
          const occ = busy.get(d) ?? 0;
          return (
            <button key={d} type="button" className={`mini-cal-day${d === today ? ' today' : ''}`} aria-pressed={d === date}
              aria-label={`${d.slice(8)} de ${monthName(first)}${d === today ? ', hoy' : ''}${occ ? `, ${occ} citas` : ''}`} onClick={() => onPick(d)}>
              {Number(d.slice(8))}{occ > 0 && <span className="mini-cal-dot" aria-hidden="true" />}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** Próximos 7 días: ocupados y libres en % de los habilitados, con el porcentaje escrito dentro de cada tramo. */
export function WeekCard({ date, scope }: { date: string; scope: Scope }) {
  const ts = useApi<Envelope<Day[]>>(`/stats/timeseries${scoped(scope, date, addDays(date, 7))}`, { topics: ['appointments', 'catalog'] });
  return (
    <section className="card bento-week" aria-labelledby="week-title">
      <div className="card-head"><div><h2 id="week-title">Ocupación de la semana</h2><p className="muted small">7 días desde {shortDate(date)} · % de horarios habilitados</p></div></div>
      <div className="card-body">
        <Async q={ts} empty={(e) => e.data.every((x) => x.slots_enabled === 0)}>{({ data }) => <WeekBars days={data} />}</Async>
      </div>
    </section>
  );
}

const inBarLabels = {
  id: 'inBarLabels',
  afterDatasetsDraw(chart: { ctx: CanvasRenderingContext2D; data: { datasets: { data: unknown[] }[] }; getDatasetMeta: (i: number) => { data: { x: number; y: number; base: number }[] } }) {
    const { ctx } = chart;
    ctx.save();
    ctx.font = '600 11px system-ui, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = '#ffffff';
    chart.data.datasets.forEach((ds, i) => chart.getDatasetMeta(i).data.forEach((bar, j) => {
      const v = Number(ds.data[j]); if (!v || Math.abs(bar.base - bar.y) < 16) return;
      ctx.fillText(`${Math.round(v)}%`, bar.x, (bar.y + bar.base) / 2);
    }));
    ctx.restore();
  },
};

function WeekBars({ days }: { days: Day[] }) {
  const theme = useTheme();
  const rows = days.filter((x) => x.slots_enabled > 0);
  const wd = (iso: string) => new Intl.DateTimeFormat('es-DO', { weekday: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(`${iso}T12:00:00Z`));
  const config = useMemo(() => ({
    type: 'bar' as const,
    data: { labels: rows.map((x) => wd(x.date)), datasets: [
      { label: 'Ocupados', data: rows.map((x) => (x.slots_occupied / x.slots_enabled) * 100), backgroundColor: cssVar('--c1'), stack: 's', borderRadius: 4 },
      { label: 'Libres', data: rows.map((x) => ((x.slots_enabled - x.slots_occupied) / x.slots_enabled) * 100), backgroundColor: cssVar('--c2'), stack: 's', borderRadius: 4 },
    ] },
    options: { scales: { x: { stacked: true, grid: { display: false } }, y: { stacked: true, max: 100, ticks: { callback: (v: unknown) => `${v} %`, maxTicksLimit: 5 } } },
      plugins: { legend: { position: 'bottom' as const, labels: { boxWidth: 12 } }, tooltip: { callbacks: { label: (c: { dataIndex: number; datasetIndex: number }) => {
        const x = rows[c.dataIndex]!; const v = c.datasetIndex === 0 ? x.slots_occupied : x.slots_enabled - x.slots_occupied;
        return `${c.datasetIndex === 0 ? 'Ocupados' : 'Libres'}: ${v} de ${x.slots_enabled} horarios`; } } } } },
    plugins: [inBarLabels],
  }), [days, theme]); // eslint-disable-line react-hooks/exhaustive-deps
  if (rows.length === 0) return <p className="state empty">No hay horarios habilitados esos días.</p>;
  return <ChartView config={config as never} height={230} label="Porcentaje de horarios ocupados y libres en los próximos 7 días"
    table={{ caption: 'Ocupación por día', columns: ['Día', 'Ocupados', 'Libres', 'Habilitados'], rows: rows.map((x) => [wd(x.date), x.slots_occupied, x.slots_enabled - x.slots_occupied, x.slots_enabled]) }} />;
}

/** Dos anillos de cobertura con su denominador: ocupación a 7 días y registro de asistencia a 30 días. */
export function CoverageCard({ date, scope }: { date: string; scope: Scope }) {
  const week = useApi<Envelope<Day[]>>(`/stats/timeseries${scoped(scope, date, addDays(date, 7))}`, { topics: ['appointments', 'catalog'] });
  const sum = useApi<Envelope<Summary>>(`/stats/summary${scoped(scope, addDays(date, -29), addDays(date, 1))}`, { topics: ['appointments'] });
  const w = (week.data?.data ?? []).reduce((a, x) => ({ o: a.o + x.slots_occupied, e: a.e + x.slots_enabled }), { o: 0, e: 0 });
  const at = sum.data?.data.attendance;
  const marked = at ? at.completed + at.no_show : 0;
  const due = at ? marked + at.unmarked : 0;
  return (
    <section className="card bento-coverage" aria-labelledby="cov-title">
      <div className="card-head"><div><h2 id="cov-title">Cobertura</h2></div></div>
      <div className="card-body coverage">
        <BigRing part={w.o} whole={w.e} label="Ocupación" caption={`${n(w.o)} de ${n(w.e)} horarios · 7 días`} tone="c1" loading={week.loading} />
        <BigRing part={marked} whole={due} label="Asistencia registrada" caption={`${n(marked)} de ${n(due)} citas empezadas · 30 días`}
          tone={at && at.unmarked > 0 ? 'c4' : 'c2'} loading={sum.loading} />
      </div>
    </section>
  );
}

function BigRing({ part, whole, label, caption, tone, loading }: { part: number; whole: number; label: string; caption: string; tone: 'c1' | 'c2' | 'c4'; loading: boolean }) {
  const R = 50, C = 2 * Math.PI * R;
  const f = whole > 0 ? part / whole : null;
  return (
    <figure className="big-ring" aria-label={`${label}: ${f === null ? 'sin datos' : pct(f, 0)}. ${caption}`}>
      <span className="big-ring-wrap">
        <svg viewBox="0 0 120 120" aria-hidden="true">
          <circle cx="60" cy="60" r={R} className="big-ring-track" />
          {f !== null && f > 0 && <circle cx="60" cy="60" r={R} fill="none" stroke={`var(--${tone})`} strokeWidth="16"
            strokeDasharray={`${f * C} ${C}`} transform="rotate(-90 60 60)" />}
        </svg>
        <span className="big-ring-value">{loading ? '…' : f === null ? '—' : pct(f, 0)}</span>
      </span>
      <figcaption><strong>{label}</strong><span>{caption}</span></figcaption>
    </figure>
  );
}
