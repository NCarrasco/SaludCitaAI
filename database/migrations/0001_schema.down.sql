-- Reversión completa del esquema inicial (destruye datos; solo entornos locales)
DROP TABLE IF EXISTS idempotency_records, service_credentials, admin_sessions, handoff_cases, admin_users,
  analytics_events, calendar_sync, calendar_bindings, notifications, outbox_jobs, inbound_updates,
  action_intents, messages, conversations, advance_offers, offer_rounds, appointment_events, appointments,
  channel_identities, patient_sessions, patient_accounts, patients, slots, schedule_exceptions,
  schedule_rules, doctor_services, doctors, specialties, centers CASCADE;
DROP FUNCTION IF EXISTS appointments_copy_slot_times(), slots_immutable_times(), forbid_mutation(), set_updated_at();
