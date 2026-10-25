-- Entrega 3B: auditoría de cambios administrativos e índice para búsqueda de citas

CREATE TABLE admin_audit_log (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_user_id  uuid NOT NULL REFERENCES admin_users(id) ON DELETE RESTRICT,
  action         text NOT NULL CHECK (length(action) BETWEEN 1 AND 80),
  entity         text NOT NULL CHECK (entity IN ('center','specialty','doctor','doctor_service','schedule_rule',
                                                 'schedule_exception','appointment','handoff','job')),
  entity_id      uuid,
  before         jsonb,
  after          jsonb,
  impact         jsonb,
  occurred_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX admin_audit_log_entity_idx ON admin_audit_log(entity, entity_id, occurred_at);
CREATE TRIGGER admin_audit_log_immutable BEFORE UPDATE OR DELETE ON admin_audit_log
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ¿Cubre alguna regla vigente y activa el intervalo de un slot? (hora local del centro y fecha de vigencia)
CREATE FUNCTION slot_covered_by_rules(p_slot_id uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM slots s
    JOIN doctor_services ds ON ds.id = s.doctor_service_id
    JOIN centers c ON c.id = ds.center_id
    JOIN schedule_rules r ON r.doctor_service_id = s.doctor_service_id
    WHERE s.id = p_slot_id AND ds.active
      AND r.weekday = extract(isodow FROM s.starts_at AT TIME ZONE c.timezone)
      AND (s.starts_at AT TIME ZONE c.timezone)::date >= r.valid_from
      AND (r.valid_until IS NULL OR (s.starts_at AT TIME ZONE c.timezone)::date <= r.valid_until)
      AND (s.starts_at AT TIME ZONE c.timezone)::time >= r.local_start
      AND (s.ends_at AT TIME ZONE c.timezone)::time <= r.local_end
      AND (s.ends_at AT TIME ZONE c.timezone)::date = (s.starts_at AT TIME ZONE c.timezone)::date)
$$;

CREATE INDEX patients_lower_name_idx ON patients (lower(full_name));
