import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createPool } from './db.js';
import { startExpirySweeper } from './services/expiry.js';

const config = loadConfig();
const pool = createPool(config.databaseUrl);
const app = createApp({ pool, webhookSecret: config.webhookSecret });

const server = app.listen(config.port, () => {
  console.log(`[api] listening on :${config.port}`);
});
const stopSweeper = startExpirySweeper(pool, config.expirySweepMs);

function shutdown(signal: string) {
  console.log(`[api] ${signal} received, shutting down`);
  stopSweeper();
  server.close(() => {
    pool.end().finally(() => process.exit(0));
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
