-- Incremento A: acceso sin registro previo (sesión invitada) y recuperación segura
-- Compatible con las cuentas ficticias existentes (usuario/contraseña), sus sesiones, conversaciones y citas.

-- 1. Tipo de paciente: con cuenta de demostración o invitado (creado por el servidor sin datos)
ALTER TABLE patients ADD COLUMN kind text NOT NULL DEFAULT 'account' CHECK (kind IN ('account','guest'));
ALTER TABLE patients ADD COLUMN last_seen_at timestamptz;

-- 2. Las sesiones pertenecen al paciente; la cuenta con contraseña pasa a ser opcional
ALTER TABLE patient_sessions ADD COLUMN patient_id uuid REFERENCES patients(id) ON DELETE RESTRICT;
UPDATE patient_sessions s SET patient_id = a.patient_id FROM patient_accounts a WHERE a.id = s.account_id;
ALTER TABLE patient_sessions ALTER COLUMN patient_id SET NOT NULL;
ALTER TABLE patient_sessions ALTER COLUMN account_id DROP NOT NULL;
ALTER TABLE patient_sessions ADD COLUMN kind text NOT NULL DEFAULT 'password' CHECK (kind IN ('password','guest','recovery'));
CREATE INDEX patient_sessions_patient_idx ON patient_sessions(patient_id);

-- 3. Identidad de canal por paciente (antes por cuenta), para que la conversación siga al paciente entre dispositivos
UPDATE channel_identities SET external_user_id = 'p:' || patient_id WHERE channel = 'gradio';

-- 4. Códigos de recuperación (alta entropía, solo hash, caducidad, rotación y revocación)
CREATE TABLE patient_recovery_codes (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id   uuid NOT NULL REFERENCES patients(id) ON DELETE RESTRICT,
  code_hash    bytea NOT NULL UNIQUE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  revoked_at   timestamptz,
  used_at      timestamptz,
  revoke_reason text CHECK (revoke_reason IS NULL OR revoke_reason IN ('rotated','used','patient_revoked','expired')),
  CHECK (created_at < expires_at)
);
-- Un solo código vigente por paciente
CREATE UNIQUE INDEX patient_recovery_codes_one_active ON patient_recovery_codes(patient_id) WHERE revoked_at IS NULL;

-- 5. Credencial de servicio de la pasarela de Gradio (crea sesiones invitadas y canjea códigos)
ALTER TABLE service_credentials DROP CONSTRAINT service_credentials_scopes_check;
ALTER TABLE service_credentials ADD CONSTRAINT service_credentials_scopes_check
  CHECK (scopes <@ ARRAY['bot','scheduler','calendar-sync','gateway']::text[] AND cardinality(scopes) > 0);
