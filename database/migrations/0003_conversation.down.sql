ALTER TABLE handoff_cases DROP COLUMN IF EXISTS reference;
DROP INDEX IF EXISTS messages_update_idx;
ALTER TABLE messages DROP COLUMN IF EXISTS payload, DROP COLUMN IF EXISTS mode, DROP COLUMN IF EXISTS update_id;
DROP INDEX IF EXISTS inbound_updates_conversation_idx;
ALTER TABLE inbound_updates DROP COLUMN IF EXISTS available_at, DROP COLUMN IF EXISTS max_attempts,
  DROP COLUMN IF EXISTS processed_by, DROP COLUMN IF EXISTS kind;
