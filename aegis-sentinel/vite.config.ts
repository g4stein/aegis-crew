import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// LIVE-MOCK talks to the Sentinel runtime (npm run runtime). In dev and preview, /api is
// proxied to it so the browser stays same-origin. The runtime also serves dist/ directly.
const runtime = `http://127.0.0.1:${process.env.AEGIS_RUNTIME_PORT ?? '8787'}`;
const proxy = { '/api': { target: runtime, changeOrigin: false } };

export default defineConfig({
  plugins: [react()],
  build: { target: 'es2022' },
  server: { proxy },
  preview: { proxy },
});
