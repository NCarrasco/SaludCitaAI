DROP TRIGGER IF EXISTS admin_audit_log_notify ON admin_audit_log;
DROP TRIGGER IF EXISTS advance_offers_notify ON advance_offers;
DROP TRIGGER IF EXISTS handoff_cases_notify ON handoff_cases;
DROP TRIGGER IF EXISTS appointment_events_notify ON appointment_events;
DROP FUNCTION IF EXISTS sc_notify_admin();
