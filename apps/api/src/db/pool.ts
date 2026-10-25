import pg from 'pg';

// timestamptz y date se devuelven como texto para controlar el formato con zona horaria
pg.types.setTypeParser(pg.types.builtins.DATE, (v) => v);

export type Pool = pg.Pool;
export type PoolClient = pg.PoolClient;

export function createPool(connectionString: string, max = 25): pg.Pool {
  const pool = new pg.Pool({ connectionString, max, application_name: 'saludcita-api' });
  pool.on('error', () => {
    // errores de clientes inactivos: el pool los descarta; la operación siguiente reconecta
  });
  return pool;
}
