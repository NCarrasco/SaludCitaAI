import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { sha256Hex } from '../shared/crypto.js';
import { databaseDir } from './paths.js';

interface Migration { version: string; name: string; up: string; down?: string; checksum: string }

const LOCK_KEY = 772001; // pg_advisory_lock para que dos procesos no migren a la vez

export function loadMigrations(): Migration[] {
  const dir = join(databaseDir(), 'migrations');
  const files = readdirSync(dir).filter((f) => /^\d{4}_.+\.up\.sql$/.test(f)).sort();
  return files.map((f) => {
    const version = f.slice(0, 4);
    const name = f.replace(/\.up\.sql$/, '');
    const up = readFileSync(join(dir, f), 'utf8');
    let down: string | undefined;
    try { down = readFileSync(join(dir, `${name}.down.sql`), 'utf8'); } catch { down = undefined; }
    return { version, name, up, down, checksum: sha256Hex(up) };
  });
}

async function ensureTable(c: pg.Client) {
  await c.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version text PRIMARY KEY, name text NOT NULL, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
}

export async function migrateUp(databaseUrl: string, log: (m: string) => void = console.log): Promise<string[]> {
  const c = new pg.Client({ connectionString: databaseUrl });
  await c.connect();
  try {
    await c.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    await ensureTable(c);
    const applied = new Map((await c.query('SELECT version, checksum FROM schema_migrations')).rows
      .map((r) => [r.version as string, r.checksum as string]));
    const done: string[] = [];
    for (const m of loadMigrations()) {
      const prev = applied.get(m.version);
      if (prev) {
        if (prev !== m.checksum) throw new Error(`La migración aplicada ${m.name} fue modificada; crea una nueva migración`);
        continue;
      }
      await c.query('BEGIN');
      try {
        await c.query(m.up);
        await c.query('INSERT INTO schema_migrations(version, name, checksum) VALUES ($1,$2,$3)', [m.version, m.name, m.checksum]);
        await c.query('COMMIT');
      } catch (e) {
        await c.query('ROLLBACK');
        throw new Error(`Falló la migración ${m.name}: ${(e as Error).message}`);
      }
      log(`aplicada ${m.name}`);
      done.push(m.name);
    }
    return done;
  } finally {
    await c.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => undefined);
    await c.end();
  }
}

export async function migrateDown(databaseUrl: string, steps: number, log: (m: string) => void = console.log) {
  const c = new pg.Client({ connectionString: databaseUrl });
  await c.connect();
  try {
    await c.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    await ensureTable(c);
    const all = new Map(loadMigrations().map((m) => [m.version, m]));
    const applied = (await c.query('SELECT version FROM schema_migrations ORDER BY version DESC LIMIT $1', [steps])).rows;
    for (const { version } of applied) {
      const m = all.get(version);
      if (!m?.down) throw new Error(`La migración ${version} no tiene reversión`);
      await c.query('BEGIN');
      try {
        await c.query(m.down);
        await c.query('DELETE FROM schema_migrations WHERE version = $1', [version]);
        await c.query('COMMIT');
      } catch (e) {
        await c.query('ROLLBACK');
        throw e;
      }
      log(`revertida ${m.name}`);
    }
  } finally {
    await c.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => undefined);
    await c.end();
  }
}
