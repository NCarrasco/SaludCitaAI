DROP INDEX IF EXISTS notifications_inbox_idx;
ALTER TABLE notifications DROP COLUMN IF EXISTS archived_at;
