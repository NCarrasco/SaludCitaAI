-- 1) Bloqueo por código: tras 5 fechas de nacimiento incorrectas el código se invalida (además del límite por IP).
ALTER TABLE patient_recovery_codes ADD COLUMN failed_attempts integer NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0);
ALTER TABLE patient_recovery_codes DROP CONSTRAINT IF EXISTS patient_recovery_codes_revoke_reason_check;
ALTER TABLE patient_recovery_codes ADD CONSTRAINT patient_recovery_codes_revoke_reason_check
  CHECK (revoke_reason IS NULL OR revoke_reason IN ('rotated','used','patient_revoked','expired','too_many_attempts'));
-- 2) Medición de latencia por mensaje: cuándo lo tomó n8n y cuándo quedó visible para el paciente.
ALTER TABLE inbound_updates ADD COLUMN claimed_at timestamptz;
ALTER TABLE inbound_updates ADD COLUMN done_at timestamptz;
