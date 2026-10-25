import { useState } from 'react';
import { ApiError, api, qs } from '../api';
import type { StatsFilter } from '../components/Filters';
import { Async, Badge, Card, Notice, Updated } from '../components/ui';
import { dateTime, n } from '../format';
import { useApi } from '../hooks';
import { Calendars } from './Maintenance';
import { AssistantDiagnostics } from './OffersAssistant';

/** Sistema (solo admin, también en la API): diagnóstico técnico separado de las métricas del servicio. */
export type SystemSection = 'integraciones' | 'trabajos' | 'asistente';

interface Integrations { checked_at: string; database: { status: string }; model: { status: string; configured_model: string; model_present: boolean | null };
  calendar: { status: string; enabled_bindings: number; sync_by_status: Record<string, number> };
  outbox_by_status: Record<string, number>; conversation_updates_by_status: Record<string, number> }
interface Job { id: string; kind: string; status: string; attempts: number; max_attempts: number; aggregate_id: string | null;
  available_at: string; last_error: string | null; updated_at: string }

const JOB_STATUS: Record<string, string> = { dead: 'Agotó reintentos', pending: 'En espera', leased: 'En proceso', done: 'Hecho', cancelled: 'Cancelado' };
const MODEL_STATUS: Record<string, [string, 'ok' | 'warn' | 'bad']> = {
  ok: ['Disponible', 'ok'], model_missing: ['Modelo no descargado', 'warn'], unreachable: ['Inaccesible', 'bad'], error: ['Error', 'bad'],
};

export function SystemPage({ section, filter }: { section: SystemSection; filter: StatsFilter }) {
  if (section === 'trabajos') return <JobsCard />;
  if (section === 'asistente') return <AssistantDiagnostics filter={filter} />;
  return <IntegrationsSection />;
}

function IntegrationsSection() {
  // Actualización periódica (30 s): estos estados no generan avisos en vivo
  const integ = useApi<Integrations>('/admin/integrations', { everyMs: 30_000 });
  const [msg, setMsg] = useState<{ tone: 'info' | 'warn'; text: string } | null>(null);
  return (
    <div className="stack">
      <Card title="Integraciones" subtitle="Diagnóstico técnico comprobado por la API, sin secretos. Actualización periódica cada 30 s." actions={<Updated q={integ} />}>
        <Async q={integ}>
          {(d) => (
            <div className="status-grid">
              <div><h3>Base de datos</h3><Badge tone="ok">Operativa</Badge></div>
              <div><h3>Modelo local (Ollama)</h3><Badge tone={MODEL_STATUS[d.model.status]?.[1] ?? 'bad'}>{MODEL_STATUS[d.model.status]?.[0] ?? d.model.status}</Badge>
                <p className="muted small">{d.model.configured_model}{d.model.status !== 'ok' && ' · el chat responde con el menú de recuperación'}</p></div>
              <div><h3>Google Calendar</h3>
                {d.calendar.status === 'pending_credentials'
                  ? <><Badge tone="warn">Pendiente de credenciales</Badge><p className="muted small">Integración no probada. Las citas se guardan igual; la sincronización queda desactivada (no se simula).</p></>
                  : <Badge tone="info">{n(d.calendar.enabled_bindings)} calendarios vinculados</Badge>}
                <p className="muted small">Sincronizaciones: {Object.entries(d.calendar.sync_by_status).map(([k, v]) => `${k} ${v}`).join(' · ') || 'ninguna'}</p></div>
              <div><h3>Cola de trabajos</h3><p className="small">{Object.entries(d.outbox_by_status).map(([k, v]) => `${k}: ${v}`).join(' · ') || 'vacía'}</p>
                <p className="muted small">El planificador de n8n procesa vencimientos y recordatorios cada minuto; los trabajos de calendario esperan credenciales de Google.</p></div>
              <div><h3>Mensajes del chat</h3><p className="small">{Object.entries(d.conversation_updates_by_status).map(([k, v]) => `${k}: ${v}`).join(' · ') || 'ninguno'}</p></div>
            </div>
          )}
        </Async>
      </Card>
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
      <Calendars done={(text) => setMsg({ tone: 'info', text })} fail={(e) => setMsg({ tone: 'warn', text: (e as ApiError).message })} />
    </div>
  );
}

function JobsCard() {
  const [status, setStatus] = useState('dead');
  const [msg, setMsg] = useState<string | null>(null);
  const jobs = useApi<{ items: Job[] }>(`/admin/jobs${qs({ status, limit: 100 })}`, { everyMs: 30_000 });
  async function retry(j: Job) {
    try {
      await api(`/admin/jobs/${j.id}/retry`, { method: 'POST' });
      setMsg(`Trabajo ${j.kind} reprogramado para reintento.`);
      jobs.reload();
    } catch (e) { setMsg(`No se pudo reintentar: ${(e as ApiError).message}`); }
  }
  return (
    <Card title="Cola de trabajos" subtitle="Solo los que agotaron sus reintentos admiten reintento manual." actions={<Updated q={jobs} />}>
      <label className="inline">Estado
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          {Object.entries(JOB_STATUS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
      </label>
      {msg && <Notice>{msg}</Notice>}
      <Async q={jobs} empty={(d) => d.items.length === 0}>
        {(d) => (
          <div className="table-scroll">
            <table className="data">
              <thead><tr><th>Tipo</th><th>Estado</th><th className="num">Intentos</th><th>Disponible</th><th>Último error</th><th /></tr></thead>
              <tbody>{d.items.map((j) => (
                <tr key={j.id}>
                  <td className="mono">{j.kind}</td><td><Badge tone={j.status === 'dead' ? 'bad' : j.status === 'done' ? 'ok' : 'muted'}>{JOB_STATUS[j.status] ?? j.status}</Badge></td>
                  <td className="num">{j.attempts}/{j.max_attempts}</td><td>{dateTime(j.available_at)}</td>
                  <td className="small">{j.last_error ?? '—'}</td>
                  <td>{j.status === 'dead' && <button type="button" className="small" onClick={() => retry(j)}>Reintentar</button>}</td>
                </tr>))}
              </tbody>
            </table>
          </div>
        )}
      </Async>
    </Card>
  );
}
