import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Une base éphémère par fichier ; les fichiers s’exécutent séquentiellement.
    fileParallelism: false,
    testTimeout: 20_000,
  },
});
