# Player Web

Player pixlova dans un navigateur ([ADR-013](../../docs/architecture/adr/0013-player-web.md)). Il a le même modèle que le Player natif (appairage, manifests signés, activation atomique, lecture partagée `@pixlova/player-core`), mais **sans ses garanties** : le navigateur peut évincer le stockage, suspendre l’onglet ou refuser le plein écran.

```sh
pnpm --filter @pixlova/web-player run dev            # développement (API relayée sur 127.0.0.1:3000 ou PIXLOVA_API_URL)
pnpm --filter @pixlova/web-player run build          # dist/ statique + service worker de la version
pnpm --filter @pixlova/web-player run test           # politique de stockage, capacités
PIXLOVA_TEST_DATABASE_URL=… pnpm --filter @pixlova/web-player run test:browser
```

## Déploiement

- Servir `dist/` en HTTPS, idéalement **sur la même origine que l’API** (`/player/v1` et le stockage relayés) : aucun CORS.
- Sinon, déclarer l’origine du Player dans `PIXLOVA_WEB_PLAYER_ORIGINS` côté API, et `{"api_url": "https://api…"}` dans `dist/config.json`.
- Déposer les clés **publiques** des manifests dans `dist/trust/manifest-keys.json` : `{"keys":[{"kid":"…","public_key":"<base64url>"}]}`. Sans ce fichier, aucun contenu n’est accepté et le service worker ne s’installe pas.
- Mode kiosque conseillé : Chrome `--kiosk --autoplay-policy=no-user-gesture-required`.
