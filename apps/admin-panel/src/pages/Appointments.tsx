import { useEffect, useRef, useState } from 'react';
import { ApiError, type Catalog, api, qs } from '../api';
import { DatePicker } from '../components/DatePicker';
import { Async, Badge, Card, Modal, Notice, Updated } from '../components/ui';
import { TZ, addDays, fmtDay, fmtDayTime, fmtTime, localDay, n, rangeLabel, weekStart } from '../format';
import { useApi, useDebounced } from '../hooks';
import { useLiveTopics } from '../live';

interface Row { id: string; booking_reference: string; status: string; version: number; starts_at: string; label: string;
  patient: { id: string; full_name: string | null }; doctor: string; specialty: string; center: string; source_channel: string; attendance_allowed: boolean }

const STATUS: Record<string, [string, 'ok' | 'warn' | 'bad' | 'info' | 'muted']> = {
  booked: ['Reservada', 'info'], completed: ['Asistió', 'ok'], no_show: ['No asistió', 'warn'], cancelled: ['Cancelada', 'muted'],
};
const PAGE = 25;

/** Filtros de la URL (#/citas?status=…&from=…&to=…): «to» es la fecha incluida, como se muestra en pantalla. */
// Estado por defecto: «activas» (no canceladas). Las canceladas se ven eligiéndolas; «all» = todas.
const DEFAULTS = () => ({ from: localDay(0), to: localDay(13), status: 'active', doctor_id: '', specialty_id: '', q: '' });
const STATUS_OPTIONS: [string, string][] = [['active', 'Activas'], ['booked', 'Reservadas'], ['completed', 'Asistió'], ['no_show', 'No asistió'],
  ['cancelled', 'Canceladas'], ['all', 'Todas']];
const PRESETS = (): [string, string, string][] => {
  const t = localDay(0); const w = weekStart(t);
  return [['Hoy', t, t], ['Esta semana', w, addDays(w, 6)], ['Próximos 14 días', t, addDays(t, 13)], ['Últimos 30 días', addDays(t, -29), t]];
};
const fromParams = (p: URLSearchParams) => {
  const d = DEFAULTS();
  return { ...d, ...Object.fromEntries([...p.entries()].filter(([k]) => k in d)) } as ReturnType<typeof DEFAULTS>;
};

export function AppointmentsPage({ catalog, params }: { catalog: Catalog | null; params: URLSearchParams }) {
  const [f, setF] = useState(() => fromParams(params));
  const [offset, setOffset] = useState(0);
  const [pending, setPending] = useState<{ row: Row; status: 'completed' | 'no_show'; key: string; changed?: boolean } | null>(null);
  const [message, setMessage] = useState<{ tone: 'info' | 'warn'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  // Detalle abierto: también desde un enlace profundo #/citas?cita=<id>
  const [detail, setDetail] = useState<string | null>(params.get('cita'));
  const q = useDebounced(f.q.trim());
  const validRange = f.from <= f.to;
  const valid = validRange && (q.length === 0 || q.length >= 2);
  // La API usa «to» exclusivo: se suma un día a la fecha incluida que ve el usuario
  const list = useApi<{ total: number; counts: Record<string, number>; items: Row[] }>(
    valid ? `/admin/appointments${qs({ ...f, q, status: f.status === 'all' ? '' : f.status, to: addDays(f.to, 1), limit: PAGE, offset })}` : null, { topics: ['appointments'] });
  // Contadores por estado: se conservan los últimos mientras carga la consulta nueva (sin parpadeo)
  const lastCounts = useRef<Record<string, number> | null>(null);
  if (list.data) lastCounts.current = list.data.counts;
  const counts = lastCounts.current;
  const countOf = (k: string) => !counts ? null : k === 'active' ? counts.booked! + counts.completed! + counts.no_show!
    : k === 'all' ? Object.values(counts).reduce((a, b) => a + b, 0) : counts[k] ?? 0;
  // Panel de filtros plegable (escritorio: empuja la tabla; móvil: cajón sobre la página). Se recuerda por navegador.
  const [drawer, setDrawerState] = useState(() => { try { return localStorage.getItem('sc.citas.filters') === '1'; } catch { return false; } });
  const setDrawer = (v: boolean) => { setDrawerState(v); try { localStorage.setItem('sc.citas.filters', v ? '1' : '0'); } catch { /* sin almacenamiento */ } };
  const isMobile = () => window.matchMedia('(max-width: 980px)').matches;
  const drawerClose = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!drawer || !isMobile()) return undefined;
    drawerClose.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setDrawer(false); };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [drawer]);
  const patch = (x: Partial<typeof f>) => { setOffset(0); setF({ ...f, ...x }); };
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => { setOffset(0); setF({ ...f, [k]: e.target.value }); };
  // Si la cita que se está revisando cambia en otra parte, se avisa y se revalida su versión antes de guardar
  useLiveTopics(['appointments'], (_t, events) => {
    if (pending && events.some((e) => e.id === pending.row.id)) setPending({ ...pending, changed: true });
  });
  const latest = pending && list.data?.items.find((r) => r.id === pending.row.id);
  const d0 = DEFAULTS();
  const activeCount = (f.from !== d0.from || f.to !== d0.to ? 1 : 0) + (f.status !== d0.status ? 1 : 0) + [f.doctor_id, f.specialty_id].filter(Boolean).length;
  const reset = () => { setOffset(0); setF({ ...DEFAULTS(), q: f.q }); history.replaceState(null, '', '#/citas'); };
  const doctors = catalog?.doctors.filter((d) => !f.specialty_id || catalog.services.some((x) => x.doctor_id === d.id && x.specialty_id === f.specialty_id)) ?? [];
  const spName = catalog?.specialties.find((x) => x.id === f.specialty_id)?.name;
  const docName = catalog?.doctors.find((x) => x.id === f.doctor_id)?.display_name.replace(/ \(fictici[oa]\)/, '');
  const preset = PRESETS().find(([, a, b]) => a === f.from && b === f.to)?.[0];
  // Etiquetas de los filtros activos: cada una se quita con un toque
  const chips: [string, () => void][] = [
    ...(f.status !== d0.status ? [[STATUS_OPTIONS.find(([k]) => k === f.status)?.[1] ?? f.status, () => patch({ status: d0.status })] as [string, () => void]] : []),
    ...(f.from !== d0.from || f.to !== d0.to ? [[preset ?? rangeLabel(f.from, f.to), () => patch({ from: d0.from, to: d0.to })] as [string, () => void]] : []),
    ...(spName ? [[spName, () => patch({ specialty_id: '', doctor_id: '' })] as [string, () => void]] : []),
    ...(docName ? [[docName, () => patch({ doctor_id: '' })] as [string, () => void]] : []),
  ];

  async function mark() {
    if (!pending) return;
    setBusy(true);
    try {
      const version = latest?.version ?? pending.row.version;
      await api(`/appointments/${pending.row.id}/attendance`, { method: 'POST', idempotencyKey: pending.key,
        body: { status: pending.status, expected_version: version } });
      setMessage({ tone: 'info', text: `Registrado: ${pending.row.booking_reference} · ${pending.status === 'completed' ? 'asistió' : 'no asistió'}.` });
      list.reload();
    } catch (e) {
      setMessage({ tone: 'warn', text: `No se registró: ${(e as ApiError).message}` });
    } finally {
      setBusy(false);
      setPending(null);
    }
  }

  return (
    <div className={`appts ${drawer ? 'drawer-open' : ''}`}>
      <div className="filter-backdrop" onClick={() => setDrawer(false)} aria-hidden="true" />
      <aside className="filter-side" aria-label="Filtros de citas" id="filtros-citas">
        <div className="fs-head">
          <h2>Filtros{activeCount > 0 && <span className="badge info">{activeCount}</span>}</h2>
          {activeCount > 0 && <button type="button" className="ghost small" onClick={reset}>Restablecer</button>}
          <button type="button" ref={drawerClose} className="ghost small fs-close" onClick={() => setDrawer(false)} aria-label="Cerrar filtros">✕</button>
        </div>
        <fieldset className="fs-group">
          <legend>Estado</legend>
          {STATUS_OPTIONS.map(([k, l]) => (
            <label key={k} className={`fs-option ${f.status === k ? 'on' : ''}`}>
              <input type="radio" name="estado" value={k} checked={f.status === k} onChange={() => patch({ status: k })} />
              <span>{l}{k === 'active' && <small> · sin canceladas</small>}</span>
              <span className="fs-count">{countOf(k) === null ? '' : n(countOf(k))}</span>
            </label>))}
        </fieldset>
        <fieldset className="fs-group">
          <legend>Periodo</legend>
          <div className="fs-presets">
            {PRESETS().map(([l, a, b]) => <button key={l} type="button" aria-pressed={f.from === a && f.to === b} onClick={() => patch({ from: a, to: b })}>{l}</button>)}
          </div>
          <div className="field"><span className="field-label">Desde</span><DatePicker label="Desde" value={f.from} onChange={(from) => from && patch({ from })} /></div>
          <div className="field"><span className="field-label">Hasta (incluido)</span><DatePicker label="Hasta (incluido)" value={f.to} invalid={!validRange} onChange={(to) => to && patch({ to })} /></div>
          {!validRange && <p className="field-error" role="alert">«Desde» debe ser anterior o igual a «Hasta».</p>}
        </fieldset>
        <fieldset className="fs-group">
          <legend>Servicio</legend>
          <label>Especialidad
            <select value={f.specialty_id} onChange={(e) => { const sp = e.target.value;
              const keep = !f.doctor_id || !sp || catalog?.services.some((x) => x.doctor_id === f.doctor_id && x.specialty_id === sp);
              patch({ specialty_id: sp, doctor_id: keep ? f.doctor_id : '' }); }}><option value="">Todas</option>
              {catalog?.specialties.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select>
          </label>
          <label>Médico
            <select value={f.doctor_id} onChange={set('doctor_id')}><option value="">Todos</option>
              {doctors.map((d) => <option key={d.id} value={d.id}>{d.display_name.replace(/ \(fictici[oa]\)/, '')}</option>)}</select>
          </label>
        </fieldset>
        <button type="button" className="primary fs-apply" onClick={() => setDrawer(false)}>
          Ver {list.data ? n(list.data.total) : ''} {list.data?.total === 1 ? 'cita' : 'citas'}</button>
      </aside>

      <div className="appts-main">
      <Card>
        <div className="results-head">
          <button type="button" className="filters-toggle" aria-expanded={drawer} aria-controls="filtros-citas" onClick={() => setDrawer(true)}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M7 12h10M10 18h4" /></svg>{drawer ? 'Ocultar filtros' : 'Mostrar filtros'}{activeCount > 0 && <span className="badge info">{activeCount}</span>}
          </button>
          <label className="results-search"><span className="sr-only">Buscar</span>
            <span className="input-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5" /><path d="M16 16l4 4" /></svg>
              <input type="search" placeholder="Buscar por referencia SC-… o nombre" value={f.q} onChange={set('q')} aria-label="Buscar por referencia o nombre" /></span>
          </label>
          <Updated q={list} />
        </div>
        <div className="results-summary">
          <p><strong>{list.data && valid ? n(list.data.total) : '…'}</strong> {list.data?.total === 1 ? 'cita' : 'citas'} · {validRange ? rangeLabel(f.from, f.to) : 'rango no válido'}
            <span className="muted"> · zona {TZ.replace('_', ' ')}</span>
            {f.q.trim().length === 1 && <span className="muted"> · escribe al menos 2 caracteres para buscar</span>}</p>
          {chips.length > 0 && <ul className="chips" aria-label="Filtros activos">
            {chips.map(([l, rm]) => <li key={l}><button type="button" className="chip" onClick={rm} aria-label={`Quitar filtro ${l}`}>{l}<span aria-hidden="true">×</span></button></li>)}
            <li><button type="button" className="ghost small" onClick={reset}>Restablecer filtros</button></li>
          </ul>}
        </div>
        {message && <Notice tone={message.tone}>{message.text}</Notice>}
        <Async q={list} empty={(d) => d.items.length === 0}>
          {(d) => (
            <>
              <div className="table-scroll">
                <table className="data">
                  <thead><tr><th>Fecha y hora</th><th>Paciente</th><th>Especialidad · médico</th><th>Estado</th><th>Asistencia</th><th><span className="sr-only">Detalle</span></th></tr></thead>
                  <tbody>
                    {d.items.map((r) => (
                      <tr key={r.id}>
                        <td className="nowrap"><span className="muted small">{fmtDay(r.starts_at)}</span><br /><strong>{fmtTime(r.starts_at)}</strong></td>
                        <td>{r.patient.full_name ?? '—'}<br /><span className="ref ref-block">{r.booking_reference}</span></td>
                        <td>{r.specialty}<br /><small className="muted">{r.doctor.replace(/ \(fictici[oa]\)/, '')}</small></td>
                        <td><Badge tone={STATUS[r.status]?.[1]}>{STATUS[r.status]?.[0] ?? r.status}</Badge></td>
                        <td>
                          {r.attendance_allowed ? (
                            <div className="row-actions">
                              <button type="button" className="small" onClick={() => setPending({ row: r, status: 'completed', key: crypto.randomUUID() })}>Asistió</button>
                              <button type="button" className="small" onClick={() => setPending({ row: r, status: 'no_show', key: crypto.randomUUID() })}>No asistió</button>
                            </div>
                          ) : <small className="muted">{r.status === 'booked' ? 'Aún no comienza' : '—'}</small>}
                        </td>
                        <td><button type="button" className="small ghost" onClick={() => setDetail(r.id)} aria-label={`Ver detalle e historial de ${r.booking_reference}`}>Detalle</button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <nav className="pager" aria-label="Paginación">
                <span>{n(offset + 1)}–{n(Math.min(offset + PAGE, d.total))} de {n(d.total)}</span>
                <button type="button" className="small" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>Anterior</button>
                <button type="button" className="small" disabled={offset + PAGE >= d.total} onClick={() => setOffset(offset + PAGE)}>Siguiente</button>
              </nav>
            </>
          )}
        </Async>
      </Card>
      </div>
      {detail && !pending && <Detail id={detail} onClose={() => setDetail(null)}
        onMark={(row, status) => setPending({ row, status, key: crypto.randomUUID() })} />}
      {pending && (
        <Modal title="Registrar asistencia" onClose={() => setPending(null)}
               footer={<><button type="button" onClick={() => setPending(null)}>Volver</button>
                 <button type="button" className="primary" disabled={busy} onClick={mark}>{busy ? 'Guardando…' : 'Confirmar'}</button></>}>
          {pending.changed && <Notice tone="warn">Esta cita cambió mientras la revisabas{latest ? ` (ahora: ${STATUS[latest.status]?.[0] ?? latest.status}, ${latest.label})` : ''}. Revisa los datos: se guardará con su versión actual.</Notice>}
          <p>Cita <strong>{pending.row.booking_reference}</strong> · {(latest ?? pending.row).label}<br />{pending.row.patient.full_name} · {pending.row.doctor}</p>
          <p>Se registrará como <strong>{pending.status === 'completed' ? 'asistió' : 'no asistió'}</strong>. Esta acción queda en el historial de la cita.</p>
        </Modal>
      )}
    </div>
  );
}

interface DetailData extends Row { advance_opt_in: boolean; created_at: string; contact: { phone: string | null; email: string | null };
  events: { type: string; occurred_at: string; status_before: string | null; status_after: string; from_starts_at: string | null; to_starts_at: string | null; actor_type: string; reason_code: string | null }[] }
const EVENT: Record<string, string> = { booked: 'Reservada', cancelled: 'Cancelada', rescheduled: 'Cambio de horario', advanced: 'Adelanto aceptado', completed: 'Asistió', no_show: 'No asistió' };
const ACTOR: Record<string, string> = { patient: 'paciente', operator: 'personal', system: 'sistema', service: 'n8n' };
const CHANNEL: Record<string, string> = { gradio: 'Chat del paciente', api: 'API', operator: 'Personal', seed: 'Datos iniciales' };

/** Detalle de una cita con su historial (solo lectura) y la única acción que la API permite al personal: registrar asistencia. */
function Detail({ id, onClose, onMark }: { id: string; onClose: () => void; onMark: (r: Row, s: 'completed' | 'no_show') => void }) {
  const q = useApi<DetailData>(`/admin/appointments/${id}`, { topics: ['appointments'] });
  return (
    <Modal title="Detalle de la cita" onClose={onClose}
      footer={<>{q.data?.attendance_allowed && <>
        <button type="button" onClick={() => onMark(q.data!, 'completed')}>Asistió</button>
        <button type="button" onClick={() => onMark(q.data!, 'no_show')}>No asistió</button></>}
        <button type="button" className="primary" onClick={onClose}>Cerrar</button></>}>
      <Async q={q}>
        {(d) => (
          <>
            <dl className="facts">
              <div><dt>Referencia</dt><dd><span className="ref">{d.booking_reference}</span></dd></div>
              <div><dt>Estado</dt><dd><Badge tone={STATUS[d.status]?.[1]}>{STATUS[d.status]?.[0] ?? d.status}</Badge></dd></div>
              <div><dt>Fecha y hora</dt><dd>{fmtDayTime(d.starts_at)}</dd></div>
              <div><dt>Paciente (ficticio)</dt><dd>{d.patient.full_name ?? '—'}</dd></div>
              <div><dt>Contacto</dt><dd><Contact phone={d.contact.phone} email={d.contact.email} /></dd></div>
              <div><dt>Servicio</dt><dd>{d.specialty} · {d.doctor.replace(/ \(fictici[oa]\)/, '')}</dd></div>
              <div><dt>Centro</dt><dd>{d.center}</dd></div>
              <div><dt>Canal</dt><dd>{CHANNEL[d.source_channel] ?? d.source_channel}</dd></div>
              <div><dt>Ofertas de adelanto</dt><dd>{d.advance_opt_in ? 'Aceptó recibirlas' : 'No'}</dd></div>
            </dl>
            <h3 className="group-title">Historial</h3>
            {d.events.length === 0 ? <p className="muted small">Sin eventos registrados (cita de datos iniciales).</p> : (
              <ol className="history">
                {d.events.map((e, i) => (
                  <li key={i}>
                    <time dateTime={e.occurred_at}>{fmtDayTime(e.occurred_at)}</time>
                    <span><strong>{EVENT[e.type] ?? e.type}</strong> <span className="muted">· por {ACTOR[e.actor_type] ?? e.actor_type}</span>
                      {e.from_starts_at && e.to_starts_at && <><br /><small><s>{fmtDayTime(e.from_starts_at)}</s> → {fmtDayTime(e.to_starts_at)}</small></>}</span>
                  </li>))}
              </ol>)}
            {!d.attendance_allowed && d.status === 'booked' && <p className="muted small">La asistencia se puede registrar cuando la cita haya empezado.</p>}
          </>
        )}
      </Async>
    </Modal>
  );
}

/** Teléfono (enlace para llamar) o correo (enlace para escribir) del paciente; el que haya dado. */
export function Contact({ phone, email }: { phone: string | null; email: string | null }) {
  if (!phone && !email) return <span className="muted">Sin contacto registrado</span>;
  return (
    <span className="contact">
      {phone && <a href={`tel:${phone.replace(/[^\d+]/g, '')}`}>{phone}</a>}
      {phone && email && <span aria-hidden="true"> · </span>}
      {email && <a href={`mailto:${email}`}>{email}</a>}
    </span>
  );
}
