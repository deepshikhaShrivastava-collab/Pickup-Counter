// Usage: node dist/db/cli.js migrate seed
import { createPool } from '../db.js';
import { migrate, seed } from './migrate.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL is not set');
  process.exit(1);
}

const commands = process.argv.slice(2);
if (commands.length === 0 || commands.some((c) => c !== 'migrate' && c !== 'seed')) {
  console.error('Usage: cli.ts [migrate] [seed]');
  process.exit(1);
}

for (const command of commands) {
  if (command === 'migrate') {
    const ran = await migrate(databaseUrl);
    console.log(ran.length ? `[db] applied ${ran.join(', ')}` : '[db] schema up to date');
  } else {
    const pool = createPool(databaseUrl, 1);
    try {
      await seed(pool);
      console.log('[db] seed applied');
    } finally {
      await pool.end();
    }
  }
}
