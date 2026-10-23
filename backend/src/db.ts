import pg from 'pg';

/** Anything that can run a query: the pool or a client inside a transaction. */
export type Db = pg.Pool | pg.PoolClient;

export function createPool(connectionString: string, max = 10): pg.Pool {
  const pool = new pg.Pool({ connectionString, max });
  pool.on('error', (err) => console.error('[db] idle client error', err));
  return pool;
}

/** Runs fn inside BEGIN/COMMIT on one client, rolling back on any error. READ COMMITTED. */
export async function withTransaction<T>(
  pool: pg.Pool,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
