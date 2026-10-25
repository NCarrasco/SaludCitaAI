-- Entrega 3: sesiones administrativas con protección CSRF e índices para estadísticas

-- Token CSRF por sesión (patrón de doble envío: cookie legible + cabecera X-CSRF-Token); se guarda su hash
ALTER TABLE admin_sessions ADD COLUMN csrf_hash bytea;
UPDATE admin_sessions SET revoked_at = COALESCE(revoked_at, now()) WHERE csrf_hash IS NULL;
ALTER TABLE admin_sessions ADD CONSTRAINT admin_sessions_csrf_required CHECK (csrf_hash IS NOT NULL OR revoked_at IS NOT NULL);
ALTER TABLE admin_users ADD COLUMN display_name text CHECK (display_name IS NULL OR length(display_name) <= 120);

-- Estadísticas por fecha de operación y por slot
CREATE INDEX appointment_events_type_time_idx ON appointment_events(event_type, occurred_at);
CREATE INDEX advance_offers_offered_idx ON advance_offers(offered_at);
CREATE INDEX messages_outbound_time_idx ON messages(created_at) WHERE direction = 'outbound';
