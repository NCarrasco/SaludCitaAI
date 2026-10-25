-- Contacto del paciente para que el personal pueda localizarlo (p. ej., si el médico se ausenta).
-- Para reservar basta UNO de los dos (teléfono o correo; lo exige la API). NUNCA sirven para identificarse.
ALTER TABLE patients
  ADD COLUMN phone text CHECK (phone IS NULL OR phone ~ '^\+?[0-9(][0-9 ()-]{6,22}$'),
  ADD COLUMN email text CHECK (email IS NULL OR (length(email) <= 120 AND email ~* '^[^@[:space:]]+@[^@[:space:]]+\.[a-z]{2,}$'));
