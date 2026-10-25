import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { type Catalog, type DashAppt, type Dashboard, qs } from '../api';
import { DatePicker } from '../components/DatePicker';
import { Async, Badge, Card, Definition, usePaged } from '../components/ui';
import { TZ, addDays, ago, dayLong, fmtDay, fmtDayTime, fmtTime, localDay, n, pct, shortDate } from '../format';
import { useApi } from '../hooks';
import { useLiveTopics } from '../live';
import { Analytics, CoverageCard, MiniCalendar, TrendCard, WeekCard } from './DashAnalytics';

export const STATUS: Record<string, [string, 'ok' | 'warn' | 'bad' | 'info' | 'muted']> = {
  booked: ['Reservada', 'info'], completed: ['Asistió', 'ok'], no_show: ['No asistió', 'warn'], cancelled: ['Cancelada', 'muted'],
};
const KIND: Record<string, [string, 'info' | 'muted' | 'ok' | 'warn']> = {
  booked: ['Reserva', 'info'], cancelled: ['Cancelación', 'muted'], rescheduled: ['Cambio', 'info'],
  advanced: ['Adelanto', 'ok'], completed: ['Asistió', 'ok'], no_show: ['No asistió', 'warn'],
};

/** Navega a una sección con filtros en la URL (p. ej., #/citas?status=booked&from=…). Las fechas «to» de la URL son incluidas. */
export function go(page: string, params: Record<string, string> = {}) {
  const q = new URLSearchParams(Object.fromEntries(Object.entries(params).filter(([, v]) => v))).toString();
  location.hash = `#/${page}${q ? `?${q}` : ''}`;
}

export interface DashFilter { date: string; center_id: string; specialty_id: string; doctor_id: string }
export const defaultDashFilter = (): DashFilter => ({ date: localDay(0), center_id: '', specialty_id: '', doctor_id: '' });

/** Ids recién cambiados (aviso en vivo) para resaltar su fila un momento. */
function useFresh() {
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  useLiveTopics(['appointments'], (_t, events) => {
    const ids = events.map((e) => e.id).filter(Boolean) as string[];
    if (!ids.length) return;
    setFresh(new Set(ids));
    window.setTimeout(() => setFresh(new Set()), 2500);
  });
  return fresh;
}

/** Ámbito de cada bloque: qué filtros obedece (se muestra junto al título). */
const Scope = ({ children }: { children: ReactNode }) => <span className="scope">{children}</span>;
const ids = (f: DashFilter) => ({ specialty_id: f.specialty_id, doctor_id: f.doctor_id });

export function DashboardPage({ canOperate, canAdmin, catalog, filter, onFilter }: { canOperate: boolean; canAdmin: boolean; catalog: Catalog | null; filter: DashFilter; onFilter: (f: DashFilter) => void }) {
  const params = qs({ date: filter.date, center_id: filter.center_id, specialty_id: filter.specialty_id, doctor_id: filter.doctor_id });
  // Avisos en vivo para cada operación (reserva, cancelación, cambio, adelanto, asistencia, ayuda, catálogo). Además se
  // recalcula cada minuto lo que cambia SOLO con el paso del tiempo y no genera eventos: una cita que pasa de
  // «pendiente» a «sin marcar», un horario libre que ya empezó, la próxima cita.
  const q = useApi<Dashboard>(`/admin/dashboard${params}`, { topics: ['appointments', 'handoffs', 'offers', 'catalog'], everyMs: 60_000 });
  const fresh = useFresh();
  // El «ahora» de la agenda avanza aunque no lleguen avisos
  const [, setNow] = useState(0);
  useEffect(() => { const id = window.setInterval(() => setNow((x) => x + 1), 60_000); return () => clearInterval(id); }, []);
  const filtered = Boolean(filter.center_id || filter.specialty_id || filter.doctor_id);
  const isToday = filter.date === localDay(0);
  const dayLabel = isToday ? 'hoy' : fmtDay(`${filter.date}T12:00:00-04:00`);
  // Analítica plegada por defecto (insight, no acción inmediata); se recuerda por navegador
  const [more, setMore] = useState(() => { try { return localStorage.getItem('sc.dash.analytics') === '1'; } catch { return false; } });
  const toggleMore = () => { setMore(!more); try { localStorage.setItem('sc.dash.analytics', more ? '0' : '1'); } catch { /* sin almacenamiento */ } };
  const scope = { center_id: filter.center_id, specialty_id: filter.specialty_id, doctor_id: filter.doctor_id };

  return (
    <div className="stack dash">
      <DashFilters value={filter} onChange={onFilter} catalog={catalog} />
      <Async q={q}>
        {(d) => (
          <>
            <h2 className="section-label">{d.is_today ? 'Hoy' : `Día ${dayLabel}`}</h2>
            <TodayStrip d={d} dayLabel={dayLabel} onOpenDay={canOperate ? () => go('citas', { from: d.date, to: d.date, ...ids(filter) }) : undefined} />

            <div className="bento">
              <Card className="dash-agenda bento-agenda" title={d.is_today ? 'Agenda de hoy' : `Agenda del ${dayLabel}`}
                    actions={<Scope>{filtered ? 'Fecha y filtros' : 'Fecha'}</Scope>}>
                <MiniCalendar date={d.date} today={d.today} scope={scope} onPick={(date) => onFilter({ ...filter, date })} />
                {canOperate ? <Timeline items={d.agenda_today ?? []} fresh={fresh} isToday={d.is_today}
                    onAll={() => go('citas', { from: d.date, to: d.date, ...ids(filter) })} />
                  : <HourBars rows={d.agenda_today_by_hour} />}
              </Card>
              <TrendCard date={d.date} scope={scope} filtered={filtered} />
              <Card className="dash-attention bento-pending" title="Pendientes" actions={<Scope>Todo el hospital</Scope>}>
                <Pending alerts={d.alerts} oldestHandoff={d.handoffs.oldest_at} canOperate={canOperate} canAdmin={canAdmin} />
              </Card>
              <WeekCard date={d.date} scope={scope} />
              <CoverageCard date={d.date} scope={scope} />
            </div>

            <h2 className="section-label">Actividad</h2>
            <Movements d={d} canOperate={canOperate} filtered={filtered} fresh={fresh}
              onAllUpcoming={() => go('citas', { from: localDay(0), to: addDays(localDay(0), 13), status: 'booked', ...ids(filter) })} />

            <button type="button" className="section-toggle" aria-expanded={more} aria-controls="dash-analytics" onClick={toggleMore}>
              <span className="section-label">Analítica <span>· rankings y distribuciones</span></span>
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
            </button>
            <div id="dash-analytics" hidden={!more}>{more && <Analytics date={d.date} scope={scope} availability={d.availability_7d} />}</div>
          </>
        )}
      </Async>
    </div>
  );
}

/** Filtros de la portada: fecha operativa (Hoy · Mañana · fecha) y servicio. Médicos compatibles con centro y especialidad. */
function DashFilters({ value, onChange, catalog }: { value: DashFilter; onChange: (f: DashFilter) => void; catalog: Catalog | null }) {
  const today = localDay(0);
  const doctors = useMemo(() => {
    if (!catalog) return [];
    const ok = new Set(catalog.services.filter((s) => (!value.center_id || s.center_id === value.center_id) && (!value.specialty_id || s.specialty_id === value.specialty_id)).map((s) => s.doctor_id));
    return catalog.doctors.filter((d) => ok.has(d.id));
  }, [catalog, value.center_id, value.specialty_id]);
  useEffect(() => { if (value.doctor_id && catalog && !doctors.some((d) => d.id === value.doctor_id)) onChange({ ...value, doctor_id: '' }); }, [doctors]); // eslint-disable-line react-hooks/exhaustive-deps
  const active = [value.date !== today, value.center_id, value.specialty_id, value.doctor_id].filter(Boolean).length;
  const set = (k: keyof DashFilter) => (e: { target: { value: string } }) => onChange({ ...value, [k]: e.target.value });
  return (
    <form className="toolbar" onSubmit={(e) => e.preventDefault()} aria-label="Fecha y filtros de la portada">
      <div className="segmented" role="group" aria-label="Fecha">
        <button type="button" aria-pressed={value.date === today} onClick={() => onChange({ ...value, date: today })}>Hoy</button>
        <button type="button" aria-pressed={value.date === addDays(today, 1)} onClick={() => onChange({ ...value, date: addDays(today, 1) })}>Mañana</button>
      </div>
      <div className="field compact"><span className="field-label">Fecha</span><DatePicker label="Fecha" value={value.date} onChange={(date) => date && onChange({ ...value, date })} /></div>
      {catalog && catalog.centers.length > 1 && <label className="compact">Centro<select value={value.center_id} onChange={set('center_id')}><option value="">Todos</option>
        {catalog.centers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>}
      <label className="compact">Especialidad<select value={value.specialty_id} onChange={set('specialty_id')}><option value="">Todas</option>
        {catalog?.specialties.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
      <label className="compact">Médico<select value={value.doctor_id} onChange={set('doctor_id')}><option value="">Todos</option>
        {doctors.map((d) => <option key={d.id} value={d.id}>{d.display_name.replace(/ \(fictici[oa]\)/, '')}</option>)}</select></label>
      <p className="toolbar-meta">
        <span className="cap">{dayLong(value.date)}</span> · {TZ.replace('_', ' ')}
        {active > 0 && <> · <span className="badge info">{active} {active === 1 ? 'filtro activo' : 'filtros activos'}</span>
          <button type="button" className="ghost small" onClick={() => onChange(defaultDashFilter())}>Restablecer filtros</button></>}
      </p>
    </form>
  );
}

/**
 * Medidor circular: la cifra va en el centro y el aro representa una proporción REAL con su denominador escrito debajo
 * (nunca un aro decorativo). La variación frente a la semana pasada va junto al aro, con flecha y texto.
 */
function Ring({ value, part, whole, label, caption, tone = 'brand', delta, onOpen }: { value: string; part: number; whole: number; label: string;
  caption: string; tone?: 'brand' | 'warn' | 'info'; delta?: ReactNode; onOpen?: () => void }) {
  const R = 52, C = 2 * Math.PI * R;
  const f = whole > 0 ? Math.min(1, Math.max(0, part / whole)) : 0;
  const body = (
    <>
      <span className="ring-wrap">
        <svg viewBox="0 0 120 120" className={`ring ${tone}`} aria-hidden="true">
          <circle cx="60" cy="60" r={R} className="ring-track" />
          {f > 0 && <circle cx="60" cy="60" r={R} className="ring-arc" strokeDasharray={`${f * C} ${C}`} transform="rotate(-90 60 60)" />}
        </svg>
        <span className="ring-value">{value}</span>
        {delta && <span className="ring-delta">{delta}</span>}
      </span>
      <span className="ring-label">{label}</span>
      <span className="ring-caption">{caption}</span>
    </>
  );
  const aria = `${label}: ${value}. ${caption}`;
  return onOpen
    ? <button type="button" className="metric" onClick={onOpen} aria-label={`${aria}. Abrir en Citas`}>{body}</button>
    : <div className="metric" role="group" aria-label={aria}>{body}</div>;
}

/** Variación compacta junto al aro: ▲/▼ + porcentaje; el texto completo queda en el título y en la línea de comparación. */
function MiniDelta({ now, prev }: { now: number; prev: number }) {
  const diff = now - prev;
  if (diff === 0) return <span className="mini-delta flat">= igual</span>;
  const rel = prev ? `${Math.abs(Math.round((diff / prev) * 100))} %` : `${diff > 0 ? '+' : '−'}${n(Math.abs(diff))}`;
  return <span className={`mini-delta ${diff > 0 ? 'up' : 'down'}`}><span aria-hidden="true">{diff > 0 ? '▲' : '▼'}</span> {rel}</span>;
}

/**
 * Métricas del día: tres medidores (agenda, asistencia registrada, horarios libres) y dos cifras con contexto
 * (próxima cita, reservas registradas). Comparación con el mismo día de la semana anterior.
 */
function TodayStrip({ d, dayLabel, onOpenDay }: { d: Dashboard; dayLabel: string; onOpenDay?: () => void }) {
  const k = d.kpis;
  const vs = fmtDay(`${d.compare.date}T12:00:00-04:00`);
  const started = k.today_completed + k.today_no_show + k.today_unmarked;
  const marked = k.today_completed + k.today_no_show;
  const mins = d.next ? Math.round((Date.parse(d.next.starts_at) - Date.now()) / 60000) : 0;
  const when = !d.next ? '' : mins < 60 ? `en ${Math.max(0, mins)} min` : mins < 1440 ? `en ${Math.round(mins / 60)} h` : fmtDay(d.next.starts_at);
  return (
    <section className="metrics card" aria-label={`Métricas de ${dayLabel}`}>
      <div className="metrics-rings">
        <Ring value={n(k.today_total)} part={k.slots_occupied_today} whole={k.slots_enabled_today} label={d.is_today ? 'Citas de hoy' : `Citas del ${dayLabel}`}
          caption={`${n(k.slots_occupied_today)} de ${n(k.slots_enabled_today)} horarios ocupados · ${vs}: ${n(d.compare.agenda_total)}`}
          delta={<MiniDelta now={k.today_total} prev={d.compare.agenda_total} />} onOpen={onOpenDay} />
        <Ring value={started ? n(marked) : '—'} part={marked} whole={started} tone={k.today_unmarked ? 'warn' : 'brand'} label="Asistencia registrada"
          caption={started ? `de ${n(started)} citas ya empezadas · ${n(k.today_completed)} asistieron${k.today_unmarked ? ` · ${n(k.today_unmarked)} sin marcar` : ''}` : 'Ninguna cita ha empezado'} />
        <Ring value={n(k.slots_free_remaining_today)} part={k.slots_free_remaining_today} whole={k.slots_enabled_today} tone="info"
          label={d.is_today ? 'Horarios libres' : 'Horarios libres'} caption={`de ${n(k.slots_enabled_today)} habilitados${d.is_today ? ' · desde ahora' : ''}`} />
      </div>
      <div className="metrics-figures">
        <div className="figure">
          <span className="figure-value">{d.next ? fmtTime(d.next.starts_at) : '—'}<span className="figure-dot" aria-hidden="true" /></span>
          <span className="figure-label">Próxima cita</span>
          <span className="figure-sub">{d.next ? `${when} · ${d.next.specialty}` : 'Sin citas pendientes'}</span>
        </div>
        <div className="figure">
          <span className="figure-value">{n(k.operations_today.booked)}<span className="figure-dot" aria-hidden="true" />
            <MiniDelta now={k.operations_today.booked} prev={d.compare.booked} /></span>
          <span className="figure-label">Reservas registradas<Definition text={`Operaciones registradas ${d.is_today ? 'hoy' : 'ese día'}, sea cual sea la fecha de la cita. Se compara con ${vs}${d.compare.same_time ? ' hasta esta misma hora' : ''}: ${d.compare.booked} reservas.`} /></span>
          <span className="figure-sub">{n(k.operations_today.cancelled)} cancelaciones · {n(k.operations_today.rescheduled)} cambios · {n(k.operations_today.advanced)} adelantos</span>
        </div>
      </div>
    </section>
  );
}

const PAGE = 5;

/**
 * Pendientes accionables: cada fila es UNA clase de entidad con su cantidad real (no se suman citas con solicitudes
 * ni con trabajos). El botón solo aparece si el rol puede abrir la pantalla de destino.
 */
const PEND: Record<string, [string, string]> = {
  attendance_unmarked: ['citas sin asistencia registrada', 'ya empezaron · últimos 7 días'],
  handoffs_open: ['solicitudes de ayuda abiertas', ''],
  orders_stuck: ['confirmaciones en cola hace más de 1 min', 'n8n podría no estar procesando'],
  jobs_dead: ['trabajos que agotaron sus reintentos', 'revisión técnica'],
  receipts_failed: ['comprobantes PDF sin generar', 'la cita sigue confirmada'],
};
function Pending({ alerts, oldestHandoff, canOperate, canAdmin }: { alerts: Dashboard['alerts']; oldestHandoff: string | null; canOperate: boolean; canAdmin: boolean }) {
  if (alerts.length === 0) return <p className="state empty">No hay nada pendiente.</p>;
  return (
    <ul className="pending">
      {alerts.map((a) => {
        const [label, note] = PEND[a.code] ?? [a.text, ''];
        const sub = a.code === 'handoffs_open' && oldestHandoff ? `la más antigua, ${ago(oldestHandoff)}` : note;
        const can = a.action && (a.action.page.startsWith('sistema') ? canAdmin : canOperate);
        return (
          <li key={a.code} className={`pend ${a.severity}`}>
            <span className="pend-n">{n(a.count)}</span>
            <span className="pend-text"><strong>{label}</strong>{sub && <small>{sub}</small>}</span>
            {can && <button type="button" className="small" onClick={() => go(a.action!.page, a.action!.params)}>{a.action!.label}</button>}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Actividad reciente y próximas citas en una sola tarjeta con pestañas (no compiten por espacio en la portada),
 * paginadas de 5 en 5. La pestaña activa se conserva al llegar avisos en vivo.
 */
function Movements({ d, canOperate, filtered, fresh, onAllUpcoming }: { d: Dashboard; canOperate: boolean; filtered: boolean; fresh: Set<string>; onAllUpcoming: () => void }) {
  const [tab, setTab] = useState<'activity' | 'upcoming'>('activity');
  const upcoming = canOperate ? d.upcoming ?? [] : d.upcoming_by_day;
  const act = usePaged(d.activity, PAGE, 'actividad reciente');
  const up = usePaged<(typeof upcoming)[number]>(upcoming, PAGE, 'próximas citas');
  const tabs = [
    { id: 'activity' as const, label: 'Actividad reciente', count: d.activity.length },
    { id: 'upcoming' as const, label: 'Próximas citas', count: upcoming.length },
  ];
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const next = tab === 'activity' ? 'upcoming' : 'activity';
    setTab(next);
    document.getElementById(`tab-${next}`)?.focus();
  };
  const scope = tab === 'activity' ? (filtered ? 'Filtros · todas las fechas' : 'Todas las fechas') : (filtered ? 'Filtros · desde ahora' : 'Desde ahora');
  return (
    <Card className={`dash-movements ${tab === 'activity' ? 'dash-activity' : 'dash-upcoming'}`} title="Movimientos" actions={<Scope>{scope}</Scope>}>
      <div className="tabs" role="tablist" aria-label="Movimientos" onKeyDown={onKey}>
        {tabs.map((t) => (
          <button key={t.id} id={`tab-${t.id}`} type="button" role="tab" aria-selected={tab === t.id} aria-controls={`panel-${t.id}`}
            tabIndex={tab === t.id ? 0 : -1} onClick={() => setTab(t.id)}>
            {t.label} <span className="tab-count">{n(t.count)}</span>
          </button>))}
      </div>
      <div id={`panel-${tab}`} role="tabpanel" aria-labelledby={`tab-${tab}`}>
        {tab === 'activity' ? (d.activity.length === 0 ? <p className="state empty">No hay operaciones{filtered ? ' para estos filtros' : ''}.</p> : (
          <>
            <ul className="rows">
              {act.shown.map((e, i) => (
                <li key={`${e.occurred_at}-${i}`} className={e.id && fresh.has(e.id) ? 'fresh' : undefined}>
                  <Badge tone={KIND[e.kind]?.[1]}>{KIND[e.kind]?.[0] ?? e.kind}</Badge>
                  <div className="row-main">
                    <strong>{e.patient ?? e.specialty}</strong>{e.reference && <span className="ref">{e.reference}</span>}
                    <div className="row-sub">
                      {e.patient ? `${e.specialty} · ` : ''}{e.doctor.replace(/ \(fictici[oa]\)/, '')}
                      {e.from_at && e.to_at && e.kind !== 'cancelled' ? <> · <s>{fmtDayTime(e.from_at)}</s> → {fmtDayTime(e.to_at)}</>
                        : (e.to_at || e.from_at) ? <> · {fmtDayTime((e.to_at ?? e.from_at)!)}</> : null}
                    </div>
                  </div>
                  <time className="row-time" dateTime={e.occurred_at} title={fmtDayTime(e.occurred_at)}>{ago(e.occurred_at)}</time>
                </li>))}
            </ul>
            {act.pager}
            {d.activity.length >= 30 && <p className="muted small pager-note">Se muestran las 30 operaciones más recientes.</p>}
          </>))
        : upcoming.length === 0 ? <p className="state empty">No hay citas próximas{filtered ? ' para estos filtros' : ''}.</p> : (
          <>
            {canOperate
              ? <ul className="rows">{(up.shown as DashAppt[]).map((a) => (
                  <li key={a.id} className={a.id && fresh.has(a.id) ? 'fresh' : undefined}>
                    <time className="row-when" dateTime={a.starts_at}><span>{fmtDay(a.starts_at)}</span><strong>{fmtTime(a.starts_at)}</strong></time>
                    <div className="row-main"><strong>{a.patient ?? 'Paciente'}</strong><span className="ref">{a.reference}</span>
                      <div className="row-sub">{a.specialty} · {a.doctor.replace(/ \(fictici[oa]\)/, '')}</div></div>
                  </li>))}</ul>
              : <ul className="rows">{(up.shown as Dashboard['upcoming_by_day']).map((x) => (
                  <li key={x.date}><span className="row-when"><strong>{shortDate(x.date)}</strong></span><div className="row-main">{n(x.n)} citas</div></li>))}</ul>}
            {up.pager}
            {canOperate && <button type="button" className="ghost small show-more" onClick={onAllUpcoming}>Ver todas en Citas</button>}
          </>)}
      </div>
    </Card>
  );
}



/** Agenda del día como línea de tiempo; si es hoy, la marca «ahora» separa lo ya ocurrido de lo pendiente. */
function Timeline({ items, fresh, isToday, onAll }: { items: DashAppt[]; fresh: Set<string>; isToday: boolean; onAll: () => void }) {
  if (items.length === 0) return <p className="state empty">No hay citas ese día.</p>;
  const now = Date.now();
  const idx = isToday ? items.findIndex((a) => Date.parse(a.starts_at) > now) : 0;
  const cut = idx === -1 ? items.length : idx;
  // Hasta 6 filas: las 2 últimas ya pasadas y las siguientes; el listado completo, en Citas
  const past = items.slice(0, cut);
  const visible = [...past.slice(-2), ...items.slice(cut)].slice(0, 6);
  const row = (a: DashAppt) => {
    const isPast = Date.parse(a.starts_at) <= now;
    return (
      <li key={a.id} className={`tl-row ${isPast ? 'past' : ''} ${a.id && fresh.has(a.id) ? 'fresh' : ''}`}>
        <time className="tl-time" dateTime={a.starts_at}>{fmtTime(a.starts_at)}</time>
        <span className="tl-dot" aria-hidden="true" />
        <span className="row-main"><strong>{a.patient ?? 'Paciente'}</strong><span className="ref">{a.reference}</span>
          <span className="row-sub">{a.specialty} · {a.doctor.replace(/ \(fictici[oa]\)/, '')}</span></span>
        {a.status === 'booked' && isPast ? <Badge tone="warn">Sin marcar</Badge> : <Badge tone={STATUS[a.status]?.[1]}>{STATUS[a.status]?.[0] ?? a.status}</Badge>}
      </li>
    );
  };
  const shownPast = visible.filter((a) => Date.parse(a.starts_at) <= now);
  const shownNext = visible.filter((a) => Date.parse(a.starts_at) > now);
  return (
    <>
      <ol className="timeline" aria-label="Citas del día en orden de inicio">
        {shownPast.map(row)}
        {isToday && <li className="tl-now"><span>Ahora · {fmtTime(new Date().toISOString())}</span></li>}
        {shownNext.map(row)}
      </ol>
      {items.length > visible.length && <button type="button" className="ghost small show-more" onClick={onAll}>Ver las {items.length} citas del día</button>}
    </>
  );
}

function HourBars({ rows }: { rows: Dashboard['agenda_today_by_hour'] }) {
  if (rows.length === 0) return <p className="state empty">No hay citas ese día.</p>;
  const max = Math.max(...rows.map((r) => r.total));
  return (
    <table className="data compact hourbars">
      <caption className="sr-only">Citas por hora (sin datos de pacientes)</caption>
      <thead><tr><th scope="col">Hora</th><th scope="col">Citas</th><th className="num" scope="col">Pend.</th><th className="num" scope="col">Asist.</th><th className="num" scope="col">No asist.</th></tr></thead>
      <tbody>{rows.map((r) => (
        <tr key={r.hour}><th scope="row" className="mono">{r.hour}</th>
          <td><span className="meter wide"><span style={{ width: `${(r.total / max) * 100}%` }} /></span> {n(r.total)}</td>
          <td className="num">{n(r.pending)}</td><td className="num">{n(r.completed)}</td><td className="num">{n(r.no_show)}</td></tr>))}</tbody>
    </table>
  );
}


