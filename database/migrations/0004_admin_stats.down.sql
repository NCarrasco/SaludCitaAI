DROP INDEX IF EXISTS messages_outbound_time_idx;
DROP INDEX IF EXISTS advance_offers_offered_idx;
DROP INDEX IF EXISTS appointment_events_type_time_idx;
ALTER TABLE admin_users DROP COLUMN IF EXISTS display_name;
ALTER TABLE admin_sessions DROP CONSTRAINT IF EXISTS admin_sessions_csrf_required;
ALTER TABLE admin_sessions DROP COLUMN IF EXISTS csrf_hash;
