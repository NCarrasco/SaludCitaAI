// Evaluación del modelo local como intérprete (intención + entidades) con la batería tests/conversation/cases.json.
// Usa exactamente el mismo prompt (buildOllamaRequest) y validador (parseInterpretation) que la API.
//
// Uso (desde apps/api, con el Compose levantado y --profile ai):
//   npx tsx eval/interpretation.ts qwen3:1.7b [otro-modelo ...]
// Variables: OLLAMA_EVAL_URL (por defecto http://127.0.0.1:11434), EVAL_OUT_DIR.

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';
import { matchSpecialty } from '../src/modules/conversation/engine.js';
import { resolveDate } from '../src/modules/conversation/dates.js';
import { PROMPT_VERSION, buildOllamaRequest, parseInterpretation, type InterpretationT } from '../src/modules/conversation/llm.js';
import { testDatabaseUrl } from '../test/helpers/env.js';

const ROOT = resolve(import.meta.dirname, '../../..');
const OLLAMA = process.env.OLLAMA_EVAL_URL ?? 'http://127.0.0.1:11434';
const OUT = process.env.EVAL_OUT_DIR ?? resolve(ROOT, 'docs/evidencias/entrega-2');
const TZ = 'America/Santo_Domingo';
const ACTIONABLE = new Set(['book', 'cancel', 'reschedule', 'select_option', 'affirm']);

interface Case {
  id: string; text: string; operation: string; clarity: string; specialty_label: string;
  context: { step: string; options_offered: number };
  expected: { intent: string; specialty: string | null; date_phrase: string | null; time_of_day: string | null;
              option_number: number | null; booking_reference: string | null };
}

function sameDate(a: string | null, b: string | null, now: Date): boolean {
  const ra = resolveDate(a ?? '', now, TZ);
  const rb = resolveDate(b ?? '', now, TZ);
  if (ra.kind !== rb.kind) return false;
  if (ra.kind === 'range' && rb.kind === 'range') return ra.range.from === rb.range.from && ra.range.to === rb.range.to;
  if (ra.kind === 'ambiguous' && rb.kind === 'ambiguous') return ra.choices.map((c) => c.from).join() === rb.choices.map((c) => c.from).join();
  return true;
}

function memSample(): Record<string, number> {
  try {
    const out = execFileSync('docker', ['stats', '--no-stream', '--format', '{{.Name}};{{.MemUsage}}'], { encoding: 'utf8' });
    const res: Record<string, number> = {};
    for (const line of out.trim().split('\n')) {
      const [name, usage] = line.split(';');
      if (!name?.startsWith('saludcita-')) continue;
      const m = usage!.split('/')[0]!.trim().match(/([\d.]+)\s*([KMG]i?B)/);
      if (!m) continue;
      const mult = { KiB: 1 / 1024, KB: 1 / 1024, MiB: 1, MB: 1, GiB: 1024, GB: 1024 }[m[2]!] ?? 1;
      res[name.replace('saludcita-', '').replace(/-1$/, '')] = Math.round(Number(m[1]) * mult);
    }
    return res;
  } catch { return {}; }
}

async function chat(body: object, timeoutMs = 180_000) {
  const t0 = performance.now();
  const r = await fetch(`${OLLAMA}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  const json = await r.json() as any;
  return { wallMs: Math.round(performance.now() - t0), status: r.status, json };
}

const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? 0; };

async function main() {
  const models = process.argv.slice(2);
  if (!models.length) throw new Error('Indica uno o más modelos, p. ej.: qwen3:1.7b');
  const file = process.env.EVAL_BATTERY ?? 'cases.json';
  const battery = JSON.parse(readFileSync(resolve(ROOT, 'tests/conversation', file), 'utf8')) as { version: string; cases: Case[] };
  const db = new pg.Client({ connectionString: testDatabaseUrl().replace(/\/saludcita_test$/, '/saludcita') });
  await db.connect();
  const specialties = (await db.query('SELECT id, name FROM specialties WHERE active ORDER BY name')).rows;
  await db.end();
  const version = (await (await fetch(`${OLLAMA}/api/version`)).json() as { version: string }).version;
  mkdirSync(OUT, { recursive: true });

  for (const model of models) {
    const think = model.startsWith('qwen3') ? false : undefined;
    // Descarga otros modelos de memoria para medir este en aislamiento
    for (const other of models.filter((m) => m !== model)) {
      await fetch(`${OLLAMA}/api/generate`, { method: 'POST', body: JSON.stringify({ model: other, keep_alive: 0 }) }).catch(() => undefined);
    }
    const memBefore = memSample();
    const now = new Date();
    const warm = await chat(buildOllamaRequest(model, 'hola', { step: 'idle', optionsOffered: 0, specialties: specialties.map((s) => s.name), history: [] }, { think }));
    const memLoaded = memSample();
    const results: any[] = [];
    let peakOllama = memLoaded.ollama ?? 0;
    for (const c of battery.cases) {
      const req = buildOllamaRequest(model, c.text, { step: c.context.step, optionsOffered: c.context.options_offered,
        specialties: specialties.map((s) => s.name), history: [] }, { think });
      let res; let error: string | null = null;
      try { res = await chat(req); } catch (e) { error = (e as Error).message; }
      const content = res?.json?.message?.content;
      const parsed = res && res.status === 200 ? parseInterpretation(content) : { ok: false as const, error: error ?? `HTTP ${res?.status}` };
      const v = parsed.ok ? parsed.value : null;
      const e = c.expected;
      const spGot = v ? matchSpecialty(v.specialty, specialties)?.name ?? null : null;
      const checks = v ? {
        intent: v.intent === e.intent,
        specialty: spGot === e.specialty,
        date: sameDate(v.date_phrase, e.date_phrase, now),
        time_of_day: v.time_of_day === e.time_of_day,
        option_number: e.option_number === null ? true : v.option_number === e.option_number,
        booking_reference: e.booking_reference === null ? true : v.booking_reference === e.booking_reference,
      } : null;
      const unsafe = Boolean(v && (c.operation === 'out_of_scope' || c.operation === 'clinical') && ACTIONABLE.has(v.intent));
      const m = memSample();
      peakOllama = Math.max(peakOllama, m.ollama ?? 0);
      results.push({
        id: c.id, operation: c.operation, clarity: c.clarity, specialty: c.specialty_label, text: c.text,
        schema_valid: parsed.ok, parse_error: parsed.ok ? null : parsed.error, got: v as InterpretationT | null, expected: e,
        checks, all_ok: Boolean(checks && Object.values(checks).every(Boolean)), unsafe_action: unsafe,
        latency_ms: res?.wallMs ?? null, prompt_tokens: res?.json?.prompt_eval_count ?? null, completion_tokens: res?.json?.eval_count ?? null,
      });
      process.stdout.write(`${model} ${c.id} ${results.at(-1)!.all_ok ? 'OK ' : 'ERR'} ${res?.wallMs ?? '-'} ms\n`);
    }
    const lat = results.map((r) => r.latency_ms ?? 0);
    const group = (key: 'operation' | 'clarity' | 'specialty') => {
      const g: Record<string, { n: number; all_ok: number; intent_ok: number }> = {};
      for (const r of results) {
        const k = r[key];
        g[k] ??= { n: 0, all_ok: 0, intent_ok: 0 };
        g[k].n++; if (r.all_ok) g[k].all_ok++; if (r.checks?.intent) g[k].intent_ok++;
      }
      return g;
    };
    const summary = {
      model, ollama_version: version, prompt_version: PROMPT_VERSION, battery_version: battery.version, executed_at: now.toISOString(),
      environment: { docker_cpus: Number(execFileSync('docker', ['info', '--format', '{{.NCPU}}'], { encoding: 'utf8' }).trim()),
                     docker_mem_gib: Math.round(Number(execFileSync('docker', ['info', '--format', '{{.MemTotal}}'], { encoding: 'utf8' }).trim()) / 2 ** 30 * 10) / 10,
                     host: `${process.platform}/${process.arch}`, gpu_in_docker: false },
      n: results.length,
      schema_valid: results.filter((r) => r.schema_valid).length,
      intent_ok: results.filter((r) => r.checks?.intent).length,
      all_fields_ok: results.filter((r) => r.all_ok).length,
      unsafe_actions: results.filter((r) => r.unsafe_action).length,
      cold_start_ms: warm.wallMs,
      latency_ms: { p50: pct(lat, 0.5), p90: pct(lat, 0.9), max: Math.max(...lat), mean: Math.round(lat.reduce((a, b) => a + b, 0) / lat.length) },
      memory_mib: { before_load: memBefore, after_load: memLoaded, ollama_peak: peakOllama,
                    all_services_after_load: Object.values(memLoaded).reduce((a, b) => a + b, 0) },
      by_operation: group('operation'), by_clarity: group('clarity'), by_specialty: group('specialty'),
    };
    const file = resolve(OUT, `eval-interpretacion-${battery.version}-${model.replace(/[:/]/g, '_')}.json`);
    writeFileSync(file, JSON.stringify({ summary, results }, null, 1));
    console.log(JSON.stringify({ ...summary, by_operation: undefined, by_clarity: undefined, by_specialty: undefined }, null, 1));
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
