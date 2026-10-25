-- Datos institucionales FICTICIOS del hospital simulado (idempotente: solo rellena lo que esté vacío).
-- Teléfono con prefijo 555 (reservado para ficción) y dominio .example (reservado): no corresponden a nadie real.
UPDATE centers SET
  phone             = COALESCE(phone, '(809) 555-0100'),
  email             = COALESCE(email, 'citas@hospital-simulado.example'),
  info_notes        = COALESCE(info_notes, 'Parqueo gratuito para pacientes y acceso para sillas de ruedas. La recepción de consultas externas está en la planta baja.'),
  accepted_insurers = COALESCE(accepted_insurers, ARRAY['ARS Ficticia Uno', 'ARS Ficticia Dos', 'Seguro Demo Plus']),
  payment_methods   = COALESCE(payment_methods, ARRAY['efectivo', 'tarjeta de débito o crédito', 'transferencia bancaria'])
WHERE id = '10000000-0000-4000-8000-000000000001';

UPDATE doctor_services ds SET price_dop = v.price
FROM (VALUES ('20000000-0000-4000-8000-000000000001'::uuid, 1500.00),   -- Medicina Interna
             ('20000000-0000-4000-8000-000000000002'::uuid, 2500.00),   -- Cardiología
             ('20000000-0000-4000-8000-000000000003'::uuid, 1800.00))   -- Pediatría
     AS v(specialty_id, price)
WHERE ds.specialty_id = v.specialty_id AND ds.price_dop IS NULL;
