import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Pick up TEST_DATABASE_URL from the repo-root .env when present; real env vars win.
try {
  process.loadEnvFile(fileURLToPath(new URL('../.env', import.meta.url)));
} catch {
  // no .env file: rely on the environment
}

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/global-setup.ts'],
    // Integration test files share one database, so run them one file at a time.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
