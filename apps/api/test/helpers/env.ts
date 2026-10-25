import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Contraseña exclusiva de la base de pruebas (cuentas ficticias)
export const TEST_PATIENT_PASSWORD = 'clave-de-prueba-local';
// Secreto de la credencial de servicio de pruebas (base saludcita_test)
export const TEST_SERVICE_SECRET = 'secreto-servicio-de-prueba';
export const TEST_ADMIN_PASSWORD = 'clave-admin-de-prueba';
export const TEST_GATEWAY_SECRET = 'secreto-pasarela-de-prueba';

/** TEST_DATABASE_URL o, en su defecto, la base saludcita_test del Compose local según .env. */
export function testDatabaseUrl(): string {
  if (process.env.TEST_DATABASE_URL) return process.env.TEST_DATABASE_URL;
  const envFile = resolve(import.meta.dirname, '../../../../.env');
  const vars = Object.fromEntries(readFileSync(envFile, 'utf8').split('\n')
    .filter((l) => /^[A-Z0-9_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
  return `postgres://${vars.APP_DB_USER}:${vars.APP_DB_PASSWORD}@127.0.0.1:${vars.POSTGRES_HOST_PORT ?? '55433'}/saludcita_test`;
}
