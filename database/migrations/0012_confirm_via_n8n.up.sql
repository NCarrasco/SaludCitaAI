-- Confirmación orquestada por n8n: pulsar «Confirmar» registra la orden (submitted_at) y encarga el comando durable
-- appointment.confirm; n8n lo reclama y la API ejecuta la confirmación. Un mismo correlation_id une botón, n8n, cita y PDF.
ALTER TABLE action_intents
  ADD COLUMN submitted_at   timestamptz,
  ADD COLUMN command_id     uuid,
  ADD COLUMN correlation_id uuid;
