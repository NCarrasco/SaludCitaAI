-- Generación de agenda y vista de slots reservables

-- Genera slots desde reglas semanales para [p_from, p_from + p_days) en la zona del centro.
-- Idempotente: no duplica ni borra slots; omite intervalos con excepción del médico
-- y los que solaparían un slot abierto existente del mismo médico.
CREATE FUNCTION generate_slots(p_from date, p_days integer)
RETURNS integer LANGUAGE plpgsql AS $$
DECLARE
  inserted integer;
BEGIN
  IF p_days < 1 OR p_days > 366 THEN
    RAISE EXCEPTION 'p_days fuera de rango';
  END IF;

  WITH days AS (
    SELECT d::date AS day FROM generate_series(p_from, p_from + (p_days - 1), interval '1 day') AS d
  ),
  candidates AS (
    SELECT ds.id AS doctor_service_id, ds.doctor_id,
           ((dy.day + t.local_time) AT TIME ZONE c.timezone) AS starts_at,
           ((dy.day + t.local_time) AT TIME ZONE c.timezone) + make_interval(mins => ds.slot_minutes) AS ends_at
    FROM doctor_services ds
    JOIN centers c ON c.id = ds.center_id
    JOIN schedule_rules r ON r.doctor_service_id = ds.id
    JOIN days dy ON extract(isodow FROM dy.day) = r.weekday
                AND dy.day >= r.valid_from
                AND (r.valid_until IS NULL OR dy.day <= r.valid_until)
    CROSS JOIN LATERAL (
      SELECT gs::time AS local_time
      FROM generate_series(timestamp '2000-01-01' + r.local_start,
                           timestamp '2000-01-01' + r.local_end - make_interval(mins => ds.slot_minutes),
                           make_interval(mins => ds.slot_minutes)) AS gs
    ) t
    WHERE ds.active
  )
  INSERT INTO slots (doctor_service_id, doctor_id, starts_at, ends_at, status)
  SELECT cd.doctor_service_id, cd.doctor_id, cd.starts_at, cd.ends_at, 'open'
  FROM candidates cd
  WHERE NOT EXISTS (
    SELECT 1 FROM schedule_exceptions e
    WHERE e.doctor_id = cd.doctor_id
      AND tstzrange(e.starts_at, e.ends_at, '[)') && tstzrange(cd.starts_at, cd.ends_at, '[)')
  )
  ORDER BY cd.starts_at
  ON CONFLICT DO NOTHING;  -- cubre UNIQUE(doctor_service_id, starts_at) y la exclusión por médico

  GET DIAGNOSTICS inserted = ROW_COUNT;
  RETURN inserted;
END $$;

-- Bloquea slots futuros libres que solapan excepciones. Los slots con cita ocupante
-- no se tocan: requieren gestión explícita del personal. Devuelve los slots bloqueados.
CREATE FUNCTION apply_schedule_exceptions()
RETURNS integer LANGUAGE plpgsql AS $$
DECLARE
  blocked integer;
BEGIN
  UPDATE slots s SET status = 'blocked'
  WHERE s.status = 'open'
    AND s.starts_at > now()
    AND EXISTS (
      SELECT 1 FROM schedule_exceptions e
      WHERE e.doctor_id = s.doctor_id
        AND tstzrange(e.starts_at, e.ends_at, '[)') && tstzrange(s.starts_at, s.ends_at, '[)'))
    AND NOT EXISTS (
      SELECT 1 FROM appointments a
      WHERE a.slot_id = s.id AND a.status IN ('booked','completed','no_show'));
  GET DIAGNOSTICS blocked = ROW_COUNT;
  RETURN blocked;
END $$;

-- Slots reservables por el público en este instante.
-- Excluye: bloqueados, servicios/médicos/centros/especialidades inactivos, slots fuera de
-- anticipación mínima u horizonte, ocupados y retenidos por una ronda de ofertas abierta.
CREATE VIEW reservable_slots AS
SELECT s.id AS slot_id, s.doctor_service_id, s.doctor_id, ds.center_id, ds.specialty_id,
       ds.consultation_kind, s.starts_at, s.ends_at
FROM slots s
JOIN doctor_services ds ON ds.id = s.doctor_service_id
JOIN doctors d ON d.id = s.doctor_id
JOIN centers c ON c.id = ds.center_id
JOIN specialties sp ON sp.id = ds.specialty_id
WHERE s.status = 'open'
  AND ds.active AND d.active AND c.active AND sp.active
  AND s.starts_at >= clock_timestamp() + make_interval(mins => ds.min_notice_minutes)
  AND s.starts_at <  clock_timestamp() + make_interval(days => ds.booking_horizon_days)
  AND NOT EXISTS (SELECT 1 FROM appointments a
                  WHERE a.slot_id = s.id AND a.status IN ('booked','completed','no_show'))
  AND NOT EXISTS (SELECT 1 FROM offer_rounds r WHERE r.slot_id = s.id AND r.status = 'open');
