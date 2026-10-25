#!/usr/bin/env node
// Mide la latencia por etapa de la conversación por la ruta REAL (API → n8n → Ollama → API), con el sistema levantado.
// Etapas: cola (hasta que n8n toma el mensaje), interpretación del modelo, decisión de la API, redacción (2.ª llamada,
// solo en respuestas conversacionales), total en el servidor y total visible para el cliente (incluye el sondeo).
// Uso: node scripts/measure-latency.mjs [--rounds 2] [--out docs/evidencias/correccion/latencia]
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const ROUNDS = Number(arg('--rounds', '2'));
const OUT = arg('--out', null);
const env = Object.fromEntries(readFileSync('.env', 'utf8').split('\n').filter((l) => /^[A-Z0-9_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const V1 = `http://127.0.0.1:${env.API_HOST_PORT || 8080}/api/v1`;
const POLL_MS = 300;
const MESSAGES = ['hola', '¿qué puedes hacer?', 'quiero una cita de cardiología', 'necesito cita para mi hijo', 'ver mis citas',
  'no gracias', 'me duele la cabeza, ¿qué tomo?', 'quiero cambiar mi cita', 'buenas tardes', 'gracias'];

const tok = (await (await fetch(`${V1}/patient-auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: 'paciente02', password: env.SEED_PATIENT_PASSWORD }) })).json()).token;
const H = { authorization: `Bearer ${tok}`, 'content-type': 'application/json' };
const act = (action) => fetch(`${V1}/conversation/messages`, { method: 'POST', headers: H, body: JSON.stringify({ client_message_id: randomUUID(), action }) });

const runs = [];
for (let r = 0; r < ROUNDS; r++) {
  for (const text of MESSAGES) {
    await act({ type: 'discard_proposal' });
    const t0 = performance.now();
    const s = await (await fetch(`${V1}/conversation/messages`, { method: 'POST', headers: H, body: JSON.stringify({ client_message_id: randomUUID(), text }) })).json();
    let u;
    do { await new Promise((x) => setTimeout(x, POLL_MS)); u = await (await fetch(`${V1}/conversation/updates/${s.update_id}`, { headers: H })).json(); }
    while (u.status === 'pending' && performance.now() - t0 < 120000);
    runs.push({ update_id: s.update_id, text, visible_ms: Math.round(performance.now() - t0), status: u.status });
    process.stdout.write(`${text} → ${runs.at(-1).visible_ms} ms\n`);
  }
}
const ids = runs.map((x) => `'${x.update_id}'`).join(',');
const sql = `SELECT id, round(extract(epoch FROM claimed_at - created_at)*1000) q, round(extract(epoch FROM done_at - created_at)*1000) t,
  result->'timing'->>'interpretation_ms' i, result->'timing'->>'decision_ms' d, result->'draft'->>'latency_ms' r, result->'draft'->>'ok' ok,
  result->'interpretation'->>'intent' intent FROM inbound_updates WHERE id IN (${ids})`;
const rows = execFileSync('docker', ['compose', '--env-file', '.env', '-f', 'infra/compose.yaml', 'exec', '-T', 'postgres', 'sh', '-c',
  `psql -U "$POSTGRES_USER" -d "${env.APP_DB_NAME || 'saludcita'}" -At -F '|' -c "${sql.replace(/"/g, '\\"')}"`], { encoding: 'utf8' })
  .trim().split('\n').map((l) => { const [id, q, t, i, d, r, ok, intent] = l.split('|');
    return { id, queue_ms: +q, server_total_ms: +t, interpretation_ms: +i || null, decision_ms: +d || null, draft_ms: r ? +r : null, draft_ok: ok || null, intent }; });
const byId = Object.fromEntries(rows.map((x) => [x.id, x]));
const data = runs.map((x) => ({ ...x, ...byId[x.update_id] }));
const pct = (xs, p) => { const s = xs.filter((v) => v != null && !Number.isNaN(v)).sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : null; };
const stat = (sel, filter = () => true) => { const xs = data.filter(filter).map(sel); return { n: xs.filter((v) => v != null).length, p50: pct(xs, 0.5), p90: pct(xs, 0.9) }; };
const drafted = (x) => x.draft_ms != null;
const summary = {
  executed_at: new Date().toISOString(), messages: data.length, poll_interval_ms: POLL_MS,
  model: env.OLLAMA_MODEL || 'qwen3:1.7b',
  host: execFileSync('sysctl', ['-n', 'machdep.cpu.brand_string'], { encoding: 'utf8' }).trim(),
  docker: execFileSync('docker', ['info', '--format', '{{.NCPU}} CPU, {{.MemTotal}} B'], { encoding: 'utf8' }).trim(),
  stages: {
    cola: stat((x) => x.queue_ms), interpretacion_modelo: stat((x) => x.interpretation_ms), decision_api: stat((x) => x.decision_ms),
    redaccion_modelo: stat((x) => x.draft_ms, drafted), total_servidor: stat((x) => x.server_total_ms), total_visible: stat((x) => x.visible_ms),
  },
  total_visible_con_redaccion: stat((x) => x.visible_ms, drafted),
  total_visible_sin_redaccion: stat((x) => x.visible_ms, (x) => !drafted(x)),
  redacciones: { total: data.filter(drafted).length, aceptadas: data.filter((x) => x.draft_ok === 'true').length },
};
console.log(JSON.stringify(summary, null, 1));
if (OUT) writeFileSync(`${OUT}.json`, JSON.stringify({ summary, data: data.map(({ update_id, ...x }) => ({ correlation_id: update_id, ...x, id: undefined })) }, null, 1));
