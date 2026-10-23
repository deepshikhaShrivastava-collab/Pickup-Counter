import { readdir, readFile } from 'node:fs/promises';
import pg from 'pg';
import type { Db } from '../db.js';

// Same relative depth from src/db and dist/db, so this works under tsx and compiled.
const MIGRATIONS_DIR = new URL('../../migrations/', import.meta.url);
const SEED_FILE = new URL('../../seeds/products.sql', import.meta.url);
const MIGRATION_LOCK_ID = 727_001;

/** Applies pending migrations in filename order, each in its own transaction. */
export async function migrate(connectionString: string): Promise<string[]> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    const { rows } = await client.query<{ name: string }>('SELECT name FROM schema_migrations');
    const applied = new Set(rows.map((r) => r.name));
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();

    const ran: string[] = [];
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = await readFile(new URL(file, MIGRATIONS_DIR), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
      }
      ran.push(file);
    }
    return ran;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]).catch(() => {});
    await client.end();
  }
}

/** Inserts the five demo products if they do not exist yet. */
export async function seed(db: Db): Promise<void> {
  await db.query(await readFile(SEED_FILE, 'utf8'));
}
