-- Conversación (entrega 2): modo de cada respuesta, tipo de actualización entrante y vínculo mensaje↔actualización

-- inbound_updates: texto libre (lo interpreta la IA vía n8n) o acción de botón (procesamiento determinista en la API)
ALTER TABLE inbound_updates
  ADD COLUMN kind text NOT NULL DEFAULT 'text' CHECK (kind IN ('text','action')),
  ADD COLUMN processed_by text CHECK (processed_by IN ('n8n','api')),
  ADD COLUMN max_attempts integer NOT NULL DEFAULT 3 CHECK (max_attempts >= 1),
  ADD COLUMN available_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX inbound_updates_conversation_idx ON inbound_updates(conversation_id, created_at);

-- messages: modo con el que se generó la respuesta. Se distingue explícitamente:
--   ai             → intención/entidades extraídas por el modelo local y ejecutadas por reglas deterministas
--   deterministic  → acción de botón procesada sin modelo
--   fallback_menu  → el modelo falló o no estaba disponible; se ofrece el menú guiado
--   system         → mensajes generados por la API sobre resultados de operaciones
ALTER TABLE messages
  ADD COLUMN update_id uuid REFERENCES inbound_updates(id) ON DELETE RESTRICT,
  ADD COLUMN mode text CHECK (mode IS NULL OR mode IN ('ai','deterministic','fallback_menu','system')),
  ADD COLUMN payload jsonb CHECK (payload IS NULL OR jsonb_typeof(payload) = 'object');
CREATE INDEX messages_update_idx ON messages(update_id);

ALTER TABLE handoff_cases ADD COLUMN reference text UNIQUE CHECK (reference ~ '^AY-[A-Z2-9]{6}$');
