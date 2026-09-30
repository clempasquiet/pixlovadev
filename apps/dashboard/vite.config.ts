import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * Le dashboard appelle `/api/v1` sur sa propre origine (ADR-006) : en développement,
 * Vite relaie `/api` vers l’API locale ; en production, la passerelle fait de même.
 */
const api = process.env.PIXLOVA_API_URL ?? 'http://127.0.0.1:3000';

export default defineConfig({
  plugins: [react()],
  build: { target: 'es2022', sourcemap: true },
  server: { port: 5173, strictPort: true, proxy: { '/api': { target: api, changeOrigin: false } } },
  preview: {
    port: 4173,
    strictPort: true,
    proxy: { '/api': { target: api, changeOrigin: false } },
  },
});
