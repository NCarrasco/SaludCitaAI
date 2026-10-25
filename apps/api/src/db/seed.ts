import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { hashPassword, tokenHash, verifyPassword } from '../shared/crypto.js';
import { databaseDir } from './paths.js';

const SLOT_DAYS = 30;

/**
 * Seed reproducible: catálogo y pacientes ficticios con IDs fijos, cuentas paciente01..20,
 * una ausencia de ejemplo y agenda de 30 días desde la fecha local actual.
 * Es idempotente: se puede ejecutar varias veces sin duplicar datos.
 */
export async function seed(databaseUrl: string, opts: { patientPassword: string; timezone: string; n8nServiceToken?: string; adminPassword?: string; gatewayToken?: string },
                           log: (m: string) => void = console.log) {
  if (opts.patientPassword.length < 10) throw new Error('SEED_PATIENT_PASSWORD debe tener al menos 10 caracteres');
  const c = new pg.Client({ connectionString: databaseUrl });
  await c.connect();
  try {
    const dir = join(databaseDir(), 'seeds');
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
      await c.query(readFileSync(join(dir, f), 'utf8'));
      log(`seed ${f}`);
    }

    // Cuentas de demostración: usuario pacienteNN ↔ paciente 600…0NN
    const patients = (await c.query(`SELECT id FROM patients WHERE id::text LIKE '60000000-0000-4000-8000-%' ORDER BY id`)).rows;
    let created = 0;
    for (const [i, p] of patients.entries()) {
      const username = `paciente${String(i + 1).padStart(2, '0')}`;
      const existing = (await c.query('SELECT password_hash FROM patient_accounts WHERE username = $1', [username])).rows[0];
      if (existing && (await verifyPassword(opts.patientPassword, existing.password_hash))) continue;
      const hash = await hashPassword(opts.patientPassword);
      await c.query(
        `INSERT INTO patient_accounts (patient_id, username, password_hash) VALUES ($1, $2, $3)
         ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash`, [p.id, username, hash]);
      created++;
    }
    log(`cuentas de paciente creadas/actualizadas: ${created}`);

    // Ausencia ficticia: Dr. Peña (atiende lunes a jueves) el primer día laborable a partir de +7.
    // Identificador fijo: se crea una sola vez.
    await c.query(
      `WITH d AS (
         SELECT min(day) AS day FROM (
           SELECT ((now() AT TIME ZONE $1)::date + k) AS day FROM generate_series(7, 13) AS k) x
         WHERE extract(isodow FROM day) BETWEEN 1 AND 4)
       INSERT INTO schedule_exceptions (id, doctor_id, starts_at, ends_at, reason)
       SELECT '70000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000002',
              d.day::timestamp AT TIME ZONE $1, (d.day + 1)::timestamp AT TIME ZONE $1, 'absence'
       FROM d
       ON CONFLICT (id) DO NOTHING`, [opts.timezone]);

    // Credencial de servicio de n8n (scope bot). Solo se guarda el hash del token.
    if (opts.n8nServiceToken) {
      await c.query(
        `INSERT INTO service_credentials (name, secret_hash, scopes) VALUES ('n8n', $1, ARRAY['bot','scheduler','calendar-sync'])
         ON CONFLICT (name) DO UPDATE SET secret_hash = EXCLUDED.secret_hash, scopes = EXCLUDED.scopes, revoked_at = NULL`,
        [tokenHash(serviceToken(opts.n8nServiceToken))]);
      log('credencial de servicio n8n registrada');
    }

    // Credencial de la pasarela de Gradio (scope gateway): crea sesiones invitadas y canjea códigos de recuperación
    if (opts.gatewayToken) {
      await c.query(
        `INSERT INTO service_credentials (name, secret_hash, scopes) VALUES ('gradio-gateway', $1, ARRAY['gateway'])
         ON CONFLICT (name) DO UPDATE SET secret_hash = EXCLUDED.secret_hash, scopes = EXCLUDED.scopes, revoked_at = NULL`,
        [tokenHash(serviceToken(opts.gatewayToken))]);
      log('credencial de servicio de la pasarela registrada');
    }

    // Usuarios administrativos ficticios, uno por rol (dominio reservado .test)
    if (opts.adminPassword) {
      // Solo entorno local de demostración: mínimo 8 caracteres (clave fácil de recordar en la presentación)
      if (opts.adminPassword.length < 8) throw new Error('SEED_ADMIN_PASSWORD debe tener al menos 8 caracteres');
      const admins: [string, string, string][] = [
        ['admin@saludcita.test', 'Administración (demo)', 'admin'],
        ['operador@saludcita.test', 'Operador de consulta externa (demo)', 'operator'],
        ['panel@saludcita.test', 'Panel de estadísticas (demo)', 'viewer'],
      ];
      for (const [email, name, role] of admins) {
        const prev = (await c.query('SELECT password_hash FROM admin_users WHERE email = $1', [email])).rows[0];
        if (prev && (await verifyPassword(opts.adminPassword, prev.password_hash))) continue;
        await c.query(
          `INSERT INTO admin_users (email, display_name, role, password_hash) VALUES ($1, $2, $3, $4)
           ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, role = EXCLUDED.role, display_name = EXCLUDED.display_name`,
          [email, name, role, await hashPassword(opts.adminPassword)]);
      }
      log('usuarios administrativos de demostración listos');
    }

    const gen = await c.query('SELECT generate_slots((now() AT TIME ZONE $1)::date, $2) AS n', [opts.timezone, SLOT_DAYS]);
    const blocked = await c.query('SELECT apply_schedule_exceptions() AS n');
    log(`slots generados: ${gen.rows[0].n}; bloqueados por excepciones: ${blocked.rows[0].n}`);
  } finally {
    await c.end();
  }
}

/** Token Bearer que usa n8n: prefijo svc_ + el secreto aleatorio de N8N_API_SERVICE_TOKEN. */
export function serviceToken(secret: string): string {
  return secret.startsWith('svc_') ? secret : `svc_${secret}`;
}
