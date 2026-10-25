import pg from 'pg';
import { migrateDown, migrateUp } from '../src/db/migrate.js';
import { seed } from '../src/db/seed.js';
import { TEST_ADMIN_PASSWORD, TEST_GATEWAY_SECRET, TEST_PATIENT_PASSWORD, TEST_SERVICE_SECRET, testDatabaseUrl } from './helpers/env.js';

/** Recrea el esquema de la base de pruebas, verifica up/down/up de migraciones y aplica el seed. */
export default async function setup() {
  const url = testDatabaseUrl();
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  await c.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
  await c.end();
  // Comprueba reversibilidad: aplicar, revertir todo y volver a aplicar
  const applied = await migrateUp(url, () => undefined);
  await migrateDown(url, applied.length, () => undefined);
  await migrateUp(url, () => undefined);
  await seed(url, { patientPassword: TEST_PATIENT_PASSWORD, timezone: 'America/Santo_Domingo', n8nServiceToken: TEST_SERVICE_SECRET, adminPassword: TEST_ADMIN_PASSWORD, gatewayToken: TEST_GATEWAY_SECRET }, () => undefined);
}
