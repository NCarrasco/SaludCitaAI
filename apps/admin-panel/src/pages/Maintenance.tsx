import { type FormEvent, useEffect, useState } from 'react';
import { ApiError, type Catalog, type ScheduleImpact, api } from '../api';
import { DatePicker } from '../components/DatePicker';
import { Async, Badge, Card, Modal, Notice } from '../components/ui';
import { WEEKDAYS, localDay, n, zonedToIso } from '../format';
import { type Query, useApi } from '../hooks';

/** Secciones de Configuración (rutas #/configuracion/…). Calendarios de Google se gestiona en Sistema › Integraciones. */
export type ConfigSection = 'profesionales' | 'agenda' | 'centro' | 'vista-previa';
type ProTab = 'doctors' | 'specialties' | 'services';
const PRO_TABS: [ProTab, string][] = [['doctors', 'Médicos'], ['specialties', 'Especialidades'], ['services', 'Servicios']];

/** Operación pendiente de confirmar: se simula primero (dry_run) y se muestra su impacto. */
interface Pending { title: string; describe: string; run: (dryRun: boolean) => Promise<{ impact?: ScheduleImpact | { future_booked_appointments: number } }> }

export function MaintenancePage({ catalogQ, section }: { catalogQ: Query<Catalog>; section: ConfigSection }) {
  const [pro, setPro] = useState<ProTab>('doctors');
  const [pending, setPending] = useState<Pending | null>(null);
  const [msg, setMsg] = useState<{ tone: 'info' | 'warn'; text: string } | null>(null);
  useEffect(() => setMsg(null), [section]);
  const done = (text: string) => { setMsg({ tone: 'info', text }); catalogQ.reload(); };
  const fail = (e: unknown) => setMsg({ tone: 'warn', text: (e as ApiError).message });
  const ctx = { catalog: catalogQ.data, setPending, done, fail };
  return (
    <div className="stack">
      {section !== 'vista-previa' && <Notice>Los cambios no borran historial: los recursos se <strong>desactivan</strong>. Las citas reservadas nunca se cancelan ni se mueven
        automáticamente; si un cambio las afecta, se listan como conflictos para gestionarlas.</Notice>}
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
      <Async q={catalogQ}>
        {(catalog) => (
          <>
            {section === 'profesionales' && <>
              <div className="segmented" role="tablist" aria-label="Profesionales">
                {PRO_TABS.map(([k, l]) => <button key={k} type="button" role="tab" aria-selected={pro === k} onClick={() => { setPro(k); setMsg(null); }}>{l}</button>)}
              </div>
              {pro === 'doctors' && <SimpleEntity {...ctx} catalog={catalog} kind="doctors" />}
              {pro === 'specialties' && <SimpleEntity {...ctx} catalog={catalog} kind="specialties" />}
              {pro === 'services' && <Services {...ctx} catalog={catalog} />}
            </>}
            {section === 'agenda' && <Schedule {...ctx} catalog={catalog} />}
            {section === 'centro' && <Centers {...ctx} catalog={catalog} />}
            {section === 'vista-previa' && <InfoPreview catalog={catalog} />}
          </>
        )}
      </Async>
      {pending && <ConfirmImpact pending={pending} onClose={() => setPending(null)} onDone={(t) => { setPending(null); done(t); }} />}
    </div>
  );
}

/**
 * Centro. Con un solo centro se muestra su ficha directamente (sin tabla); la gestión de varios centros sigue disponible
 * más abajo, sin eliminar datos ni capacidad.
 */
function Centers(ctx: Ctx) {
  const { catalog } = ctx;
  const [card, setCard] = useState<Catalog['centers'][number] | null>(null);
  if (catalog.centers.length !== 1) return <SimpleEntity {...ctx} kind="centers" />;
  const c = catalog.centers[0]!;
  const none = <span className="muted">Sin registrar</span>;
  return (
    <>
      <Card title={c.name} subtitle="Lo que el asistente responde sobre ubicación, contacto, seguros y pagos sale de esta ficha."
            actions={<><Badge tone={c.active ? 'ok' : 'muted'}>{c.active ? 'Activo' : 'Inactivo'}</Badge>
              <button type="button" className="small primary" onClick={() => setCard(c)}>Editar ficha</button></>}>
        <dl className="facts">
          <div><dt>Dirección</dt><dd>{c.address ?? none}</dd></div>
          <div><dt>Teléfono</dt><dd>{c.phone ?? none}</dd></div>
          <div><dt>Correo</dt><dd>{c.email ?? none}</dd></div>
          <div className="span"><dt>Instrucciones para pacientes</dt><dd>{c.info_notes ?? none}</dd></div>
          <div><dt>Seguros aceptados</dt><dd>{c.accepted_insurers?.length ? c.accepted_insurers.join(', ') : none}</dd></div>
          <div><dt>Formas de pago</dt><dd>{c.payment_methods?.length ? c.payment_methods.join(', ') : none}</dd></div>
        </dl>
      </Card>
      <details className="more-tools">
        <summary>Gestionar centros · renombrar, desactivar o añadir otro centro</summary>
        <SimpleEntity {...ctx} kind="centers" />
      </details>
      {card && <CenterCard c={card} onClose={() => setCard(null)} onSaved={(t) => { setCard(null); ctx.done(t); }} onError={ctx.fail} />}
    </>
  );
}

interface Ctx { catalog: Catalog; setPending: (p: Pending) => void; done: (t: string) => void; fail: (e: unknown) => void }

// ---------------------------------------------------------------------------
// Centros, especialidades, médicos
// ---------------------------------------------------------------------------
const SIMPLE = {
  centers: { title: 'Centros', path: 'centers', nameKey: 'name', label: 'Nombre del centro' },
  specialties: { title: 'Especialidades', path: 'specialties', nameKey: 'name', label: 'Nombre de la especialidad' },
  doctors: { title: 'Médicos', path: 'doctors', nameKey: 'display_name', label: 'Nombre visible (ficticio)' },
} as const;

function SimpleEntity({ catalog, kind, setPending, done, fail }: Ctx & { kind: keyof typeof SIMPLE }) {
  const cfg = SIMPLE[kind];
  const rows = catalog[kind] as { id: string; active: boolean; name?: string; display_name?: string; address?: string | null }[];
  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  const [editing, setEditing] = useState<{ id: string; value: string } | null>(null);
  const [card, setCard] = useState<Catalog['centers'][number] | null>(null);
  async function create(e: FormEvent) {
    e.preventDefault();
    try {
      await api(`/admin/${cfg.path}`, { method: 'POST', body: { [cfg.nameKey]: name.trim(), ...(kind === 'centers' && address ? { address } : {}) } });
      setName(''); setAddress(''); done(`${cfg.title}: «${name.trim()}» creado.`);
    } catch (err) { fail(err); }
  }
  const toggle = (r: (typeof rows)[number]) => setPending({
    title: r.active ? 'Desactivar' : 'Reactivar',
    describe: `${r.active ? 'Desactivar' : 'Reactivar'} «${r[cfg.nameKey]}». ${r.active ? 'No admitirá nuevas reservas; las citas existentes se conservan.' : ''}`,
    run: (dry) => api(`/admin/${cfg.path}/${r.id}${dry ? '?dry_run=true' : ''}`, { method: 'PATCH', body: { active: !r.active } }),
  });
  async function rename() {
    if (!editing) return;
    try { await api(`/admin/${cfg.path}/${editing.id}`, { method: 'PATCH', body: { [cfg.nameKey]: editing.value.trim() } }); setEditing(null); done('Nombre actualizado.'); }
    catch (err) { fail(err); }
  }
  return (
    <Card title={cfg.title}>
      <form className="filters" onSubmit={create}>
        <label className="grow">{cfg.label}<input value={name} onChange={(e) => setName(e.target.value)} required maxLength={160} /></label>
        {kind === 'centers' && <label className="grow">Dirección (simulada)<input value={address} onChange={(e) => setAddress(e.target.value)} maxLength={300} /></label>}
        <button type="submit" className="primary">Crear</button>
      </form>
      <div className="table-scroll">
        <table className="data">
          <thead><tr><th>Nombre</th>{kind === 'centers' && <><th>Dirección</th><th>Contacto</th></>}<th>Estado</th><th /></tr></thead>
          <tbody>{rows.map((r) => (
            <tr key={r.id}>
              <td>{editing?.id === r.id
                ? <span className="inline-edit"><input aria-label="Nuevo nombre" value={editing.value} onChange={(e) => setEditing({ id: r.id, value: e.target.value })} />
                    <button type="button" className="small primary" onClick={rename}>Guardar</button><button type="button" className="small" onClick={() => setEditing(null)}>Cancelar</button></span>
                : r[cfg.nameKey]}</td>
              {kind === 'centers' && <><td>{r.address ?? <span className="muted">Sin registrar</span>}</td>
                <td>{(r as Catalog['centers'][number]).phone ?? <span className="muted">Sin teléfono</span>}
                  {(r as Catalog['centers'][number]).email && <><br /><small className="muted">{(r as Catalog['centers'][number]).email}</small></>}</td></>}
              <td><Badge tone={r.active ? 'ok' : 'muted'}>{r.active ? 'Activo' : 'Inactivo'}</Badge></td>
              <td className="row-actions">
                <button type="button" className="small" onClick={() => setEditing({ id: r.id, value: String(r[cfg.nameKey] ?? '') })}>Renombrar</button>
                {kind === 'centers' && <button type="button" className="small" onClick={() => setCard(r as Catalog['centers'][number])}>Ficha</button>}
                <button type="button" className="small" onClick={() => toggle(r)}>{r.active ? 'Desactivar' : 'Reactivar'}</button>
              </td>
            </tr>))}
          </tbody>
        </table>
      </div>
      {card && <CenterCard c={card} onClose={() => setCard(null)} onSaved={(t) => { setCard(null); done(t); }} onError={fail} />}
    </Card>
  );
}

/** Ficha institucional del centro: es lo que el asistente responde sobre contacto, seguros y pagos. */
const list = (v: string) => v.split(/\n|,/).map((x) => x.trim()).filter(Boolean);
function CenterCard({ c, onClose, onSaved, onError }: { c: Catalog['centers'][number]; onClose: () => void; onSaved: (t: string) => void; onError: (e: unknown) => void }) {
  const [f, setF] = useState({ address: c.address ?? '', phone: c.phone ?? '', email: c.email ?? '', info_notes: c.info_notes ?? '',
    accepted_insurers: (c.accepted_insurers ?? []).join('\n'), payment_methods: (c.payment_methods ?? []).join('\n') });
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    try {
      await api(`/admin/centers/${c.id}`, { method: 'PATCH', body: {
        address: f.address.trim() || null, phone: f.phone.trim() || null, email: f.email.trim() || null, info_notes: f.info_notes.trim() || null,
        accepted_insurers: list(f.accepted_insurers), payment_methods: list(f.payment_methods) } });
      onSaved(`Ficha de «${c.name}» guardada. El asistente ya responde con estos datos.`);
    } catch (e) { onError(e); onClose(); } finally { setBusy(false); }
  }
  return (
    <Modal title={`Ficha de ${c.name}`} onClose={onClose}
           footer={<><button type="button" onClick={onClose}>Cancelar</button><button type="button" className="primary" disabled={busy} onClick={save}>{busy ? 'Guardando…' : 'Guardar'}</button></>}>
      <p className="muted">Datos ficticios. Lo que dejes vacío, el asistente lo reconocerá como «no registrado».</p>
      <div className="form-grid">
        <label className="span">Dirección<input value={f.address} maxLength={300} onChange={(e) => setF({ ...f, address: e.target.value })} /></label>
        <label>Teléfono<input type="tel" value={f.phone} maxLength={40} onChange={(e) => setF({ ...f, phone: e.target.value })} /></label>
        <label>Correo<input type="email" value={f.email} maxLength={120} onChange={(e) => setF({ ...f, email: e.target.value })} /></label>
        <label className="span">Notas para pacientes (parqueo, accesos…)<textarea maxLength={500} value={f.info_notes} onChange={(e) => setF({ ...f, info_notes: e.target.value })} /></label>
        <label>Seguros aceptados <small className="muted">(uno por línea)</small><textarea value={f.accepted_insurers} onChange={(e) => setF({ ...f, accepted_insurers: e.target.value })} /></label>
        <label>Formas de pago <small className="muted">(una por línea)</small><textarea value={f.payment_methods} onChange={(e) => setF({ ...f, payment_methods: e.target.value })} /></label>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Servicios
// ---------------------------------------------------------------------------
const kindLabel = (k: string) => (k === 'initial' ? 'Primera consulta' : 'Seguimiento');

function Services({ catalog, setPending, done, fail }: Ctx) {
  const name = (list: { id: string; name?: string; display_name?: string }[], id: string) => { const x = list.find((y) => y.id === id); return x?.name ?? x?.display_name ?? '—'; };
  const [form, setForm] = useState({ doctor_id: '', center_id: '', specialty_id: '', consultation_kind: 'initial', slot_minutes: 20 });
  const [edit, setEdit] = useState<Catalog['services'][number] | null>(null);
  async function create(e: FormEvent) {
    e.preventDefault();
    try { await api('/admin/doctor-services', { method: 'POST', body: { ...form, slot_minutes: Number(form.slot_minutes) } }); done('Servicio creado. Añade reglas de horario para generar slots.'); }
    catch (err) { fail(err); }
  }
  return (
    <Card title="Servicios" subtitle="Combinación médico · centro · especialidad · tipo de consulta. Cambiar la duración reemplaza solo los horarios libres futuros.">
      <form className="filters" onSubmit={create}>
        <label>Médico<select required value={form.doctor_id} onChange={(e) => setForm({ ...form, doctor_id: e.target.value })}><option value="">—</option>
          {catalog.doctors.filter((d) => d.active).map((d) => <option key={d.id} value={d.id}>{d.display_name}</option>)}</select></label>
        <label>Centro<select required value={form.center_id} onChange={(e) => setForm({ ...form, center_id: e.target.value })}><option value="">—</option>
          {catalog.centers.filter((c) => c.active).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
        <label>Especialidad<select required value={form.specialty_id} onChange={(e) => setForm({ ...form, specialty_id: e.target.value })}><option value="">—</option>
          {catalog.specialties.filter((s) => s.active).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
        <label>Tipo<select value={form.consultation_kind} onChange={(e) => setForm({ ...form, consultation_kind: e.target.value })}>
          <option value="initial">Primera consulta</option><option value="follow_up">Seguimiento</option></select></label>
        <label>Minutos<input type="number" min={5} max={240} value={form.slot_minutes} onChange={(e) => setForm({ ...form, slot_minutes: Number(e.target.value) })} /></label>
        <button type="submit" className="primary">Crear servicio</button>
      </form>
      <div className="table-scroll">
        <table className="data">
          <thead><tr><th>Médico</th><th>Especialidad · centro</th><th>Tipo</th><th className="num">Min.</th><th className="num">Horizonte</th><th className="num">Antelación</th><th className="num">Precio</th><th>Estado</th><th /></tr></thead>
          <tbody>{catalog.services.map((s) => (
            <tr key={s.id}>
              <td>{name(catalog.doctors, s.doctor_id)}</td><td>{name(catalog.specialties, s.specialty_id)}<br /><small className="muted">{name(catalog.centers, s.center_id)}</small></td>
              <td>{kindLabel(s.consultation_kind)}</td><td className="num">{s.slot_minutes}</td><td className="num">{s.booking_horizon_days} d</td><td className="num">{s.min_notice_minutes} min</td>
              <td className="num">{s.price_dop == null ? <span className="muted">Sin precio</span> : `RD$${s.price_dop.toLocaleString('es-DO')}`}</td>
              <td><Badge tone={s.active ? 'ok' : 'muted'}>{s.active ? 'Activo' : 'Inactivo'}</Badge></td>
              <td><button type="button" className="small" onClick={() => setEdit(s)}>Editar</button></td>
            </tr>))}
          </tbody>
        </table>
      </div>
      {edit && <ServiceEdit s={edit} onClose={() => setEdit(null)} onSubmit={(body) => { setEdit(null); setPending({
        title: 'Editar servicio', describe: 'Se reconcilia la agenda futura del médico con la nueva configuración.',
        run: (dry) => api(`/admin/doctor-services/${edit.id}${dry ? '?dry_run=true' : ''}`, { method: 'PATCH', body }),
      }); }} />}
    </Card>
  );
}

function ServiceEdit({ s, onClose, onSubmit }: { s: Catalog['services'][number]; onClose: () => void; onSubmit: (b: object) => void }) {
  const [f, setF] = useState({ slot_minutes: s.slot_minutes, booking_horizon_days: s.booking_horizon_days, min_notice_minutes: s.min_notice_minutes,
    patient_instructions: s.patient_instructions ?? '', active: s.active, price_dop: s.price_dop == null ? '' : String(s.price_dop) });
  return (
    <Modal title="Editar servicio" onClose={onClose}
           footer={<><button type="button" onClick={onClose}>Cancelar</button>
             <button type="button" className="primary" onClick={() => onSubmit({ ...f, patient_instructions: f.patient_instructions.trim() || null,
               price_dop: f.price_dop.trim() === '' ? null : Number(f.price_dop) })}>Revisar impacto</button></>}>
      <div className="form-grid">
        <label>Duración (min)<input type="number" min={5} max={240} value={f.slot_minutes} onChange={(e) => setF({ ...f, slot_minutes: Number(e.target.value) })} /></label>
        <label>Horizonte (días)<input type="number" min={1} max={365} value={f.booking_horizon_days} onChange={(e) => setF({ ...f, booking_horizon_days: Number(e.target.value) })} /></label>
        <label>Antelación mínima (min)<input type="number" min={0} value={f.min_notice_minutes} onChange={(e) => setF({ ...f, min_notice_minutes: Number(e.target.value) })} /></label>
        <label>Precio de la consulta (RD$)<input type="number" min={0} step="50" value={f.price_dop} placeholder="Sin precio" onChange={(e) => setF({ ...f, price_dop: e.target.value })} /></label>
        <label className="check"><input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> Activo</label>
        <label className="span">Instrucciones al paciente<textarea maxLength={500} value={f.patient_instructions} onChange={(e) => setF({ ...f, patient_instructions: e.target.value })} /></label>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Reglas semanales y ausencias
// ---------------------------------------------------------------------------
interface Rule { id: string; weekday: number; local_start: string; local_end: string; valid_from: string; valid_until: string | null }
interface Exc { id: string; starts_at: string; ends_at: string; label: string; reason: string }
const REASONS: Record<string, string> = { absence: 'Ausencia', holiday: 'Feriado', training: 'Formación', other: 'Otro' };

function Schedule({ catalog, setPending }: Ctx) {
  const services = catalog.services;
  const [serviceId, setServiceId] = useState(services[0]?.id ?? '');
  const svc = services.find((s) => s.id === serviceId);
  const sched = useApi<{ rules: Rule[]; exceptions: Exc[]; upcoming: { open_slots: number; blocked_slots: number; booked_appointments: number } }>(
    serviceId ? `/admin/doctor-services/${serviceId}/schedule` : null);
  const [rule, setRule] = useState({ weekday: 1, local_start: '08:00', local_end: '12:00', valid_from: localDay(0), valid_until: '' });
  const [exc, setExc] = useState({ start: `${localDay(7)}T00:00`, end: `${localDay(8)}T00:00`, reason: 'absence' });
  const docName = (id: string) => catalog.doctors.find((d) => d.id === id)?.display_name ?? '—';
  const spName = (id: string) => catalog.specialties.find((d) => d.id === id)?.name ?? '—';
  const ask = (p: Pending) => setPending({ ...p, run: async (dry) => { const r = await p.run(dry); if (!dry) sched.reload(); return r; } });

  return (
    <div className="stack">
      <Card title="Horarios del servicio">
        <label className="inline">Servicio
          <select value={serviceId} onChange={(e) => setServiceId(e.target.value)}>
            {services.map((s) => <option key={s.id} value={s.id}>{docName(s.doctor_id)} · {spName(s.specialty_id)} · {kindLabel(s.consultation_kind)}{s.active ? '' : ' (inactivo)'}</option>)}
          </select>
        </label>
        <Async q={sched}>
          {(d) => (
            <>
              <p className="muted small">Próximos días: {n(d.upcoming.open_slots)} horarios abiertos · {n(d.upcoming.blocked_slots)} bloqueados · {n(d.upcoming.booked_appointments)} citas reservadas.</p>
              <div className="table-scroll">
                <table className="data">
                  <thead><tr><th>Día</th><th>Horario</th><th>Vigencia</th><th /></tr></thead>
                  <tbody>{d.rules.map((r) => (
                    <tr key={r.id}>
                      <td>{WEEKDAYS[r.weekday - 1]}</td><td>{r.local_start}–{r.local_end}</td>
                      <td>desde {r.valid_from}{r.valid_until ? ` hasta ${r.valid_until}` : ' (sin fin)'}</td>
                      <td>{!r.valid_until && <button type="button" className="small" onClick={() => ask({
                        title: 'Finalizar regla', describe: `Finalizar la regla de ${WEEKDAYS[r.weekday - 1]} ${r.local_start}–${r.local_end} con fecha ${localDay(0)}.`,
                        run: (dry) => api(`/admin/schedule-rules/${r.id}${dry ? '?dry_run=true' : ''}`, { method: 'PATCH', body: { valid_until: localDay(0) } }),
                      })}>Finalizar hoy</button>}</td>
                    </tr>))}
                  </tbody>
                </table>
              </div>
              <form className="filters" onSubmit={(e) => { e.preventDefault(); ask({
                title: 'Añadir regla', describe: `Atención los ${WEEKDAYS[rule.weekday - 1]} de ${rule.local_start} a ${rule.local_end}.`,
                run: (dry) => api(`/admin/schedule-rules${dry ? '?dry_run=true' : ''}`, { method: 'POST',
                  body: { doctor_service_id: serviceId, ...rule, weekday: Number(rule.weekday), valid_until: rule.valid_until || null } }),
              }); }}>
                <label>Día<select value={rule.weekday} onChange={(e) => setRule({ ...rule, weekday: Number(e.target.value) })}>
                  {WEEKDAYS.map((w, i) => <option key={w} value={i + 1}>{w}</option>)}</select></label>
                <label>Desde<input type="time" value={rule.local_start} onChange={(e) => setRule({ ...rule, local_start: e.target.value })} /></label>
                <label>Hasta<input type="time" value={rule.local_end} onChange={(e) => setRule({ ...rule, local_end: e.target.value })} /></label>
                <div className="field"><span className="field-label">Vigente desde</span><DatePicker label="Vigente desde" value={rule.valid_from} onChange={(v) => v && setRule({ ...rule, valid_from: v })} /></div>
                <div className="field"><span className="field-label">Hasta (opcional)</span><DatePicker label="Hasta (opcional)" optional min={rule.valid_from} value={rule.valid_until} onChange={(v) => setRule({ ...rule, valid_until: v })} /></div>
                <button type="submit" className="primary">Revisar y añadir</button>
              </form>
            </>
          )}
        </Async>
      </Card>

      {svc && (
        <Card title={`Ausencias de ${docName(svc.doctor_id)}`} subtitle="Afectan a todos los servicios del médico. Hora local de Santo Domingo.">
          <Async q={sched}>
            {(d) => (
              <>
                {d.exceptions.length === 0 ? <p className="muted">Sin ausencias registradas.</p> : (
                  <ul className="list">{d.exceptions.map((x) => (
                    <li key={x.id}><span><Badge tone="warn">{REASONS[x.reason] ?? x.reason}</Badge> {x.label}</span>
                      {Date.parse(x.starts_at) > Date.now() && <button type="button" className="small" onClick={() => ask({
                        title: 'Retirar ausencia', describe: `Retirar la ausencia ${x.label}. Los horarios que vuelvan a estar cubiertos se reabren.`,
                        run: (dry) => api(`/admin/schedule-exceptions/${x.id}${dry ? '?dry_run=true' : ''}`, { method: 'DELETE' }),
                      })}>Retirar</button>}
                    </li>))}
                  </ul>
                )}
                <form className="filters" onSubmit={(e) => { e.preventDefault(); ask({
                  title: 'Registrar ausencia', describe: `${REASONS[exc.reason]} de ${docName(svc.doctor_id)} del ${exc.start.replace('T', ' ')} al ${exc.end.replace('T', ' ')}.`,
                  run: (dry) => api(`/admin/schedule-exceptions${dry ? '?dry_run=true' : ''}`, { method: 'POST',
                    body: { doctor_id: svc.doctor_id, starts_at: zonedToIso(exc.start), ends_at: zonedToIso(exc.end), reason: exc.reason } }),
                }); }}>
                  <label>Inicio<input type="datetime-local" value={exc.start} onChange={(e) => setExc({ ...exc, start: e.target.value })} required /></label>
                  <label>Fin<input type="datetime-local" value={exc.end} onChange={(e) => setExc({ ...exc, end: e.target.value })} required /></label>
                  <label>Motivo<select value={exc.reason} onChange={(e) => setExc({ ...exc, reason: e.target.value })}>
                    {Object.entries(REASONS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
                  <button type="submit" className="primary">Revisar y registrar</button>
                </form>
              </>
            )}
          </Async>
        </Card>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Confirmación con simulación de impacto
// ---------------------------------------------------------------------------
const CONFLICT_REASON: Record<string, string> = { outside_rules: 'Fuera del nuevo horario', doctor_absence: 'Ausencia del médico', service_inactive: 'Servicio inactivo' };

function ConfirmImpact({ pending, onClose, onDone }: { pending: Pending; onClose: () => void; onDone: (t: string) => void }) {
  const [state, setState] = useState<{ loading: boolean; impact?: unknown; error?: string; saving?: boolean }>({ loading: true });
  useEffect(() => {
    let alive = true;
    pending.run(true).then((r) => { if (alive) setState({ loading: false, impact: r.impact ?? null }); },
                           (e: ApiError) => { if (alive) setState({ loading: false, error: e.message }); });
    return () => { alive = false; };
  }, [pending]);
  async function apply() {
    setState((s) => ({ ...s, saving: true }));
    try {
      const r = await pending.run(false);
      const imp = r.impact as ScheduleImpact | undefined;
      onDone(`${pending.title}: guardado.${imp && 'conflicts' in imp && imp.conflicts.length ? ` ${imp.conflicts.length} cita(s) requieren gestión manual.` : ''}`);
    } catch (e) { setState((s) => ({ ...s, saving: false, error: (e as ApiError).message })); }
  }
  const imp = state.impact as (ScheduleImpact & { future_booked_appointments?: number }) | null | undefined;
  return (
    <Modal title={pending.title} onClose={onClose}
           footer={<><button type="button" onClick={onClose}>Cancelar</button>
             <button type="button" className="primary" disabled={state.loading || state.saving || Boolean(state.error && !imp)} onClick={apply}>
               {state.saving ? 'Guardando…' : 'Confirmar cambio'}</button></>}>
      <p>{pending.describe}</p>
      {state.loading && <div className="state loading"><span className="spinner" aria-hidden="true" />Calculando impacto (simulación sin guardar)…</div>}
      {state.error && <div className="state error" role="alert">{state.error}</div>}
      {imp && (
        <div className="impact">
          <h3>Impacto calculado</h3>
          {'future_booked_appointments' in imp && imp.future_booked_appointments !== undefined && (
            <p>{n(imp.future_booked_appointments)} cita(s) futura(s) reservada(s) en este recurso se conservan.</p>)}
          {'blocked_free_slots' in imp && (
            <>
              <ul className="impact-list">
                <li><strong>{n(imp.blocked_free_slots)}</strong> horarios libres se bloquean</li>
                <li><strong>{n(imp.reopened_slots)}</strong> horarios se reabren</li>
                <li><strong>{n(imp.generated_slots)}</strong> horarios nuevos (próximos 30 días)</li>
              </ul>
              {imp.conflicts.length > 0 ? (
                <>
                  <Notice tone="warn"><strong>{imp.conflicts.length} cita(s) reservada(s) quedan en conflicto.</strong> No se cancelan ni se mueven:
                    el personal debe contactar al paciente y gestionarlas.</Notice>
                  <div className="table-scroll"><table className="data">
                    <thead><tr><th>Referencia</th><th>Fecha</th><th>Paciente</th><th>Motivo</th></tr></thead>
                    <tbody>{imp.conflicts.map((c) => <tr key={c.appointment_id}><td className="mono">{c.booking_reference}</td><td>{c.label}</td>
                      <td>{c.patient_name ?? '—'}</td><td>{CONFLICT_REASON[c.reason] ?? c.reason}</td></tr>)}</tbody>
                  </table></div>
                </>
              ) : <p className="muted">Ninguna cita reservada queda afectada.</p>}
            </>
          )}
        </div>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Vínculos de Google Calendar por médico
// ---------------------------------------------------------------------------
interface BindingRow { doctor_id: string; display_name: string; external_calendar_id: string | null; enabled: boolean; sync_by_status: Record<string, number> }

export function Calendars({ done, fail }: { done: (t: string) => void; fail: (e: unknown) => void }) {
  const q = useApi<{ items: BindingRow[] }>('/admin/calendar-bindings');
  const [edit, setEdit] = useState<Record<string, string>>({});
  async function save(r: BindingRow, enabled: boolean) {
    const id = (edit[r.doctor_id] ?? r.external_calendar_id ?? '').trim();
    try {
      const res = await api<{ requeued_appointments: number }>(`/admin/calendar-bindings/${r.doctor_id}`, { method: 'PUT', body: { external_calendar_id: id, enabled } });
      done(`${r.display_name}: calendario ${enabled ? 'habilitado' : 'deshabilitado'}${enabled ? ` · ${res.requeued_appointments} cita(s) futuras encoladas` : ''}.`);
      q.reload();
    } catch (e) { fail(e); }
  }
  return (
    <Card title="Calendarios de Google por médico" subtitle="Espejo unidireccional API → Google Calendar. Las credenciales OAuth viven solo en n8n.">
      <Notice tone="warn"><strong>Integración pendiente.</strong> Vincular un calendario aquí no basta: el workflow «SaludCita · Google Calendar» debe
        tener credenciales OAuth y estar publicado en n8n. Hasta probarlo con eventos reales, la sincronización se considera no verificada
        (ver docs/google-calendar.md).</Notice>
      <Async q={q}>
        {(d) => (
          <div className="table-scroll">
            <table className="data">
              <thead><tr><th>Médico</th><th>ID del calendario</th><th>Estado</th><th>Sincronizaciones</th><th /></tr></thead>
              <tbody>{d.items.map((r) => (
                <tr key={r.doctor_id}>
                  <td>{r.display_name}</td>
                  <td><input aria-label={`ID de calendario de ${r.display_name}`} placeholder="…@group.calendar.google.com"
                             value={edit[r.doctor_id] ?? r.external_calendar_id ?? ''} onChange={(e) => setEdit({ ...edit, [r.doctor_id]: e.target.value })} /></td>
                  <td><Badge tone={r.enabled ? 'ok' : 'muted'}>{r.enabled ? 'Habilitado' : 'Sin vínculo'}</Badge></td>
                  <td className="small">{Object.entries(r.sync_by_status).map(([k, v]) => `${k}: ${v}`).join(' · ') || '—'}</td>
                  <td className="row-actions">
                    <button type="button" className="small primary" onClick={() => save(r, true)}>Guardar y habilitar</button>
                    {r.enabled && <button type="button" className="small" onClick={() => save(r, false)}>Deshabilitar</button>}
                  </td>
                </tr>))}
              </tbody>
            </table>
          </div>
        )}
      </Async>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Información al paciente: lo que responde el asistente con los datos actuales (misma función que el chat)
// ---------------------------------------------------------------------------
const TOPICS: [string, string][] = [['horarios', 'Horarios de consulta'], ['precios_seguros', 'Precios, seguros y pagos'],
  ['ubicacion_contacto', 'Dirección y contacto'], ['especialidades', 'Especialidades y médicos'], ['politicas', 'Normas para reservar'],
  ['comprobantes', 'Comprobantes'], ['avisos', 'Avisos'], ['acceso', 'Acceso'], ['funciones', 'Qué puede hacer el asistente'],
  ['otro', 'Pregunta sin dato registrado']];

function InfoPreview({ catalog }: { catalog: Catalog }) {
  const [topic, setTopic] = useState('horarios');
  const [lang, setLang] = useState<'es' | 'en'>('es');
  const [specialty, setSpecialty] = useState('');
  const withSpecialty = topic === 'horarios' || topic === 'precios_seguros';
  const qs = new URLSearchParams({ topic, lang, ...(withSpecialty && specialty ? { specialty } : {}) });
  const q = useApi<{ text: string }>(`/admin/service-info?${qs}`);
  return (
    <Card title="Vista previa de respuestas al paciente" subtitle="Herramienta de comprobación: muestra lo que respondería el asistente con los datos actuales. Se construye con la base de datos, no con el modelo; para cambiarla, edita la ficha del centro, los servicios o los horarios.">
      <div className="filters">
        <label>Tema<select value={topic} onChange={(e) => setTopic(e.target.value)}>{TOPICS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
        {withSpecialty && <label>Especialidad<select value={specialty} onChange={(e) => setSpecialty(e.target.value)}><option value="">Todas</option>
          {catalog.specialties.filter((x) => x.active).map((x) => <option key={x.id} value={x.name}>{x.name}</option>)}</select></label>}
        <label>Idioma<select value={lang} onChange={(e) => setLang(e.target.value as 'es' | 'en')}><option value="es">Español</option><option value="en">Inglés</option></select></label>
      </div>
      <Async q={q}>{(d) => <div className="preview-bubble" aria-live="polite">{d.text}</div>}</Async>
    </Card>
  );
}
