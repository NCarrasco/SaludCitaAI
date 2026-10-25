DROP TABLE IF EXISTS appointment_receipts;
DROP INDEX IF EXISTS outbox_jobs_correlation_idx;
ALTER TABLE outbox_jobs DROP COLUMN IF EXISTS correlation_id;
