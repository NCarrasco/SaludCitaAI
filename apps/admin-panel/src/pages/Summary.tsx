import { useMemo, useState } from 'react';
import { type Day, type Envelope, type Summary, qs } from '../api';
import { ChartView, cssVar, useTheme } from '../components/Chart';
import { type StatsFilter, filterQuery, filterValid } from '../components/Filters';
import { Async, Card, Definition, Kpi, Updated } from '../components/ui';
import { addDays, n, pct, shortDate } from '../format';
import { useApi } from '../hooks';
import { go } from './Dashboard';

const LIVE = { topics: ['appointments', 'offers', 'catalog'] as const };

export function SummaryPage({ filter, canOperate }: { filter: StatsFilter; canOperate: boolean }) {
  const valid = filterValid(filter);
  const query = qs(filterQuery(filter));
  const sum = useApi<Envelope<Summary>>(valid ? `/stats/summary${query}` : null, { topics: [...LIVE.topics] });
  const ts = useApi<Envelope<Day[]>>(valid ? `/stats/timeseries${query}` : null, { topics: [...LIVE.topics] });
  const until = addDays(filter.to, -1);
  const [more, setMore] = useState(false);
  const open = canOperate ? (params: Record<string, string>) => () => go('citas', { from: filter.from, to: until, ...params }) : undefined;

  return (
    <div className="stack">
      <Card title="Indicadores del periodo" actions={<><Definition text="Operaciones por fecha en que se registraron; agenda, ocupación y asistencia por fecha de la cita." /><Updated q={sum} /></>}>
        <Async q={sum}>
          {({ data: d, definitions: def }) => (
            <div className="kpi-groups">
            <section aria-labelledby="g-ops"><h3 id="g-ops" className="group-title">Operaciones registradas</h3>
            <div className="kpis cols-4">
              <Kpi label="Reservas registradas" value={n(d.operations.bookings)} definition={def.operations} />
              <Kpi label="Cancelaciones" value={n(d.operations.cancellations)} definition={def.operations} onOpen={open?.({ status: 'cancelled' })} />
              <Kpi label="Reprogramaciones" value={n(d.operations.reschedules)} definition={def.operations} />
              <Kpi label="Adelantos aceptados" value={n(d.operations.advances)} definition={def.operations} />
            </div></section>
            <section aria-labelledby="g-agenda"><h3 id="g-agenda" className="group-title">Agenda y demanda</h3>
            <div className="kpis cols-3">
              <Kpi label="Ocupación de la agenda" value={pct(d.occupancy.rate)}
                   detail={<>{n(d.occupancy.occupied)} de {n(d.occupancy.enabled)} horarios habilitados
                     {d.occupancy.held_by_offer > 0 && <> · {n(d.occupancy.held_by_offer)} reservados para una oferta</>}
                     {d.occupancy.blocked > 0 && <> · {n(d.occupancy.blocked)} bloqueados</>}</>}
                   definition={def.occupancy} />
              <AttendanceKpi a={d.attendance} definition={def.attendance} onOpen={d.attendance.unmarked > 0 ? open?.({ status: 'booked' }) : undefined} />
              <Kpi label="Búsquedas de disponibilidad" value={n(d.searches)} definition={`${def.searches} ${def.filters}`} />
            </div></section>
            </div>
          )}
        </Async>
      </Card>

      <Card title="Evolución diaria" subtitle="Por fecha de registro">
        <Async q={ts} empty={(e) => e.data.every((x) => x.bookings + x.cancellations + x.reschedules + x.advances + x.searches === 0)}>
          {({ data }) => <ActivityChart days={data} />}
        </Async>
      </Card>

      {/* Gráficos secundarios bajo demanda: la página no empieza con todos a la vez */}
      {!more ? <button type="button" className="show-more-block" onClick={() => setMore(true)}>Ver más gráficos · ocupación diaria y estado de las citas</button> : <>
      <div className="grid-2">
        <Card title="Ocupación diaria" subtitle="Horarios ocupados sobre habilitados, por día de la cita">
          <Async q={ts} empty={(e) => e.data.every((x) => x.slots_enabled === 0)}>
            {({ data }) => <OccupancyChart days={data} />}
          </Async>
        </Card>
      </div>
      <Card title="Estado de las citas del periodo" subtitle="Por fecha de la cita" actions={<Definition text="Estado actual de las citas cuyo horario cae en el periodo. «Asistió» lo marca el personal; una reserva no acredita asistencia." />}>
        <Async q={sum} empty={(e) => Object.values(e.data.agenda_by_status).every((v) => v === 0)}>
          {({ data: d }) => <OutcomeChart s={d} />}
        </Async>
      </Card>
      </>}
    </div>
  );
}

/**
 * Asistencia con su cobertura de registro: un 100 % calculado sobre 1 cita marcada de 12 no es un buen resultado, es un
 * registro incompleto. La tasa se muestra solo junto a su denominador y, si falta registro, se dice explícitamente.
 */
function AttendanceKpi({ a, definition, onOpen }: { a: Summary["attendance"]; definition?: string; onOpen?: () => void }) {
  const marked = a.completed + a.no_show;
  const due = marked + a.unmarked;
  const coverage = due ? marked / due : null;
  const incomplete = a.unmarked > 0;
  return (
    <Kpi label="Asistencia registrada" value={due === 0 ? '—' : pct(a.rate)} tone={incomplete ? 'warn' : undefined} definition={definition} onOpen={onOpen}
      detail={due === 0 ? 'Ninguna cita del periodo ha empezado todavía' : <>
        {incomplete && <strong className="kpi-flag">Registro incompleto · </strong>}
        Cobertura {pct(coverage)}: {n(marked)} de {n(due)} citas ya empezadas tienen asistencia registrada
        <br />{n(a.completed)} asistieron · {n(a.no_show)} no asistieron · {n(a.unmarked)} sin marcar</>} />
  );
}

/** Operaciones y búsquedas tienen escalas distintas: se alternan en lugar de mezclarse en el mismo eje. */
function ActivityChart({ days }: { days: Day[] }) {
  const [view, setView] = useState<'ops' | 'searches'>('ops');
  const theme = useTheme();
  const labels = days.map((x) => shortDate(x.date));
  const config = useMemo(() => (view === 'ops' ? {
    type: 'bar' as const,
    data: { labels, datasets: [
      { label: 'Reservas', data: days.map((x) => x.bookings), backgroundColor: cssVar('--c1') },
      { label: 'Cancelaciones', data: days.map((x) => x.cancellations), backgroundColor: cssVar('--c3') },
      { label: 'Reprogramaciones', data: days.map((x) => x.reschedules), backgroundColor: cssVar('--c2') },
      { label: 'Adelantos', data: days.map((x) => x.advances), backgroundColor: cssVar('--c4') },
    ] },
    // Barras agrupadas (no apiladas): cada tipo se lee contra el eje sin sumar operaciones de distinta naturaleza
    options: { scales: { x: { ticks: { maxRotation: 0, autoSkipPadding: 12 } }, y: { beginAtZero: true, ticks: { precision: 0 } } },
               plugins: { legend: { position: 'bottom' as const } } },
  } : {
    type: 'line' as const,
    data: { labels, datasets: [{ label: 'Búsquedas', data: days.map((x) => x.searches), borderColor: cssVar('--c2'), backgroundColor: cssVar('--c2'), pointRadius: 2, tension: 0.2 }] },
    options: { scales: { x: { ticks: { maxRotation: 0, autoSkipPadding: 12 } }, y: { beginAtZero: true, ticks: { precision: 0 } } }, plugins: { legend: { display: false } } },
  }), [days, view, theme]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <>
      <div className="segmented" role="group" aria-label="Qué mostrar">
        <button type="button" aria-pressed={view === 'ops'} onClick={() => setView('ops')}>Operaciones</button>
        <button type="button" aria-pressed={view === 'searches'} onClick={() => setView('searches')}>Búsquedas</button>
      </div>
      <ChartView config={config as never} label={view === 'ops' ? 'Operaciones por día' : 'Búsquedas de disponibilidad por día'}
        table={view === 'ops'
          ? { caption: 'Operaciones por día', columns: ['Día', 'Reservas', 'Cancelaciones', 'Reprogramaciones', 'Adelantos'],
              rows: days.map((x) => [shortDate(x.date), x.bookings, x.cancellations, x.reschedules, x.advances]) }
          : { caption: 'Búsquedas por día', columns: ['Día', 'Búsquedas'], rows: days.map((x) => [shortDate(x.date), x.searches]) }} />
    </>
  );
}

function OccupancyChart({ days }: { days: Day[] }) {
  const theme = useTheme();
  const config = useMemo(() => ({
    type: 'line' as const,
    data: {
      labels: days.map((x) => shortDate(x.date)),
      datasets: [{ label: 'Ocupación', data: days.map((x) => (x.occupancy_rate === null ? null : x.occupancy_rate * 100)),
        borderColor: cssVar('--c1'), backgroundColor: cssVar('--c1-soft'), fill: true, spanGaps: false, pointRadius: 2, tension: 0.2 }],
    },
    options: {
      scales: { y: { beginAtZero: true, max: 100, ticks: { callback: (v: unknown) => `${v} %` } }, x: { ticks: { maxRotation: 0, autoSkipPadding: 12 } } },
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c: { dataIndex: number }) => {
        const d = days[c.dataIndex]!;
        return d.slots_enabled ? `${d.slots_occupied} de ${d.slots_enabled} horarios (${pct(d.occupancy_rate)})` : 'Sin horarios habilitados';
      } } } },
    },
  }), [days, theme]); // eslint-disable-line react-hooks/exhaustive-deps
  return <ChartView config={config as never} label="Ocupación diaria en porcentaje"
    table={{ caption: 'Ocupación por día', columns: ['Día', 'Ocupados', 'Habilitados', 'Ocupación'],
      rows: days.map((x) => [shortDate(x.date), x.slots_occupied, x.slots_enabled, pct(x.occupancy_rate)]) }} />;
}

function OutcomeChart({ s }: { s: Summary }) {
  const theme = useTheme();
  const rows = [
    ['Reservadas (pendientes o sin marcar)', s.agenda_by_status.booked, '--c1'], ['Asistió', s.agenda_by_status.completed, '--c2'],
    ['No asistió', s.agenda_by_status.no_show, '--c4'], ['Canceladas', s.agenda_by_status.cancelled, '--c3'],
  ] as const;
  const total = rows.reduce((a, r) => a + r[1], 0);
  const config = useMemo(() => ({
    type: 'bar' as const,
    data: { labels: rows.map((r) => r[0]), datasets: [{ data: rows.map((r) => r[1]), backgroundColor: rows.map((r) => cssVar(r[2])) }] },
    options: { indexAxis: 'y' as const, plugins: { legend: { display: false } }, scales: { x: { beginAtZero: true, ticks: { precision: 0 } } } },
  }), [s, theme]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="outcome">
      <ChartView config={config as never} label="Citas del periodo por estado" height={200} tableVisibleNearby
        table={{ caption: 'Citas por estado', columns: ['Estado', 'Citas', '%'], rows: rows.map((r) => [r[0], r[1], pct(total ? r[1] / total : null)]) }} />
      <table className="mini">
        <thead><tr><th>Estado</th><th className="num">Citas</th><th className="num">%</th></tr></thead>
        <tbody>{rows.map((r) => <tr key={r[0]}><td>{r[0]}</td><td className="num">{n(r[1])}</td><td className="num">{pct(total ? r[1] / total : null)}</td></tr>)}</tbody>
        <tfoot><tr><td>Total</td><td className="num">{n(total)}</td><td /></tr></tfoot>
      </table>
    </div>
  );
}
