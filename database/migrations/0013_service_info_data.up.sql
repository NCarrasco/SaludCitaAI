-- Datos institucionales para responder con información verificada (y administrarla desde el panel):
-- contacto y notas del centro, seguros y formas de pago aceptados, y precio de la consulta por servicio.
-- En esta demostración todos los valores son ficticios (ver seed 003_service_info.sql).
ALTER TABLE centers
  ADD COLUMN phone             text CHECK (phone IS NULL OR length(phone) <= 40),
  ADD COLUMN email             text CHECK (email IS NULL OR length(email) <= 120),
  ADD COLUMN info_notes        text CHECK (info_notes IS NULL OR length(info_notes) <= 500),
  ADD COLUMN accepted_insurers text[] CHECK (accepted_insurers IS NULL OR cardinality(accepted_insurers) <= 30),
  ADD COLUMN payment_methods   text[] CHECK (payment_methods IS NULL OR cardinality(payment_methods) <= 10);

ALTER TABLE doctor_services
  ADD COLUMN price_dop numeric(10,2) CHECK (price_dop IS NULL OR price_dop >= 0);
