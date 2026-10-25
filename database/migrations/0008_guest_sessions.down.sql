ALTER TABLE service_credentials DROP CONSTRAINT service_credentials_scopes_check;
ALTER TABLE service_credentials ADD CONSTRAINT service_credentials_scopes_check
  CHECK (scopes <@ ARRAY['bot','scheduler','calendar-sync']::text[] AND cardinality(scopes) > 0);
DROP TABLE IF EXISTS patient_recovery_codes;
UPDATE channel_identities ci SET external_user_id = a.id::text FROM patient_accounts a
  WHERE ci.channel = 'gradio' AND a.patient_id = ci.patient_id;
DELETE FROM patient_sessions WHERE account_id IS NULL;
DROP INDEX IF EXISTS patient_sessions_patient_idx;
ALTER TABLE patient_sessions DROP COLUMN IF EXISTS kind;
ALTER TABLE patient_sessions ALTER COLUMN account_id SET NOT NULL;
ALTER TABLE patient_sessions DROP COLUMN IF EXISTS patient_id;
ALTER TABLE patients DROP COLUMN IF EXISTS last_seen_at;
ALTER TABLE patients DROP COLUMN IF EXISTS kind;
