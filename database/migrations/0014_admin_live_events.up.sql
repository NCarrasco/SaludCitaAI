-- Actualización en vivo del panel: PostgreSQL avisa por NOTIFY al confirmar (COMMIT) cada cambio operativo.
-- Una sola conexión LISTEN por proceso de la API reenvía el aviso a los navegadores por SSE. El aviso no lleva datos
-- personales: tema, tipo y el id de la entidad (la API decide qué enviar a cada rol).
CREATE OR REPLACE FUNCTION sc_notify_admin() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kind text;
  eid uuid;
BEGIN
  IF TG_TABLE_NAME = 'appointment_events' THEN kind := NEW.event_type; eid := NEW.appointment_id;
  ELSIF TG_TABLE_NAME = 'handoff_cases' THEN kind := NEW.status; eid := NEW.id;
  ELSIF TG_TABLE_NAME = 'advance_offers' THEN kind := NEW.status; eid := NEW.appointment_id;
  ELSE kind := lower(TG_OP); eid := NULL;
  END IF;
  PERFORM pg_notify('sc_admin_events', json_build_object('topic', TG_ARGV[0], 'kind', kind, 'id', eid)::text);
  RETURN NULL;
END $$;

CREATE TRIGGER appointment_events_notify AFTER INSERT ON appointment_events
  FOR EACH ROW EXECUTE FUNCTION sc_notify_admin('appointments');
CREATE TRIGGER handoff_cases_notify AFTER INSERT OR UPDATE OF status ON handoff_cases
  FOR EACH ROW EXECUTE FUNCTION sc_notify_admin('handoffs');
CREATE TRIGGER advance_offers_notify AFTER INSERT OR UPDATE OF status ON advance_offers
  FOR EACH ROW EXECUTE FUNCTION sc_notify_admin('offers');
CREATE TRIGGER admin_audit_log_notify AFTER INSERT ON admin_audit_log
  FOR EACH ROW EXECUTE FUNCTION sc_notify_admin('catalog');
