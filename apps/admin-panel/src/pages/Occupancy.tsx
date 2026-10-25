import { useMemo } from 'react';
import { type Bucket, type Envelope, type Group, qs } from '../api';
import { ChartView, cssVar, useTheme } from '../components/Chart';
import { type StatsFilter, filterQuery, filterValid } from '../components/Filters';
import { Async, Card, Definition, Updated } from '../components/ui';
import { WEEKDAYS, n, pct } from '../format';
import { useApi } from '../hooks';

const TOPICS = { topics: ['appointments', 'offers', 'catalog'] as ('appointments' | 'offers' | 'catalog')[] };

export function OccupancyPage({ filter }: { filter: StatsFilter }) {
  const valid = filterValid(filter);
  const query = qs(filterQuery(filter));
  const heat = useApi<Envelope<Bucket[]>>(valid ? `/stats/occupancy${query}` : null, TOPICS);
  const docs = useApi<Envelope<Group[]>>(valid ? `/stats/doctors${query}` : null, TOPICS);
  const specs = useApi<Envelope<Group[]>>(valid ? `/stats/specialties${query}` : null, TOPICS);
  return (
    <div className="stack">
      <Card title="Ocupación por día y hora" subtitle="% ocupado y horarios libres por franja (hora local de inicio)"
            actions={<><Definition text="Ocupación = horarios con cita sobre horarios habilitados. No es asistencia ni mide la calidad de un médico: depende de su agenda y de la demanda." /><Updated q={heat} /></>}>
        <Async q={heat} empty={(e) => e.data.length === 0}>{({ data }) => <Heatmap buckets={data} />}</Async>
      </Card>
      <div className="grid-2">
        <Card title="Por especialidad"><Async q={specs} empty={(e) => e.data.length === 0}>{({ data }) => <GroupView rows={data} what="especialidad" />}</Async></Card>
        <Card title="Por médico"><Async q={docs} empty={(e) => e.data.length === 0}>{({ data }) => <GroupView rows={data} what="médico" />}</Async></Card>
      </div>
    </div>
  );
}

function Heatmap({ buckets }: { buckets: Bucket[] }) {
  const hours = [...new Set(buckets.map((b) => b.hour))].sort((a, b) => a - b);
  const days = [...new Set(buckets.map((b) => b.weekday))].sort((a, b) => a - b);
  const at = (d: number, h: number) => buckets.find((b) => b.weekday === d && b.hour === h);
  return (
    <div className="table-scroll" tabIndex={0} role="region" aria-label="Mapa de ocupación (desplazable)">
      <table className="heatmap">
        <caption className="sr-only">Porcentaje de ocupación y horarios libres por día de la semana y hora</caption>
        <thead><tr><th scope="col">Hora</th>{days.map((d) => <th scope="col" key={d}>{WEEKDAYS[d - 1]}</th>)}</tr></thead>
        <tbody>
          {hours.map((h) => (
            <tr key={h}>
              <th scope="row">{String(h).padStart(2, '0')}:00</th>
              {days.map((d) => {
                const b = at(d, h);
                if (!b || b.enabled === 0) return <td key={d} className="cell empty">—</td>;
                const level = Math.min(5, Math.ceil((b.rate ?? 0) * 5));
                const free = b.enabled - b.occupied;
                return (
                  <td key={d} className={`cell l${level}`}>
                    {pct(b.rate, 0)}<small>{free === 0 ? 'completo' : `${free} libre${free === 1 ? '' : 's'}`} · {b.occupied}/{b.enabled}</small>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function GroupView({ rows, what }: { rows: Group[]; what: string }) {
  const theme = useTheme();
  const sorted = [...rows].sort((a, b) => (b.occupancy_rate ?? -1) - (a.occupancy_rate ?? -1));
  const config = useMemo(() => ({
    type: 'bar' as const,
    data: { labels: sorted.map((r) => r.name), datasets: [
      { label: 'Ocupados', data: sorted.map((r) => r.slots_occupied), backgroundColor: cssVar('--c1'), stack: 'h' },
      { label: 'Libres', data: sorted.map((r) => Math.max(0, r.slots_enabled - r.slots_occupied)), backgroundColor: cssVar('--line-strong'), stack: 'h' },
    ] },
    // Apilado con sentido: ocupados + libres = habilitados de esa fila
    options: { indexAxis: 'y' as const, scales: { x: { stacked: true, beginAtZero: true, ticks: { precision: 0 } }, y: { stacked: true } },
               plugins: { legend: { position: 'bottom' as const } } },
  }), [rows, theme]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <>
      <ChartView config={config as never} label={`Horarios ocupados y libres por ${what}`} height={Math.max(140, sorted.length * 44 + 60)}
        table={{ caption: `Indicadores por ${what}`, columns: [what[0]!.toUpperCase() + what.slice(1), 'Ocupación', 'Ocupados', 'Habilitados', 'Reservas', 'Cancelaciones', 'Asistencia'],
          rows: sorted.map((r) => [r.name, pct(r.occupancy_rate), r.slots_occupied, r.slots_enabled, r.bookings, r.cancellations,
            r.completed + r.no_show ? `${pct(r.attendance_rate)} (${r.completed}/${r.completed + r.no_show})` : '—']) }} />
    </>
  );
}

export function GroupTable({ rows }: { rows: Group[] }) {
  return (
    <div className="table-scroll">
      <table className="data">
        <thead><tr><th>Nombre</th><th className="num">Reservas</th><th className="num">Cancel.</th><th className="num">Reprog.</th>
          <th className="num">Ocupación</th><th className="num">Asistencia</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td>{r.name}</td><td className="num">{n(r.bookings)}</td><td className="num">{n(r.cancellations)}</td><td className="num">{n(r.reschedules)}</td>
              <td className="num">{pct(r.occupancy_rate)} <small className="muted">{n(r.slots_occupied)}/{n(r.slots_enabled)}</small></td>
              <td className="num">{pct(r.attendance_rate)} <small className="muted">{n(r.completed)}/{n(r.completed + r.no_show)}</small></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
