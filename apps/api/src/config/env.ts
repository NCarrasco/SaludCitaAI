// Configuración leída del entorno; falla al arrancar si falta algo obligatorio.
function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Falta la variable de entorno ${name}`);
  return v;
}

function int(name: string, def: number, min: number, max: number): number {
  const raw = process.env[name];
  const v = raw === undefined || raw === '' ? def : Number(raw);
  if (!Number.isInteger(v) || v < min || v > max) throw new Error(`${name} debe ser un entero entre ${min} y ${max}`);
  return v;
}

export interface Config {
  databaseUrl: string;
  port: number;
  logLevel: string;
  liveEvents: boolean;
  liveHeartbeatMs?: number;
  businessTimezone: string;
  intentTtlSeconds: number;
  patientSessionTtlHours: number;
  corsAllowedOrigins: string[];
  dbPoolMax: number;
  ollamaUrl: string;
  ollamaModel: string;
  ollamaThink?: boolean;
  llmTimeoutMs: number;
  /** ollama (por defecto) u openai (cualquier API compatible: Groq, OpenAI…). La clave solo vive en la API. */
  llmProvider: 'ollama' | 'openai';
  llmApiBase: string;
  llmApiModel: string;
  llmApiKey?: string;
  /** Con LLM_PROVIDER=openai: si el proveedor falla, usar el modelo local (Ollama, OLLAMA_MODEL). LLM_FALLBACK=none lo desactiva. */
  llmFallback: boolean;
  /** URL interna de la API vista desde n8n (para la pasarela de modelos) */
  internalApiUrl: string;
  llmConverseEnabled: boolean;
  guestAbandonedAfterDays: number;
  guestSessionRetentionDays: number;
  conversationLeaseSeconds: number;
  n8nWebhookUrl?: string;
  n8nWebhookSecret?: string;
  n8nCommandsWebhookUrl?: string;
  adminSessionTtlHours: number;
  cookieSecure: boolean;
  panelDir?: string;
  offerWindowSeconds: number;
  offersDemoMode: boolean;
  reminderLeadHours: number[];
  guestSessionTtlDays: number;
  recoveryCodeTtlDays: number;
}

export function loadConfig(): Config {
  return {
    databaseUrl: required('DATABASE_URL'),
    port: int('PORT', 8080, 1, 65535),
    logLevel: process.env.LOG_LEVEL ?? 'info',
    liveEvents: process.env.LIVE_EVENTS !== 'false',
    businessTimezone: process.env.BUSINESS_TIMEZONE ?? 'America/Santo_Domingo',
    intentTtlSeconds: int('INTENT_TTL_SECONDS', 600, 30, 3600),
    patientSessionTtlHours: int('PATIENT_SESSION_TTL_HOURS', 12, 1, 168),
    corsAllowedOrigins: (process.env.CORS_ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    dbPoolMax: int('DB_POOL_MAX', 25, 2, 100),
    ollamaUrl: process.env.OLLAMA_URL || 'http://ollama:11434',
    ollamaModel: process.env.OLLAMA_MODEL || 'qwen3:1.7b',
    ollamaThink: process.env.OLLAMA_THINK === undefined || process.env.OLLAMA_THINK === '' ? undefined : process.env.OLLAMA_THINK === 'true',
    llmTimeoutMs: int('LLM_TIMEOUT_MS', 45000, 1000, 300000),
    llmProvider: process.env.LLM_PROVIDER === 'openai' ? 'openai' : 'ollama',
    llmApiBase: process.env.LLM_API_BASE || 'https://api.groq.com/openai/v1',
    llmApiModel: process.env.LLM_API_MODEL || 'llama-3.3-70b-versatile',
    llmApiKey: process.env.LLM_API_KEY || undefined,
    llmFallback: (process.env.LLM_FALLBACK ?? 'ollama') !== 'none',
    internalApiUrl: process.env.INTERNAL_API_URL || 'http://api:8080/api/v1',
    llmConverseEnabled: (process.env.LLM_CONVERSE_ENABLED ?? 'true') === 'true',
    guestAbandonedAfterDays: int('GUEST_ABANDONED_AFTER_DAYS', 30, 1, 3650),
    guestSessionRetentionDays: int('GUEST_SESSION_RETENTION_DAYS', 7, 0, 365),
    conversationLeaseSeconds: int('CONVERSATION_LEASE_SECONDS', 120, 10, 900),
    n8nWebhookUrl: process.env.N8N_CONVERSATION_WEBHOOK_URL || undefined,
    n8nWebhookSecret: process.env.N8N_WEBHOOK_SECRET || undefined,
    n8nCommandsWebhookUrl: process.env.N8N_COMMANDS_WEBHOOK_URL || undefined,
    adminSessionTtlHours: int('ADMIN_SESSION_TTL_HOURS', 8, 1, 72),
    // Solo false en desarrollo local por http; en el despliegue con HTTPS debe ser true
    cookieSecure: process.env.COOKIE_SECURE === 'true',
    panelDir: process.env.PANEL_DIR || undefined,
    // Ventana normal de una hora; el modo demo la reduce y queda registrado en cada ronda y en el aviso
    offersDemoMode: process.env.OFFERS_DEMO_MODE === 'true',
    offerWindowSeconds: process.env.OFFERS_DEMO_MODE === 'true'
      ? int('OFFER_DEMO_WINDOW_SECONDS', 120, 30, 3600) : int('OFFER_WINDOW_SECONDS', 3600, 300, 86400),
    reminderLeadHours: [24, 1],
    guestSessionTtlDays: int('GUEST_SESSION_TTL_DAYS', 30, 1, 365),
    recoveryCodeTtlDays: int('RECOVERY_CODE_TTL_DAYS', 180, 1, 730),
  };
}
