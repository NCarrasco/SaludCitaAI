-- 20 pacientes FICTICIOS. Nombres y fechas inventados; sin documentos de identidad.
-- Las cuentas (paciente01..paciente20) las crea el seed con la contraseña de SEED_PATIENT_PASSWORD.
INSERT INTO patients (id, full_name, birth_date) VALUES
  ('60000000-0000-4000-8000-000000000001', 'Rosa Elena Ficticia',     '1985-03-14'),
  ('60000000-0000-4000-8000-000000000002', 'Pedro Ejemplo Martínez',  '1972-11-02'),
  ('60000000-0000-4000-8000-000000000003', 'Lucía Prueba Santos',     '1990-07-21'),
  ('60000000-0000-4000-8000-000000000004', 'Andrés Simulado Reyes',   '1968-01-30'),
  ('60000000-0000-4000-8000-000000000005', 'Carmen Demo Valdez',      '1955-09-09'),
  ('60000000-0000-4000-8000-000000000006', 'Julio Ficticio Cabrera',  '2001-05-17'),
  ('60000000-0000-4000-8000-000000000007', 'Marta Ejemplo Herrera',   '1979-12-12'),
  ('60000000-0000-4000-8000-000000000008', 'Luis Prueba Castillo',    '1993-04-04'),
  ('60000000-0000-4000-8000-000000000009', 'Elena Simulada Vargas',   '1962-08-25'),
  ('60000000-0000-4000-8000-000000000010', 'Ramón Demo Guzmán',       '1988-02-19'),
  ('60000000-0000-4000-8000-000000000011', 'Sofía Ficticia Mejía',    '2015-06-10'),
  ('60000000-0000-4000-8000-000000000012', 'Daniel Ejemplo Rosario',  '2018-10-01'),
  ('60000000-0000-4000-8000-000000000013', 'Ana Prueba Polanco',      '1975-03-03'),
  ('60000000-0000-4000-8000-000000000014', 'Héctor Simulado Lora',    '1950-12-24'),
  ('60000000-0000-4000-8000-000000000015', 'Isabel Demo Familia',     '1997-09-15'),
  ('60000000-0000-4000-8000-000000000016', 'Tomás Ficticio Almonte',  '1983-07-07'),
  ('60000000-0000-4000-8000-000000000017', 'Patricia Ejemplo Núñez',  '1970-05-28'),
  ('60000000-0000-4000-8000-000000000018', 'Víctor Prueba Batista',   '1999-01-11'),
  ('60000000-0000-4000-8000-000000000019', 'Gabriela Simulada Peralta','2012-11-20'),
  ('60000000-0000-4000-8000-000000000020', 'Manuel Demo Espaillat',   '1960-04-16')
ON CONFLICT (id) DO NOTHING;

-- Teléfonos FICTICIOS de contacto (rango 555, no asignado): (809) 555-1001 … (809) 555-1020
UPDATE patients SET phone = '(809) 555-' || (1000 + right(id::text, 2)::int)::text
WHERE id::text LIKE '60000000-0000-4000-8000-0000000000%' AND phone IS NULL;
