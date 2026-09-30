import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * Le dashboard appelle `/api/v1` sur sa propre origine (ADR-006) : en développement,
 * Vite relaie `/api` vers l’API locale ; en production, la passerelle fait de même.
 * `/storage` : URLs signées du pilote de stockage local (développement, ADR-009) ; en
 * production, les URLs présignées S3 pointent directement vers le stockage.
 */
const api = process.env.PIXLOVA_API_URL ?? 'http://127.0.0.1:3000';
const proxy = {
  '/api': { target: api, changeOrigin: false },
  '/storage': { target: api, changeOrigin: false },
};

export default defineConfig({
  plugins: [react()],
  build: { target: 'es2022', sourcemap: true },
  server: { port: 5173, strictPort: true, proxy },
  preview: { port: 4173, strictPort: true, proxy },
});
