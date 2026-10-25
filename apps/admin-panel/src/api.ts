// Cliente de la API. El panel se sirve desde el mismo origen: las cookies viajan solas
// (sesión HttpOnly) y las escrituras añaden X-CSRF-Token leído de la cookie legible sc_csrf.
// No hay tokens ni secretos en el código del navegador.

export const API = '/api/v1';

export type Role = 'viewer' | 'operator' | 'admin';
export interface AdminUser { id: string; email: string; display_name: string | null; role: Role }

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public requestId?: string, public details?: Record<string, unknown>) {
    super(message);
  }
}

let onUnauthorized: () => void = () => undefined;
export function setUnauthorizedHandler(fn: () => void) { onUnauthorized = fn; }

function csrfToken(): string | undefined {
  return document.cookie.split('; ').find((c) => c.startsWith('sc_csrf='))?.slice('sc_csrf='.length);
}

export async function api<T>(path: string, init: { method?: string; body?: unknown; idempotencyKey?: string; signal?: AbortSignal } = {}): Promise<T> {
  const method = init.method ?? 'GET';
  const headers: Record<string, string> = {};
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET') {
    const csrf = csrfToken();
    if (csrf) headers['x-csrf-token'] = decodeURIComponent(csrf);
  }
  if (init.idempotencyKey) headers['idempotency-key'] = init.idempotencyKey;
  let res: Response;
  try {
    res = await fetch(`${API}${path}`, { method, headers, credentials: 'same-origin', signal: init.signal,
      body: init.body === undefined ? undefined : JSON.stringify(init.body) });
  } catch (e) {
    if (init.signal?.aborted) throw e;
    throw new ApiError(0, 'network', 'No se pudo contactar con la API. Comprueba que el servicio está activo.');
  }
  if (res.status === 204) return undefined as T;
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const err = json?.error ?? {};
    if (res.status === 401 && path !== '/auth/login') onUnauthorized();
    throw new ApiError(res.status, err.code ?? 'error', err.message ?? `Error ${res.status}`, json?.request_id, err.details);
  }
  return json as T;
}

export const qs = (params: Record<string, string | number | boolean | null | undefined>) => {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') u.set(k, String(v));
  const s = u.toString();
  return s ? `?${s}` : '';
};

// --- Tipos de respuesta usados por el panel ---
export interface Envelope<T> { filters: Record<string, string | null>; timezone: string; generated_at: string; definitions: Record<string, string>; data: T }
export interface Summary {
  searches: number;
  operations: { bookings: number; cancellations: number; reschedules: number; advances: number };
  agenda_by_status: { booked: number; cancelled: number; completed: number; no_show: number };
  occupancy: { occupied: number; enabled: number; rate: number | null; held_by_offer: number; blocked: number };
  attendance: { completed: number; no_show: number; unmarked: number; rate: number | null };
}
export interface Day { date: string; searches: number; bookings: number; cancellations: number; reschedules: number; advances: number;
  slots_enabled: number; slots_occupied: number; occupancy_rate: number | null }
export interface Group { id: string; name: string; bookings: number; cancellations: number; reschedules: number; advances: number;
  slots_enabled: number; slots_occupied: number; occupancy_rate: number | null; completed: number; no_show: number; attendance_rate: number | null }
export interface Bucket { weekday: number; hour: number; enabled: number; occupied: number; held_by_offer: number; rate: number | null }
export interface Offers { offers_by_status: Record<string, number>; acceptance_rate: number | null; rounds_by_status: Record<string, number>;
  advance_minutes: { n: number; mean: number | null; median: number | null };
  recovery: { recovered_slots: number; freed_eligible_slots: number; rate: number | null } }
export interface Conversation { replies: number; by_mode: Record<string, number>; clarifications: number; llm_errors: number;
  ai_by_intent: Record<string, number>; handoffs: number; model_latency_ms: { n: number; p50: number | null; p90: number | null };
  tokens: { prompt: number; completion: number } }
export interface Catalog {
  centers: { id: string; name: string; address: string | null; timezone: string; active: boolean; phone: string | null; email: string | null;
    info_notes: string | null; accepted_insurers: string[] | null; payment_methods: string[] | null }[];
  specialties: { id: string; name: string; active: boolean }[];
  doctors: { id: string; display_name: string; active: boolean }[];
  services: { id: string; doctor_id: string; center_id: string; specialty_id: string; consultation_kind: string; slot_minutes: number;
    booking_horizon_days: number; min_notice_minutes: number; patient_instructions: string | null; active: boolean; price_dop: number | null }[];
}
export interface ScheduleConflict { appointment_id: string; booking_reference: string; label: string; doctor: string; patient_name: string | null; reason: string }
export interface ScheduleImpact { blocked_free_slots: number; reopened_slots: number; generated_slots: number; conflicts: ScheduleConflict[] }

// --- Portada operativa ---
export interface DashAppt { starts_at: string; label: string; status: string; doctor: string; specialty: string; id?: string; reference?: string; patient?: string | null }
export interface Dashboard {
  generated_at: string; timezone: string; today: string; date: string; is_today: boolean; scope: 'full' | 'aggregate';
  kpis: { today_total: number; today_remaining: number; today_completed: number; today_no_show: number; today_unmarked: number; today_cancelled: number;
    slots_enabled_today: number; slots_occupied_today: number; slots_free_remaining_today: number; pending_offers: number;
    operations_today: { booked: number; cancelled: number; rescheduled: number; advanced: number } };
  /** Mismo día de la semana anterior; operaciones hasta la misma hora si la fecha es hoy */
  compare: { date: string; same_time: boolean; agenda_total: number; booked: number; cancelled: number };
  next: DashAppt | null;
  agenda_today?: DashAppt[];
  agenda_today_by_hour: { hour: string; total: number; completed: number; no_show: number; pending: number }[];
  upcoming?: DashAppt[];
  upcoming_by_day: { date: string; n: number }[];
  activity: { kind: string; occurred_at: string; specialty: string; doctor: string; from_label: string | null; to_label: string | null;
    from_at: string | null; to_at: string | null;
    id?: string; reference?: string; patient?: string | null }[];
  handoffs: { open: number; oldest_at: string | null; items?: { id: string; reference: string | null; reason: string; created_at: string; patient: string | null }[] };
  availability_7d: { specialty: string; free: number; occupied: number; held: number; enabled: number }[];
  alerts: { code: string; severity: 'warn' | 'bad'; count: number; text: string; action: { label: string; page: string; params: Record<string, string> } | null }[];
}
