import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Chaque fichier d’intégration crée sa base éphémère ; exécution séquentielle.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
