-- Solicitudes de ayuda: el personal deja constancia de qué hizo al resolverla y si avisó al paciente en el chat.
ALTER TABLE handoff_cases
  ADD COLUMN resolution_note text CHECK (resolution_note IS NULL OR length(btrim(resolution_note)) BETWEEN 1 AND 500),
  ADD COLUMN patient_notified boolean NOT NULL DEFAULT false;
