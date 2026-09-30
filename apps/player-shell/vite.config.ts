import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: { target: 'es2022', sourcemap: true, assetsInlineLimit: 0 },
  preview: { port: 4318, strictPort: true },
});
