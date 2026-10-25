ALTER TABLE inbound_updates DROP COLUMN IF EXISTS done_at;
ALTER TABLE inbound_updates DROP COLUMN IF EXISTS claimed_at;
UPDATE patient_recovery_codes SET revoke_reason = 'patient_revoked' WHERE revoke_reason = 'too_many_attempts';
ALTER TABLE patient_recovery_codes DROP CONSTRAINT IF EXISTS patient_recovery_codes_revoke_reason_check;
ALTER TABLE patient_recovery_codes ADD CONSTRAINT patient_recovery_codes_revoke_reason_check
  CHECK (revoke_reason IS NULL OR revoke_reason IN ('rotated','used','patient_revoked','expired'));
ALTER TABLE patient_recovery_codes DROP COLUMN IF EXISTS failed_attempts;
