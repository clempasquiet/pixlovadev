import { defineConfig } from 'vite';

/**
 * Le site est rendu au build : Vite compile le générateur (React côté serveur), puis
 * `node build/ssr/build.js` écrit les pages HTML statiques dans `dist/`. Aucun React n’est
 * envoyé au navigateur ; seul `public/site.js` (menu, calculateur, mur LED) l’est.
 */
export default defineConfig({
  build: {
    ssr: 'src/build.tsx',
    outDir: 'build/ssr',
    target: 'node24',
    emptyOutDir: true,
    sourcemap: false,
  },
});
