import { defineConfig } from 'vitest/config';

// Tests that need no database.
export default defineConfig({
  test: {
    include: ['test/unit/**/*.test.ts'],
  },
});
