import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Parcours navigateur lourds (API, PostgreSQL, Chromium) : un fichier à la fois.
    fileParallelism: false,
  },
});
