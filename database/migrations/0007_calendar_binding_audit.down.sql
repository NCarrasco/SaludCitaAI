ALTER TABLE admin_audit_log DROP CONSTRAINT admin_audit_log_entity_check;
ALTER TABLE admin_audit_log ADD CONSTRAINT admin_audit_log_entity_check CHECK (entity IN ('center','specialty','doctor','doctor_service',
  'schedule_rule','schedule_exception','appointment','handoff','job'));
