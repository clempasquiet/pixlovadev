# Site public pixlova

Site marketing ([ADR-017](../../docs/architecture/adr/0017-site-public-domaines.md)) : pages React rendues **au build** en HTML statique, servies par leur propre conteneur Caddy. Aucun React n’est envoyé au navigateur ; `src/site.js` gère le menu mobile, le calculateur de tarifs et le mur LED.

```sh
pnpm --filter @pixlova/site run build          # dist/ (origines : variables PIXLOVA_SITE_* ci-dessous)
python3 -m http.server -d apps/site/dist 8090  # aperçu local sur http://127.0.0.1:8090
pnpm --filter @pixlova/site test               # catalogue, pages, liens, indexation
pnpm --filter @pixlova/site run test:browser   # Chromium : clavier, mobile, calculateur (après le build)
```

| Variable de build | Rôle | Défaut |
|---|---|---|
| `PIXLOVA_SITE_ORIGIN` | Origine canonique (liens canoniques, sitemap) | `https://pixlova.com` |
| `PIXLOVA_SITE_APP_URL` | Dashboard : `/login` et `/register` | `https://app.pixlova.com` |
| `PIXLOVA_SITE_STATUS_URL` | Page d’état du service | aucun lien |
| `PIXLOVA_SITE_INDEXABLE` | `true` pour la seule production | `false` (`noindex`, `robots.txt` fermé) |

- `src/pages.tsx` : pages et textes ; `src/sections.tsx` : sections de la maquette validée ; `src/layout.tsx` : en-tête, pied de page, métadonnées.
- `src/catalog.ts` : catalogue **indicatif** (cahier des charges § 11.2) jusqu’à la publication du catalogue L08 ; le calculateur est précalculé au build.
- Pages légales : gabarit « en cours de validation », `noindex`, sans identité juridique tant que les textes ne sont pas validés.
- `Caddyfile` : CSP stricte, cache long des fichiers à empreinte, page 404. Image : cible `site` de `infra/docker/Dockerfile`.
