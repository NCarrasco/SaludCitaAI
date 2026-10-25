-- Entrega 4: resultado de trabajos durables y apoyo a ofertas/recordatorios

ALTER TABLE outbox_jobs ADD COLUMN result jsonb;
ALTER TABLE outbox_jobs ADD COLUMN done_at timestamptz;

-- Candidatos de oferta: citas reservadas por servicio y hora de inicio
CREATE INDEX appointments_service_candidates_idx ON appointments(slot_id, starts_at) WHERE status = 'booked' AND advance_opt_in;
CREATE INDEX advance_offers_round_idx ON advance_offers(round_id);
