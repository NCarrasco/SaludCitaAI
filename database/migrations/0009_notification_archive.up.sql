-- Avisos archivados por el paciente («quitar» en la bandeja). No se borran: se conservan para trazabilidad.
ALTER TABLE notifications ADD COLUMN archived_at timestamptz;
CREATE INDEX notifications_inbox_idx ON notifications (patient_id, created_at DESC) WHERE status = 'sent' AND archived_at IS NULL;
