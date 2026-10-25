// Uso: node dist/db/cli.js <migrate|down [n]|seed|migrate-and-seed|generate-slots|calendar-list|calendar-bind>
import { migrateDown, migrateUp } from './migrate.js';
import { seed } from './seed.js';
import pg from 'pg';
import { CALENDAR_ID_RE, setBinding } from '../modules/maintenance/calendar.js';

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('Falta DATABASE_URL');
  const tz = process.env.BUSINESS_TIMEZONE ?? 'America/Santo_Domingo';
  const [cmd, arg] = process.argv.slice(2);
  const seedOpts = () => {
    const pw = process.env.SEED_PATIENT_PASSWORD;
    if (!pw) throw new Error('Falta SEED_PATIENT_PASSWORD');
    return { patientPassword: pw, timezone: tz, n8nServiceToken: process.env.N8N_API_SERVICE_TOKEN || undefined,
             adminPassword: process.env.SEED_ADMIN_PASSWORD || undefined, gatewayToken: process.env.GRADIO_GATEWAY_TOKEN || undefined };
  };
  switch (cmd) {
    case 'migrate': await migrateUp(url); break;
    case 'down': await migrateDown(url, Number(arg ?? 1)); break;
    case 'seed': await seed(url, seedOpts()); break;
    case 'migrate-and-seed': await migrateUp(url); await seed(url, seedOpts()); break;
    case 'generate-slots': {
      const c = new pg.Client({ connectionString: url });
      await c.connect();
      const r = await c.query('SELECT generate_slots((now() AT TIME ZONE $1)::date, 30) AS n', [tz]);
      console.log(`slots generados: ${r.rows[0].n}`);
      await c.end();
      break;
    }
    case 'calendar-list': {
      const c = new pg.Client({ connectionString: url });
      await c.connect();
      const r = await c.query(`SELECT d.id, d.display_name, b.external_calendar_id, coalesce(b.enabled, false) AS enabled
                               FROM doctors d LEFT JOIN calendar_bindings b ON b.doctor_id = d.id ORDER BY d.display_name`);
      for (const x of r.rows) console.log(`${x.id}  ${x.enabled ? 'HABILITADO ' : 'sin vínculo'}  ${x.display_name}  ${x.external_calendar_id ?? ''}`);
      await c.end();
      break;
    }
    case 'calendar-bind': {
      // node dist/db/cli.js calendar-bind <doctor_id> <calendar_id> [--disable]
      const [, doctorId, calendarId] = process.argv.slice(2);
      const enabled = !process.argv.includes('--disable');
      if (!doctorId || !calendarId || !CALENDAR_ID_RE.test(calendarId)) {
        throw new Error('Uso: calendar-bind <doctor_id> <id-del-calendario@group.calendar.google.com> [--disable]');
      }
      const c = new pg.Client({ connectionString: url });
      await c.connect();
      await c.query('BEGIN');
      const r = await setBinding(c as unknown as import('./pool.js').PoolClient, doctorId, calendarId, enabled);
      if (!r) { await c.query('ROLLBACK'); throw new Error('Médico no encontrado'); }
      await c.query('COMMIT');
      console.log(`Vínculo ${enabled ? 'habilitado' : 'deshabilitado'}; citas futuras encoladas: ${r.requeued_appointments}. ` +
        'Nota: este comando no queda en la auditoría del panel; para cambios auditados usa el panel (Mantenimiento → Calendarios).');
      await c.end();
      break;
    }
    default:
      throw new Error('Comando desconocido. Usa: migrate | down [n] | seed | migrate-and-seed | generate-slots | calendar-list | calendar-bind');
  }
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
