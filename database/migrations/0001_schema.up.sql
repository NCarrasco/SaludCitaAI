-- SaludCita AI · esquema inicial
-- Fuente: docs/especificacion-sistema.md §4 y docs/referencias-y-viabilidad.md.
-- Cambios respecto al diseño documentados en docs/decisiones-implementacion.md.

CREATE EXTENSION IF NOT EXISTS btree_gist;

-- Actualiza updated_at en entidades mutables
CREATE FUNCTION set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

-- Impide UPDATE/DELETE en tablas de historial
CREATE FUNCTION forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'la tabla % es de solo inserción', TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END $$;

-- ---------------------------------------------------------------------------
-- Catálogos
-- ---------------------------------------------------------------------------
CREATE TABLE centers (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  address     text CHECK (address IS NULL OR length(address) <= 300),
  timezone    text NOT NULL DEFAULT 'America/Santo_Domingo',
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE specialties (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL UNIQUE CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE doctors (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name  text NOT NULL CHECK (length(btrim(display_name)) BETWEEN 1 AND 160),
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE doctor_services (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  doctor_id             uuid NOT NULL REFERENCES doctors(id) ON DELETE RESTRICT,
  center_id             uuid NOT NULL REFERENCES centers(id) ON DELETE RESTRICT,
  specialty_id          uuid NOT NULL REFERENCES specialties(id) ON DELETE RESTRICT,
  consultation_kind     text NOT NULL DEFAULT 'initial' CHECK (consultation_kind IN ('initial','follow_up')),
  slot_minutes          integer NOT NULL CHECK (slot_minutes BETWEEN 5 AND 240),
  patient_instructions  text CHECK (patient_instructions IS NULL OR length(patient_instructions) <= 500),
  booking_horizon_days  integer NOT NULL DEFAULT 30 CHECK (booking_horizon_days BETWEEN 1 AND 365),
  min_notice_minutes    integer NOT NULL DEFAULT 0 CHECK (min_notice_minutes >= 0),
  active                boolean NOT NULL DEFAULT true,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (doctor_id, center_id, specialty_id, consultation_kind),
  -- objetivo del FK compuesto de slots: garantiza que el médico corresponde al servicio
  UNIQUE (id, doctor_id)
);
CREATE INDEX doctor_services_center_idx ON doctor_services(center_id);
CREATE INDEX doctor_services_specialty_idx ON doctor_services(specialty_id);

CREATE TABLE schedule_rules (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  doctor_service_id  uuid NOT NULL REFERENCES doctor_services(id) ON DELETE RESTRICT,
  weekday            smallint NOT NULL CHECK (weekday BETWEEN 1 AND 7), -- ISO: 1 = lunes
  local_start        time NOT NULL,
  local_end          time NOT NULL,
  valid_from         date NOT NULL,
  valid_until        date,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (local_start < local_end),
  CHECK (valid_until IS NULL OR valid_until >= valid_from)
);
CREATE INDEX schedule_rules_service_idx ON schedule_rules(doctor_service_id);

CREATE TABLE schedule_exceptions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  doctor_id   uuid NOT NULL REFERENCES doctors(id) ON DELETE RESTRICT,
  starts_at   timestamptz NOT NULL,
  ends_at     timestamptz NOT NULL,
  reason      text NOT NULL CHECK (reason IN ('absence','holiday','training','other')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (starts_at < ends_at)
);
CREATE INDEX schedule_exceptions_doctor_idx ON schedule_exceptions USING gist (doctor_id, tstzrange(starts_at, ends_at));

CREATE TABLE slots (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  doctor_service_id  uuid NOT NULL,
  doctor_id          uuid NOT NULL,
  starts_at          timestamptz NOT NULL,
  ends_at            timestamptz NOT NULL,
  status             text NOT NULL DEFAULT 'open' CHECK (status IN ('open','blocked')),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (starts_at < ends_at),
  FOREIGN KEY (doctor_service_id, doctor_id) REFERENCES doctor_services(id, doctor_id) ON DELETE RESTRICT,
  UNIQUE (doctor_service_id, starts_at),
  -- Un médico no tiene dos slots abiertos solapados en ninguno de sus servicios.
  -- Los bloqueados conservan historia y no participan.
  CONSTRAINT slots_no_overlap EXCLUDE USING gist (
    doctor_id WITH =, tstzrange(starts_at, ends_at, '[)') WITH &&
  ) WHERE (status = 'open')
);
CREATE INDEX slots_service_start_idx ON slots(doctor_service_id, starts_at);
CREATE INDEX slots_start_idx ON slots(starts_at);

-- Los instantes de un slot son inmutables: las citas copian sus tiempos.
CREATE FUNCTION slots_immutable_times() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.starts_at <> OLD.starts_at OR NEW.ends_at <> OLD.ends_at
     OR NEW.doctor_id <> OLD.doctor_id OR NEW.doctor_service_id <> OLD.doctor_service_id THEN
    RAISE EXCEPTION 'los tiempos y el servicio de un slot no se modifican; bloquéalo y crea otro'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER slots_immutable BEFORE UPDATE ON slots FOR EACH ROW EXECUTE FUNCTION slots_immutable_times();

-- ---------------------------------------------------------------------------
-- Pacientes e identidad
-- ---------------------------------------------------------------------------
CREATE TABLE patients (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name   text CHECK (full_name IS NULL OR length(btrim(full_name)) BETWEEN 1 AND 160),
  birth_date  date CHECK (birth_date IS NULL OR birth_date >= DATE '1900-01-01'), -- no futura: validado en API
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE patient_accounts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id     uuid NOT NULL UNIQUE REFERENCES patients(id) ON DELETE RESTRICT,
  username       text NOT NULL UNIQUE CHECK (username = lower(username) AND username ~ '^[a-z0-9._-]{3,40}$'),
  password_hash  text NOT NULL,
  active         boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE patient_sessions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  uuid NOT NULL REFERENCES patient_accounts(id) ON DELETE RESTRICT,
  token_hash  bytea NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX patient_sessions_account_idx ON patient_sessions(account_id);

CREATE TABLE channel_identities (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id        uuid NOT NULL REFERENCES patients(id) ON DELETE RESTRICT,
  channel           text NOT NULL CHECK (channel IN ('gradio')),
  external_user_id  text NOT NULL CHECK (length(external_user_id) BETWEEN 1 AND 200),
  external_chat_id  text CHECK (external_chat_id IS NULL OR length(external_chat_id) <= 200),
  active            boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (channel, external_user_id)
);
CREATE INDEX channel_identities_patient_idx ON channel_identities(patient_id);

-- ---------------------------------------------------------------------------
-- Citas e historial
-- ---------------------------------------------------------------------------
CREATE TABLE appointments (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_reference         text NOT NULL UNIQUE CHECK (booking_reference ~ '^SC-[A-Z2-9]{6}$'),
  patient_id                uuid NOT NULL REFERENCES patients(id) ON DELETE RESTRICT,
  slot_id                   uuid NOT NULL REFERENCES slots(id) ON DELETE RESTRICT,
  -- Copia del intervalo del slot vigente (mantenida por trigger) para la exclusión por paciente
  starts_at                 timestamptz NOT NULL,
  ends_at                   timestamptz NOT NULL,
  status                    text NOT NULL DEFAULT 'booked' CHECK (status IN ('booked','cancelled','completed','no_show')),
  version                   integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  advance_opt_in            boolean NOT NULL DEFAULT false,
  source_channel            text NOT NULL CHECK (source_channel IN ('gradio','api','operator','seed')),
  booked_at                 timestamptz NOT NULL DEFAULT now(),
  cancelled_at              timestamptz,
  cancellation_reason_code  text CHECK (cancellation_reason_code IN ('patient_request','provider_unavailable','scheduling_error','other')),
  cancelled_by_type         text CHECK (cancelled_by_type IN ('patient','operator','system')),
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  CHECK (starts_at < ends_at),
  CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL)),
  CHECK ((status = 'cancelled') = (cancelled_by_type IS NOT NULL)),
  CHECK (status = 'cancelled' OR cancellation_reason_code IS NULL),
  -- Un paciente no tiene dos citas activas solapadas (cualquier médico)
  CONSTRAINT appointments_patient_no_overlap EXCLUDE USING gist (
    patient_id WITH =, tstzrange(starts_at, ends_at, '[)') WITH &&
  ) WHERE (status = 'booked')
);
-- Una sola cita ocupante por slot; las canceladas conservan historia y liberan ocupación
CREATE UNIQUE INDEX appointments_slot_occupied_uq ON appointments(slot_id)
  WHERE status IN ('booked','completed','no_show');
CREATE INDEX appointments_patient_idx ON appointments(patient_id, starts_at);
CREATE INDEX appointments_slot_idx ON appointments(slot_id);
CREATE INDEX appointments_starts_idx ON appointments(starts_at);

CREATE FUNCTION appointments_copy_slot_times() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.slot_id <> OLD.slot_id THEN
    SELECT starts_at, ends_at INTO NEW.starts_at, NEW.ends_at FROM slots WHERE id = NEW.slot_id;
  ELSIF NEW.starts_at <> OLD.starts_at OR NEW.ends_at <> OLD.ends_at THEN
    RAISE EXCEPTION 'starts_at/ends_at se derivan del slot' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER appointments_slot_times BEFORE INSERT OR UPDATE ON appointments
  FOR EACH ROW EXECUTE FUNCTION appointments_copy_slot_times();

CREATE TABLE appointment_events (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  appointment_id     uuid NOT NULL REFERENCES appointments(id) ON DELETE RESTRICT,
  event_type         text NOT NULL CHECK (event_type IN ('booked','cancelled','rescheduled','advanced','completed','no_show')),
  appointment_version integer NOT NULL,
  from_slot_id       uuid REFERENCES slots(id) ON DELETE RESTRICT,
  to_slot_id         uuid REFERENCES slots(id) ON DELETE RESTRICT,
  from_starts_at     timestamptz,
  to_starts_at       timestamptz,
  status_before      text,
  status_after       text NOT NULL,
  reason_code        text,
  actor_type         text NOT NULL CHECK (actor_type IN ('patient','operator','system','service')),
  actor_id           text,
  occurred_at        timestamptz NOT NULL DEFAULT now(),
  correlation_id     uuid
);
CREATE INDEX appointment_events_appt_idx ON appointment_events(appointment_id, occurred_at);
CREATE INDEX appointment_events_time_idx ON appointment_events(occurred_at);
CREATE TRIGGER appointment_events_immutable BEFORE UPDATE OR DELETE ON appointment_events
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------------------
-- Ofertas de adelanto (lógica en entrega 4)
-- ---------------------------------------------------------------------------
CREATE TABLE offer_rounds (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slot_id          uuid NOT NULL REFERENCES slots(id) ON DELETE RESTRICT,
  parent_round_id  uuid REFERENCES offer_rounds(id) ON DELETE RESTRICT,
  trigger_event    text NOT NULL CHECK (trigger_event IN ('cancelled','rescheduled','advanced')),
  window_seconds   integer NOT NULL CHECK (window_seconds > 0),
  demo_mode        boolean NOT NULL DEFAULT false,
  status           text NOT NULL DEFAULT 'open' CHECK (status IN ('open','completed','exhausted','closed')),
  close_reason     text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  closed_at        timestamptz,
  CHECK ((status = 'open') = (closed_at IS NULL))
);
CREATE UNIQUE INDEX offer_rounds_one_open_per_slot ON offer_rounds(slot_id) WHERE status = 'open';
CREATE INDEX offer_rounds_parent_idx ON offer_rounds(parent_round_id);

CREATE TABLE advance_offers (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  round_id             uuid NOT NULL REFERENCES offer_rounds(id) ON DELETE RESTRICT,
  appointment_id       uuid NOT NULL REFERENCES appointments(id) ON DELETE RESTRICT,
  original_slot_id     uuid NOT NULL REFERENCES slots(id) ON DELETE RESTRICT,
  appointment_version  integer NOT NULL,
  candidate_rank       integer NOT NULL CHECK (candidate_rank >= 1),
  status               text NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending','accepted','rejected','expired','invalidated','delivery_failed')),
  token_hash           bytea NOT NULL UNIQUE,
  offered_at           timestamptz NOT NULL DEFAULT now(),
  expires_at           timestamptz NOT NULL,
  responded_at         timestamptz,
  close_reason         text,
  CHECK (offered_at < expires_at),
  CHECK ((status = 'pending') = (responded_at IS NULL)),
  UNIQUE (round_id, appointment_id)
);
CREATE UNIQUE INDEX advance_offers_one_pending_per_round ON advance_offers(round_id) WHERE status = 'pending';
CREATE UNIQUE INDEX advance_offers_one_pending_per_appt ON advance_offers(appointment_id) WHERE status = 'pending';
CREATE INDEX advance_offers_expiry_idx ON advance_offers(expires_at) WHERE status = 'pending';

-- ---------------------------------------------------------------------------
-- Conversación (entrega 2)
-- ---------------------------------------------------------------------------
CREATE TABLE conversations (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_identity_id  uuid NOT NULL UNIQUE REFERENCES channel_identities(id) ON DELETE RESTRICT,
  state                jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(state) = 'object'),
  summary              text CHECK (summary IS NULL OR length(summary) <= 4000),
  version              integer NOT NULL DEFAULT 1,
  lease_until          timestamptz,
  lease_token          uuid,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE messages (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id      uuid NOT NULL REFERENCES conversations(id) ON DELETE RESTRICT,
  direction            text NOT NULL CHECK (direction IN ('inbound','outbound')),
  provider_message_id  text,
  content              text NOT NULL CHECK (length(content) <= 8000),
  intent               text,
  model                text,
  prompt_tokens        integer CHECK (prompt_tokens >= 0),
  completion_tokens    integer CHECK (completion_tokens >= 0),
  latency_ms           integer CHECK (latency_ms >= 0),
  created_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX messages_conversation_idx ON messages(conversation_id, created_at);

CREATE TABLE action_intents (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id           uuid NOT NULL REFERENCES patients(id) ON DELETE RESTRICT,
  conversation_id      uuid REFERENCES conversations(id) ON DELETE RESTRICT,
  kind                 text NOT NULL CHECK (kind IN ('booking','cancellation','reschedule')),
  payload              jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  appointment_id       uuid REFERENCES appointments(id) ON DELETE RESTRICT,
  appointment_version  integer,
  slot_id              uuid REFERENCES slots(id) ON DELETE RESTRICT,
  token_hash           bytea NOT NULL UNIQUE,
  expires_at           timestamptz NOT NULL,
  status               text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','consumed','expired','invalidated')),
  result               jsonb,
  consumed_at          timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  CHECK (kind = 'booking' OR (appointment_id IS NOT NULL AND appointment_version IS NOT NULL)),
  CHECK (kind = 'cancellation' OR slot_id IS NOT NULL),
  CHECK ((status = 'consumed') = (consumed_at IS NOT NULL))
);
CREATE INDEX action_intents_patient_pending_idx ON action_intents(patient_id) WHERE status = 'pending';

CREATE TABLE inbound_updates (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel             text NOT NULL CHECK (channel IN ('gradio')),
  external_update_id  text NOT NULL CHECK (length(external_update_id) BETWEEN 1 AND 200),
  patient_id          uuid NOT NULL REFERENCES patients(id) ON DELETE RESTRICT,
  conversation_id     uuid REFERENCES conversations(id) ON DELETE RESTRICT,
  payload             jsonb NOT NULL,
  status              text NOT NULL DEFAULT 'received' CHECK (status IN ('received','processing','done','failed','dead')),
  attempts            integer NOT NULL DEFAULT 0,
  lease_until         timestamptz,
  lease_token         uuid,
  last_error          text,
  result              jsonb,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (channel, external_update_id)
);
CREATE INDEX inbound_updates_claim_idx ON inbound_updates(created_at) WHERE status IN ('received','processing');

-- ---------------------------------------------------------------------------
-- Cola durable, avisos y calendario
-- ---------------------------------------------------------------------------
CREATE TABLE outbox_jobs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind          text NOT NULL,
  aggregate_id  uuid,
  dedupe_key    text NOT NULL UNIQUE,
  payload       jsonb NOT NULL DEFAULT '{}'::jsonb,
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','leased','done','dead','cancelled')),
  available_at  timestamptz NOT NULL DEFAULT now(),
  attempts      integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts  integer NOT NULL DEFAULT 5 CHECK (max_attempts >= 1),
  lease_until   timestamptz,
  lease_token   uuid,
  last_error    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX outbox_jobs_claim_idx ON outbox_jobs(available_at) WHERE status IN ('pending','leased');
CREATE INDEX outbox_jobs_aggregate_idx ON outbox_jobs(aggregate_id);

CREATE TABLE notifications (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id           uuid NOT NULL REFERENCES patients(id) ON DELETE RESTRICT,
  appointment_id       uuid REFERENCES appointments(id) ON DELETE RESTRICT,
  offer_id             uuid REFERENCES advance_offers(id) ON DELETE RESTRICT,
  kind                 text NOT NULL CHECK (kind IN ('booking_confirmed','appointment_cancelled','appointment_rescheduled',
                                                     'reminder_24h','reminder_1h','advance_offer','advance_accepted',
                                                     'offer_expired','handoff_update')),
  title                text NOT NULL CHECK (length(title) <= 200),
  body                 text NOT NULL CHECK (length(body) <= 2000),
  dedupe_key           text NOT NULL UNIQUE,
  status               text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed','unknown')),
  provider_message_id  text,
  sent_at              timestamptz,     -- publicado en la bandeja web, no "leído"
  read_at              timestamptz,     -- lectura explícita por el paciente
  created_at           timestamptz NOT NULL DEFAULT now(),
  CHECK (read_at IS NULL OR sent_at IS NOT NULL)
);
CREATE INDEX notifications_patient_idx ON notifications(patient_id, created_at DESC);

CREATE TABLE calendar_bindings (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  doctor_id             uuid NOT NULL UNIQUE REFERENCES doctors(id) ON DELETE RESTRICT,
  provider              text NOT NULL CHECK (provider IN ('google')),
  external_calendar_id  text NOT NULL,
  enabled               boolean NOT NULL DEFAULT false,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE calendar_sync (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  appointment_id     uuid NOT NULL UNIQUE REFERENCES appointments(id) ON DELETE RESTRICT,
  binding_id         uuid REFERENCES calendar_bindings(id) ON DELETE RESTRICT,
  external_event_id  text NOT NULL,   -- determinista, generado por la API
  desired_version    integer NOT NULL,
  synced_version     integer,
  status             text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','synced','failed','disabled')),
  last_error         text,
  last_synced_at     timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (synced_version IS NULL OR synced_version <= desired_version)
);

-- ---------------------------------------------------------------------------
-- Analítica, traspasos y administración
-- ---------------------------------------------------------------------------
CREATE TABLE analytics_events (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type         text NOT NULL,
  occurred_at        timestamptz NOT NULL DEFAULT now(),
  patient_id         uuid REFERENCES patients(id) ON DELETE RESTRICT,
  doctor_service_id  uuid REFERENCES doctor_services(id) ON DELETE RESTRICT,
  appointment_id     uuid REFERENCES appointments(id) ON DELETE RESTRICT,
  correlation_id     uuid,
  dedupe_key         text NOT NULL UNIQUE,
  metadata           jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object')
);
CREATE INDEX analytics_events_type_time_idx ON analytics_events(event_type, occurred_at);
CREATE TRIGGER analytics_events_immutable BEFORE UPDATE OR DELETE ON analytics_events
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE handoff_cases (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id       uuid NOT NULL REFERENCES patients(id) ON DELETE RESTRICT,
  conversation_id  uuid REFERENCES conversations(id) ON DELETE RESTRICT,
  reason           text NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
  status           text NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
  resolved_by      uuid,
  resolved_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'resolved') = (resolved_at IS NOT NULL))
);
CREATE INDEX handoff_cases_status_idx ON handoff_cases(status, created_at);

CREATE TABLE admin_users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email          text NOT NULL UNIQUE CHECK (email = lower(email) AND position('@' in email) > 1),
  password_hash  text NOT NULL,
  role           text NOT NULL CHECK (role IN ('viewer','operator','admin')),
  active         boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE handoff_cases ADD FOREIGN KEY (resolved_by) REFERENCES admin_users(id) ON DELETE RESTRICT;

CREATE TABLE admin_sessions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_user_id  uuid NOT NULL REFERENCES admin_users(id) ON DELETE RESTRICT,
  token_hash     bytea NOT NULL UNIQUE,
  expires_at     timestamptz NOT NULL,
  revoked_at     timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX admin_sessions_user_idx ON admin_sessions(admin_user_id);

CREATE TABLE service_credentials (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text NOT NULL UNIQUE,
  secret_hash  bytea NOT NULL UNIQUE,
  scopes       text[] NOT NULL CHECK (scopes <@ ARRAY['bot','scheduler','calendar-sync']::text[] AND cardinality(scopes) > 0),
  expires_at   timestamptz,
  revoked_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE idempotency_records (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  principal_id     text NOT NULL,
  route            text NOT NULL,
  key              text NOT NULL CHECK (length(key) BETWEEN 8 AND 200),
  request_hash     text NOT NULL,
  status           text NOT NULL CHECK (status IN ('completed')),
  response_status  integer NOT NULL,
  response_body    jsonb NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL,
  UNIQUE (principal_id, route, key)
);

-- updated_at
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['centers','specialties','doctors','doctor_services','schedule_rules','slots','patients',
                           'patient_accounts','appointments','conversations','inbound_updates','outbox_jobs',
                           'calendar_bindings','calendar_sync','handoff_cases','admin_users']
  LOOP
    EXECUTE format('CREATE TRIGGER %I_updated_at BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION set_updated_at()', t, t);
  END LOOP;
END $$;
