// Genera contracts/openapi.yaml a partir de los esquemas de las rutas (fuente única de verdad).
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { stringify } from 'yaml';
import { buildApp } from './app.js';
import type { Config } from './config/env.js';
import type { Pool } from './db/pool.js';

const cfg: Config = {
  databaseUrl: 'postgres://unused', port: 0, logLevel: 'silent', liveEvents: false, businessTimezone: 'America/Santo_Domingo',
  intentTtlSeconds: 600, patientSessionTtlHours: 12, corsAllowedOrigins: [], dbPoolMax: 2,
  ollamaUrl: 'http://ollama:11434', ollamaModel: 'qwen3:1.7b', llmTimeoutMs: 45000, llmProvider: 'ollama', llmApiBase: 'https://api.groq.com/openai/v1', llmApiModel: 'llama-3.3-70b-versatile', llmFallback: true, internalApiUrl: 'http://api:8080/api/v1', llmConverseEnabled: false, guestAbandonedAfterDays: 30, guestSessionRetentionDays: 7, conversationLeaseSeconds: 120, adminSessionTtlHours: 8, cookieSecure: false, offerWindowSeconds: 3600, offersDemoMode: false, reminderLeadHours: [24, 1], guestSessionTtlDays: 30, recoveryCodeTtlDays: 180,
};
export const OPENAPI_PATH = resolve(import.meta.dirname, '../../../contracts/openapi.yaml');
const HEADER = '# GENERADO por apps/api/src/openapi-export.ts — no editar a mano. Regenerar: npm run openapi:export\n';

export async function renderOpenApi(): Promise<string> {
  const app = await buildApp(cfg, {} as Pool, { logger: false });
  await app.ready();
  const doc = HEADER + stringify(app.swagger(), { lineWidth: 0 });
  await app.close();
  return doc;
}

if (process.argv[1] && import.meta.filename === resolve(process.argv[1])) {
  writeFileSync(OPENAPI_PATH, await renderOpenApi());
  console.log(`OpenAPI escrito en ${OPENAPI_PATH}`);
}
