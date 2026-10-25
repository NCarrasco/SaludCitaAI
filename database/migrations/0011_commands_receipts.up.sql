-- Incrementos C y E: comandos durables correlacionados y comprobantes PDF versionados.

-- correlation_id: une la operación que originó el comando (p. ej., la intención confirmada) con su ejecución en n8n
ALTER TABLE outbox_jobs ADD COLUMN correlation_id uuid;
CREATE INDEX outbox_jobs_correlation_idx ON outbox_jobs(correlation_id);

-- Comprobantes: uno por versión de la cita. El PDF se guarda en la base (almacenamiento privado, nunca en Git ni en logs).
CREATE TABLE appointment_receipts (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  appointment_id      uuid NOT NULL REFERENCES appointments(id) ON DELETE RESTRICT,
  appointment_version integer NOT NULL CHECK (appointment_version >= 1),
  receipt_number      integer NOT NULL CHECK (receipt_number >= 1),           -- 1, 2, 3… por cita (versión del comprobante)
  status              text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','ready','failed','superseded','void')),
  pdf                 bytea,
  sha256              text,
  size_bytes          integer,
  correlation_id      uuid,
  last_error          text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  rendered_at         timestamptz,
  CONSTRAINT appointment_receipts_one_per_version UNIQUE (appointment_id, appointment_version),
  CONSTRAINT appointment_receipts_number UNIQUE (appointment_id, receipt_number),
  CHECK (status <> 'ready' OR (pdf IS NOT NULL AND sha256 IS NOT NULL))
);
CREATE INDEX appointment_receipts_appt_idx ON appointment_receipts(appointment_id, receipt_number DESC);
