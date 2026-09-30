import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * Console servie par le serveur d’administration sur sa propre origine (ADR-016) : en
 * développement, Vite relaie `/admin-api` vers le listener admin local (8081).
 */
const admin = process.env.PIXLOVA_ADMIN_URL ?? 'http://127.0.0.1:8081';

export default defineConfig({
  plugins: [react()],
  build: { target: 'es2022', sourcemap: false },
  server: {
    port: 5174,
    strictPort: true,
    proxy: { '/admin-api': { target: admin, changeOrigin: false } },
  },
});
