DROP INDEX IF EXISTS advance_offers_round_idx;
DROP INDEX IF EXISTS appointments_service_candidates_idx;
ALTER TABLE outbox_jobs DROP COLUMN IF EXISTS done_at;
ALTER TABLE outbox_jobs DROP COLUMN IF EXISTS result;
