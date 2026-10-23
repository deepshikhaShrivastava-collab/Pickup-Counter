import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// In development the browser talks to Vite only; /api is proxied to the backend, so no CORS.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': process.env.API_PROXY_TARGET ?? 'http://localhost:4000',
    },
  },
  test: {
    include: ['src/**/*.test.ts'],
  },
});
