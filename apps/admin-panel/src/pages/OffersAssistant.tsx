import { useMemo } from 'react';
import { type Conversation, type Envelope, type Offers, qs } from '../api';
import { ChartView, cssVar, useTheme } from '../components/Chart';
import { type StatsFilter, filterQuery, filterValid } from '../components/Filters';
import { Async, Card, Definition, Kpi, Updated } from '../components/ui';
import { n, pct } from '../format';
import { useApi } from '../hooks';


const OFFER_LABELS: Record<string, string> = {
  pending: 'Pendientes', accepted: 'Aceptadas', rejected: 'Rechazadas', expired: 'Vencidas', invalidated: 'Invalidadas', delivery_failed: 'Fallo de entrega',
};
const MODE_LABELS: Record<string, string> = {
  ai: 'IA local (interpretada por el modelo)', deterministic: 'Menú guiado (sin IA)', fallback_menu: 'Recuperación (falló la IA)', system: 'Resultado verificado',
};

/** Estadísticas › Adelantos: ofertas de adelanto y recuperación de horarios liberados (métricas del servicio). */
export function AdvancesPage({ filter }: { filter: StatsFilter }) {
  const valid = filterValid(filter);
  const query = qs(filterQuery(filter));
  const off = useApi<Envelope<Offers>>(valid ? `/stats/offers${query}` : null, { topics: ['offers', 'appointments'] });
  return (
    <div className="stack">
      <Card title="Ofertas de adelanto" actions={<><Definition text="Cuando se libera un horario se ofrece, de uno en uno, a pacientes con una cita posterior del mismo servicio que aceptaron recibir ofertas. Cada oferta tiene un plazo de respuesta; al aceptar, el horario anterior se ofrece en cascada." /><Updated q={off} /></>}>
        <Async q={off}>
          {({ data: d, definitions: def }) => {
            const o = d.offers_by_status;
            return (
              <div className="kpis">
                {Object.keys(OFFER_LABELS).map((k) => <Kpi key={k} label={OFFER_LABELS[k]!} value={n(o[k] ?? 0)} definition={def.offers} />)}
                <Kpi label="Tasa de aceptación" value={pct(d.acceptance_rate)} detail={`${n(o.accepted ?? 0)} de ${n((o.accepted ?? 0) + (o.rejected ?? 0) + (o.expired ?? 0))} respondidas o vencidas`} definition={def.offers} />
                <Kpi label="Adelanto conseguido" value={d.advance_minutes.n ? `${n(d.advance_minutes.median)} min` : '—'}
                     detail={d.advance_minutes.n ? `mediana · media ${n(d.advance_minutes.mean)} min · n = ${d.advance_minutes.n}` : 'Sin adelantos aceptados'}
                     definition={def.advance_minutes} />
              </div>
            );
          }}
        </Async>
      </Card>

      <Card title="Recuperación de horarios liberados" subtitle="Incluye cancelaciones y reprogramaciones aunque todavía no existan ofertas">
        <Async q={off}>
          {({ data: d, definitions: def, generated_at }) => (
            <div className="kpis">
              <Kpi label="Horarios recuperados" value={pct(d.recovery.rate)}
                   detail={`${n(d.recovery.recovered_slots)} de ${n(d.recovery.freed_eligible_slots)} liberados antes de su inicio · corte ${generated_at.slice(0, 16).replace('T', ' ')}`}
                   definition={def.recovery} />
            </div>
          )}
        </Async>
      </Card>

    </div>
  );
}

/**
 * Sistema › Asistente: diagnóstico técnico del asistente (modo, fallos del modelo, latencia, tokens) y evaluaciones
 * históricas. No es una métrica de éxito del servicio: una respuesta interpretada por IA puede ser incorrecta.
 */
export function AssistantDiagnostics({ filter }: { filter: StatsFilter }) {
  const valid = filterValid(filter);
  // Conversación: actualización periódica (60 s); los mensajes del chat no generan avisos en vivo
  const conv = useApi<Envelope<Conversation>>(valid ? `/stats/conversation${qs({ from: filter.from, to: filter.to })}` : null, { everyMs: 60_000 });
  return (
    <div className="stack">
      <Card title="Uso del asistente" subtitle="Mensajes del asistente en el periodo (sin filtros de centro, médico o especialidad). Uso de IA no es éxito: una respuesta interpretada por el modelo puede ser incorrecta." actions={<Updated q={conv} />}>
        <Async q={conv} empty={(e) => e.data.replies === 0}>
          {({ data: d, definitions: def }) => (
            <>
              <div className="kpis">
                <Kpi label="Respuestas del asistente" value={n(d.replies)} definition={def.conversation} />
                <Kpi label="Interpretadas por IA" value={pct(d.replies ? (d.by_mode.ai ?? 0) / d.replies : null)} detail={`${n(d.by_mode.ai ?? 0)} de ${n(d.replies)}`} />
                <Kpi label="Aclaraciones solicitadas" value={n(d.clarifications)} detail="Se cuentan aparte del éxito directo" definition={def.conversation} />
                <Kpi label="Fallos del modelo" value={n(d.llm_errors)} detail={`${n(d.by_mode.fallback_menu ?? 0)} respuestas de recuperación`} tone={d.llm_errors ? 'warn' : undefined} />
                <Kpi label="Latencia del modelo" value={d.model_latency_ms.p50 === null ? '—' : `${n(d.model_latency_ms.p50)} ms`}
                     detail={d.model_latency_ms.n ? `p50 · p90 ${n(d.model_latency_ms.p90)} ms · n = ${d.model_latency_ms.n}` : 'Sin mediciones'} />
                <Kpi label="Solicitudes al personal" value={n(d.handoffs)} />
              </div>
              <ModeChart byMode={d.by_mode} />
              <p className="muted small">Tokens: {n(d.tokens.prompt)} de entrada · {n(d.tokens.completion)} de salida. Actualización periódica cada 60 s.</p>
            </>
          )}
        </Async>
      </Card>
      <Card title="Evaluaciones del modelo (históricas, evidencia académica)" subtitle="Pruebas puntuales y versionadas con baterías congeladas; no se recalculan aquí ni miden la operación actual.">
        <ul className="feed">
          <li><span className="mono">reserved-v6</span><span>24-oct-2026 · qwen3:1.7b · 17 de 24 turnos correctos; 0 afirmaciones inventadas; 3 errores de interpretación y 4 de infraestructura</span></li>
          <li><span className="mono">reserved-v5</span><span>24-oct-2026 · qwen3:1.7b · 31 de 47 turnos; 2 afirmaciones falsas sobre el servicio (corregidas después)</span></li>
        </ul>
        <p className="muted small">Detalle y archivos: docs/evaluacion-ia-local.md.</p>
      </Card>
    </div>
  );
}

function ModeChart({ byMode }: { byMode: Record<string, number> }) {
  const keys = ['ai', 'deterministic', 'system', 'fallback_menu'];
  const theme = useTheme();
  const config = useMemo(() => ({
    type: 'bar' as const,
    data: { labels: keys.map((k) => MODE_LABELS[k]), datasets: [{ data: keys.map((k) => byMode[k] ?? 0),
      backgroundColor: [cssVar('--c1'), cssVar('--c2'), cssVar('--c5'), cssVar('--c3')] }] },
    options: { indexAxis: 'y' as const, plugins: { legend: { display: false } }, scales: { x: { beginAtZero: true, ticks: { precision: 0 } } } },
  }), [byMode, theme]); // eslint-disable-line react-hooks/exhaustive-deps
  return <ChartView config={config as never} label="Respuestas del asistente por modo" height={200}
    table={{ caption: 'Respuestas por modo', columns: ['Modo', 'Respuestas'], rows: keys.map((k) => [MODE_LABELS[k]!, byMode[k] ?? 0]) }} />;
}
