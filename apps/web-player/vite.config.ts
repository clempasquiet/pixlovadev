import { createHash } from 'node:crypto';
import { defineConfig, type Plugin } from 'vite';

/**
 * Service worker de l’application (ADR-013, WEBPLY-004) : précache la totalité d’une
 * version (fichiers du build, clés de confiance, configuration) sous un nom de cache
 * propre à cette version. Il ne sert jamais l’API ni le stockage.
 */
function appShellWorker(): Plugin {
  return {
    name: 'pixlova-app-shell-worker',
    apply: 'build',
    generateBundle(_options, bundle) {
      const files = Object.keys(bundle)
        .filter((name) => !name.endsWith('.map'))
        .sort();
      const version = createHash('sha256').update(files.join('\n')).digest('hex').slice(0, 16);
      const source = `/* Généré au build : ne pas modifier. */
const VERSION = ${JSON.stringify(version)};
const CACHE = 'pixlova-app-' + VERSION;
const REQUIRED = ${JSON.stringify(['./', ...files.map((f) => `./${f}`), './trust/manifest-keys.json'])};
const OPTIONAL = ['./config.json', './trust/command-keys.json'];
self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // Version complète ou rien : une installation partielle échoue et l’ancienne reste active.
    await cache.addAll(REQUIRED);
    await Promise.all(OPTIONAL.map((file) => cache.add(file).catch(() => undefined)));
  })());
});
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => key.startsWith('pixlova-app-') && key !== CACHE).map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});
self.addEventListener('message', (event) => {
  // Demandé par la page au démarrage seulement, avant toute lecture.
  if (event.data === 'pixlova:activate-update') self.skipWaiting();
});
self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  const scope = new URL(self.registration.scope);
  if (!url.pathname.startsWith(scope.pathname)) return;
  const relative = url.pathname.slice(scope.pathname.length);
  if (relative.startsWith('player/') || relative.startsWith('storage/')) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const key = request.mode === 'navigate' ? './' : request;
    const cached = await cache.match(key, { ignoreSearch: true });
    if (cached) return cached;
    return fetch(request);
  })());
});
`;
      this.emitFile({ type: 'asset', fileName: 'sw.js', source });
    },
  };
}

/** API relayée en même origine (développement, tests) : `PIXLOVA_API_URL`. */
const api = process.env.PIXLOVA_API_URL ?? 'http://127.0.0.1:3000';
const proxy = { '/player/v1': api, '/storage': api };

export default defineConfig({
  base: './',
  plugins: [appShellWorker()],
  // Validateurs précompilés et moteur de rendu : un seul bundle, précaché hors ligne.
  build: { target: 'es2022', sourcemap: true, assetsInlineLimit: 0, chunkSizeWarningLimit: 900 },
  // Même origine que l’API pour le Player et le stockage local (déploiement recommandé).
  server: { proxy },
  preview: { port: 4319, strictPort: true, proxy },
});
