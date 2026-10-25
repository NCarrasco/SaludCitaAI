import { useState } from 'react';
import { ApiError, api, qs } from '../api';
import { Async, Badge, Card, Modal, Notice, Updated } from '../components/ui';
import { ago, dateTime, fmtDayTime } from '../format';
import { useApi } from '../hooks';
import { Contact } from './Appointments';

interface Handoff { id: string; reference: string | null; status: string; reason: string; patient: { id: string; full_name: string | null; phone: string | null; email: string | null };
  created_at: string; resolved_at: string | null; resolution_note: string | null; patient_notified: boolean; resolved_by: string | null }
interface HandoffDetail extends Handoff {
  messages: { from: 'patient' | 'assistant'; text: string; at: string }[];
  appointments: { id: string; booking_reference: string; starts_at: string; specialty: string; doctor: string }[];
}

// Los botones del chat se guardan como «[Menú: book]», «[Eligió opción 2]»…: se muestran como lo que el paciente tocó
const MENU: Record<string, string> = { book: 'Reservar cita', my_appointments: 'Mis citas', cancel: 'Cancelar cita', reschedule: 'Cambiar cita',
  handoff: 'Hablar con el personal', help: '¿Qué puedo hacer?' };
const tapped = (t: string) => {
  const m = t.match(/^\[(.+)\]$/);
  if (!m) return null;
  const menu = m[1]!.match(/^Menú: (\w+)$/);
  return `Tocó «${menu ? MENU[menu[1]!] ?? menu[1] : m[1]}»`;
};

export function HandoffsPage() {
  const [status, setStatus] = useState<'open' | 'resolved'>('open');
  const [msg, setMsg] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const list = useApi<{ items: Handoff[] }>(`/handoffs${qs({ status, limit: 100 })}`, { topics: ['handoffs'] });
  return (
    <Card subtitle="Pacientes que pidieron «Hablar con el personal» en el chat. Ábrela para ver qué estaba haciendo, contáctalo y márcala resuelta con una nota: el paciente la recibe en «Avisos»."
          actions={<Updated q={list} />}>
      <div className="segmented" role="tablist" aria-label="Estado de las solicitudes">
        <button type="button" role="tab" aria-selected={status === 'open'} onClick={() => setStatus('open')}>Abiertas</button>
        <button type="button" role="tab" aria-selected={status === 'resolved'} onClick={() => setStatus('resolved')}>Resueltas</button>
      </div>
      {msg && <Notice>{msg}</Notice>}
      <Async q={list} empty={(d) => d.items.length === 0}>
        {(d) => (
          <div className="table-scroll">
            <table className="data">
              <thead><tr><th>Paciente (ficticio)</th><th>Contacto</th><th>{status === 'open' ? 'Motivo' : 'Qué se hizo'}</th><th>Antigüedad</th><th>Estado</th><th><span className="sr-only">Acción</span></th></tr></thead>
              <tbody>{d.items.map((h) => (
                <tr key={h.id}>
                  <td>{h.patient.full_name ?? '—'}{h.reference && <><br /><span className="ref ref-block">{h.reference}</span></>}</td>
                  <td><Contact phone={h.patient.phone} email={h.patient.email} /></td>
                  <td>{h.status === 'open' ? h.reason : <>{h.resolution_note ?? <span className="muted">Sin nota</span>}<br />
                    <small className="muted">{h.patient_notified ? 'Paciente avisado en el chat' : 'Sin aviso al paciente'}{h.resolved_by && <> · {h.resolved_by}</>}</small></>}</td>
                  <td className="nowrap"><strong>{ago(h.created_at)}</strong><br /><small className="muted">{dateTime(h.created_at)}{h.resolved_at && <> · resuelta {ago(h.resolved_at)}</>}</small></td>
                  <td><Badge tone={h.status === 'open' ? 'warn' : 'ok'}>{h.status === 'open' ? 'Abierta' : 'Resuelta'}</Badge></td>
                  <td><button type="button" className={`small${h.status === 'open' ? '' : ' ghost'}`} onClick={() => { setMsg(null); setOpen(h.id); }}
                    aria-label={`${h.status === 'open' ? 'Atender' : 'Ver'} la solicitud ${h.reference ?? ''}`}>{h.status === 'open' ? 'Atender' : 'Ver'}</button></td>
                </tr>))}
              </tbody>
            </table>
          </div>
        )}
      </Async>
      {open && <HandoffModal id={open} onClose={() => setOpen(null)}
        onResolved={(h) => { setOpen(null); setMsg(`Solicitud ${h.reference ?? ''} resuelta.${h.patient_notified ? ' El paciente la verá en «Avisos» del chat.' : ''}`); list.reload(); }} />}
    </Card>
  );
}

function HandoffModal({ id, onClose, onResolved }: { id: string; onClose: () => void; onResolved: (h: Handoff) => void }) {
  const q = useApi<HandoffDetail>(`/handoffs/${id}`, { topics: ['handoffs'] });
  const [note, setNote] = useState('');
  const [notify, setNotify] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const isOpen = q.data?.status === 'open';
  async function resolve() {
    setBusy(true); setErr(null);
    try {
      const h = await api<Handoff>(`/handoffs/${id}`, { method: 'PATCH', body: { status: 'resolved', ...(note.trim() ? { note: note.trim() } : {}), notify_patient: notify } });
      onResolved(h);
    } catch (e) { setErr(`No se pudo resolver: ${(e as ApiError).message}`); setBusy(false); }
  }
  return (
    <Modal title={`Solicitud de ayuda${q.data?.reference ? ` ${q.data.reference}` : ''}`} onClose={onClose}
      footer={<>{isOpen ? <>
        <button type="button" className="ghost" onClick={onClose}>Cancelar</button>
        <button type="button" className="primary" onClick={resolve} disabled={busy}>{busy ? 'Guardando…' : 'Marcar resuelta'}</button></>
        : <button type="button" className="primary" onClick={onClose}>Cerrar</button>}</>}>
      <Async q={q}>
        {(d) => (
          <>
            <dl className="facts">
              <div><dt>Paciente (ficticio)</dt><dd>{d.patient.full_name ?? '—'}</dd></div>
              <div><dt>Contacto</dt><dd><Contact phone={d.patient.phone} email={d.patient.email} /></dd></div>
              <div><dt>Pedida</dt><dd>{fmtDayTime(d.created_at)} <small className="muted">({ago(d.created_at)})</small></dd></div>
            </dl>

            <h3 className="group-title">Próximas citas</h3>
            {d.appointments.length === 0 ? <p className="muted small">No tiene citas próximas.</p> : (
              <ul className="ho-appts">{d.appointments.map((a) => (
                <li key={a.id}><a href={`#/citas?cita=${a.id}`} onClick={onClose}><span className="ref">{a.booking_reference}</span></a>
                  {' '}{fmtDayTime(a.starts_at)} · {a.specialty} · {a.doctor.replace(/ \(fictici[oa]\)/, '')}</li>))}
              </ul>)}

            <h3 className="group-title">Conversación con Salu antes de pedir ayuda</h3>
            {d.messages.length === 0 ? <p className="muted small">Sin mensajes registrados.</p> : (
              <ol className="ho-chat" aria-label="Últimos mensajes">
                {d.messages.map((m, i) => {
                  const t = m.from === 'patient' ? tapped(m.text) : null;
                  return (
                    <li key={i} className={m.from}>
                      <span className="who">{m.from === 'patient' ? 'Paciente' : 'Salu'} · <time dateTime={m.at}>{fmtDayTime(m.at)}</time></span>
                      {t ? <em className="muted">{t}</em> : <p>{m.text}</p>}
                    </li>);
                })}
              </ol>)}

            {isOpen ? (
              <div className="ho-resolve">
                <label>Qué se hizo <small className="muted">(opcional, máx. 500)</small>
                  <textarea maxLength={500} value={note} onChange={(e) => setNote(e.target.value)}
                    placeholder="Ej.: Llamé al paciente y movimos su cita al martes a las 9:00." /></label>
                <label className="check"><input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} /> Avisar al paciente en el chat («Avisos»){note.trim() ? ', con esta nota' : ''}</label>
                {err && <Notice tone="warn">{err}</Notice>}
              </div>
            ) : (
              <>
                <h3 className="group-title">Resolución</h3>
                <dl className="facts">
                  <div><dt>Resuelta</dt><dd>{d.resolved_at ? fmtDayTime(d.resolved_at) : '—'}</dd></div>
                  <div><dt>Por</dt><dd>{d.resolved_by ?? '—'}</dd></div>
                  <div><dt>Aviso al paciente</dt><dd>{d.patient_notified ? 'Enviado al chat' : 'No'}</dd></div>
                  <div className="span"><dt>Qué se hizo</dt><dd>{d.resolution_note ?? <span className="muted">Sin nota</span>}</dd></div>
                </dl>
              </>
            )}
          </>
        )}
      </Async>
    </Modal>
  );
}
