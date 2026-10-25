import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// src/db o dist/db → raíz del repositorio (también en la imagen: /app)
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../../..');

export function databaseDir(): string {
  const dir = process.env.DATABASE_DIR ?? resolve(repoRoot, 'database');
  if (!existsSync(dir)) throw new Error(`No existe el directorio de base de datos: ${dir}`);
  return dir;
}
