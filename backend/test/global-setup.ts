import pg from 'pg';
import { migrate } from '../src/db/migrate.js';

/** Drops and recreates the test database, then applies migrations. */
export default async function setup() {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error(
      'TEST_DATABASE_URL is not set. Copy .env.example to .env and point it at a running PostgreSQL (see README).',
    );
  }

  const target = new URL(url);
  const dbName = target.pathname.slice(1);
  if (!/^[a-z0-9_]+$/.test(dbName) || !dbName.includes('test')) {
    throw new Error(`Refusing to recreate "${dbName}": the test database name must contain "test"`);
  }

  const admin = new URL(url);
  admin.pathname = '/postgres';
  const client = new pg.Client({ connectionString: admin.toString() });
  await client.connect();
  try {
    await client.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await client.query(`CREATE DATABASE ${dbName}`);
  } finally {
    await client.end();
  }

  await migrate(url);
}
