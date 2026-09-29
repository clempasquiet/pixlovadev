import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: { target: 'es2022', sourcemap: true },
  preview: { port: 4317, strictPort: true },
});
