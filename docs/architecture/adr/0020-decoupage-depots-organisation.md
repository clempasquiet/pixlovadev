# ADR-020 — Découpage du monorepo en dépôts de l’organisation GitHub Pixlova

- Statut : proposée (aucun dépôt créé, rien déplacé avant validation écrite du responsable produit)
- Date : 2026-10-01
- Ticket / lot : organisation du code (hors lot fonctionnel)
- Exigences concernées : PROTO-021 (vecteurs communs TypeScript/Rust), NAT-013 à NAT-015 (mises à jour signées du Player), invariants 3 à 5 d’`AGENTS.md`
- Décision remplaçant / remplacée par : complète [ADR-001](0001-outillage-workspace-versions.md) (workspace), [ADR-015](0015-infrastructure-recette.md) (recette) et [ADR-019](0019-registre-releases-player.md) (releases du Player)

## Problème et contraintes

Tout Pixlova vit dans `clempasquiet/pixlovadev` : 8 applications et 9 paquets TypeScript (pnpm), 3 crates Rust, le packaging Linux, l’infrastructure de recette, le cahier des charges et les ADR. Le responsable produit a créé l’organisation GitHub **Pixlova** et souhaite séparer les applications et services pour la lisibilité, le débogage, les versions et les mises à jour.

Couplages relevés dans le code (2026-10-01) :

| Couplage | Où | Conséquence |
|---|---|---|
| Schéma PostgreSQL et migrations Drizzle | `packages/db`, utilisé par `api`, `workers`, `billing`, `scheduling` et les tests de `dashboard`, `web-player`, `admin-console` | Un changement de schéma touche API, worker et écrans dans le même commit |
| Contrats et arbitrage des priorités | `packages/contracts`, `packages/scheduling`, `packages/render-engine`, `packages/player-core` | `AGENTS.md` interdit de dupliquer la logique de priorités entre cloud, preview et Player |
| Tests de bout en bout | `dashboard`, `web-player`, `admin-console` démarrent la vraie API et le vrai worker (devDependencies `@pixlova/api`, `@pixlova/workers`, `@pixlova/db`) | Séparer ces applications casse leurs tests ou impose de publier l’API comme paquet |
| Vecteurs communs | `native/contracts/tests/vectors.rs` lit `../../packages/contracts/fixtures` | Le Player Rust dépend d’un dossier du monde TypeScript |
| Page de lecture | `apps/player-shell/dist` est embarquée dans le paquet du Player natif (`packaging/linux/install.sh`) et partage `player-core` avec le Player Web (ADR-013) | Le Player natif a besoin d’un artefact construit côté TypeScript |
| Parcours natif | `apps/api/scripts/e2e-native-player.mjs` lance API, worker, agent et renderer | Test transverse cloud ↔ Player |
| Images de recette | `infra/docker/Dockerfile` construit API, worker, passerelle, admin et site depuis la racine | Le VPS clone tout le dépôt et construit sur place |
| Site public | `apps/site` : aucune dépendance `@pixlova/*`, image Caddy dédiée | Indépendant |

Contraintes : garder l’historique git, les PR et la traçabilité des exigences ; ne pas casser la recette du VPS ; aucune clé ni secret dans les dépôts ; le Player en service doit continuer sur son état local pendant toute migration (invariant 4).

## Décision

Découper selon les **cycles de livraison réels**, pas selon chaque application. Quatre dépôts privés, plus le profil d’organisation.

| Dépôt | Contenu | Livrable et version |
|---|---|---|
| `Pixlova/platform` | `apps/{api,workers,dashboard,admin-console,web-player,player-shell,render-lab}`, tous les `packages/*`, `docs/` (cahier des charges, ADR, planning, opérations), `scripts/`, `infra/dev`, `infra/docker` | Images Docker `ghcr.io/pixlova/{api,worker,gateway,admin}` taguées `platform-vAAAA.MM.N` + SHA ; artefacts `contracts-fixtures` et `player-shell` (voir plus bas) |
| `Pixlova/player` | `native/{agent,renderer,contracts}`, `Cargo.toml`, `Cargo.lock`, `rust-toolchain.toml`, `packaging/linux` | Paquet signé du Player natif, SemVer `vX.Y.Z` (déjà la règle d’ADR-019) |
| `Pixlova/site` | `apps/site` et sa configuration autonome (pnpm, TypeScript, ESLint, Prettier) | Image `ghcr.io/pixlova/site`, déployée depuis `main` |
| `Pixlova/deploy` | `infra/recette` (Compose, Caddyfile, scripts de sauvegarde, restauration, fumée) | Configuration du VPS ; tire des images par tag, ne construit plus rien |
| `Pixlova/.github` | Profil d’organisation, modèle de PR, modèles d’issues | Aucun |

`platform` reste un monorepo pnpm : l’API, le worker, les écrans et les paquets partagés changent ensemble (schéma, contrats, priorités) et se testent ensemble. Les séparer obligerait à publier neuf paquets en versions synchronisées et à déboguer à travers des versions décalées, l’inverse du but recherché. La lisibilité à l’intérieur de `platform` s’obtient par des jobs de CI filtrés par chemin et un README par application.

### Paquets partagés entre dépôts

Seuls trois artefacts traversent une frontière de dépôt, tous de `platform` vers `player` :

1. **`contracts-fixtures-X.Y.Z.tar.gz`** : `packages/contracts/fixtures` et `packages/contracts/schemas`.
2. **`player-shell-X.Y.Z.tar.gz`** : `apps/player-shell/dist`, embarqué dans le paquet du Player.
3. **`render-lab-X.Y.Z.tar.gz`** : `apps/render-lab/dist` et le relevé Chromium des compositions de référence, pour la comparaison avec WebKitGTK.

Ils sont publiés comme assets d’une release GitHub `contracts-vX.Y.Z` de `platform`, avec leur SHA-256. `X.Y.Z` suit le protocole : majeur = changement incompatible pour un Player déployé. `player` les épingle dans `upstream.toml` (version + SHA-256) ; un script `scripts/fetch-upstream.sh` les télécharge, vérifie l’empreinte et les décompresse dans `vendor/` (ignoré par git). Les vecteurs de `native/contracts/tests/vectors.rs` `PIXLOVA_TEST_SHELL_DIR` et `--lab-dir` pointent vers `vendor/`. Monter de version est une PR explicite dans `player`.

GitHub Packages (npm `@pixlova/*`) est écarté pour l’instant : aucun dépôt hors `platform` ne consomme de code TypeScript. Il redeviendra pertinent si un futur dépôt (SDK, intégration) en a besoin ; la portée `@pixlova` correspond déjà au nom de l’organisation.

### Historique git

- `platform` = **transfert** de `clempasquiet/pixlovadev` vers l’organisation puis renommage. Le transfert conserve historique, PR #1 à #32, issues, clés de déploiement et redirige l’ancienne URL. Les dossiers partis ailleurs sont ensuite supprimés par une PR ordinaire.
- `player` et `site` = extraction avec `git filter-repo` depuis un clone frais, en ne gardant que leurs chemins (`--path native --path packaging --path Cargo.toml --path Cargo.lock --path rust-toolchain.toml`, respectivement `--path apps/site`). Les commits gardent leurs auteurs et dates ; un message de premier commit renvoie au SHA d’origine dans `platform`.
- `deploy` = extraction de `infra/recette` de la même façon.
- Aucun force-push ni réécriture sur `platform` : les extractions se font sur des clones jetables poussés vers des dépôts neufs.

### CI

- `platform` : jobs actuels `typescript` (avec chemins filtrés par application quand c’est utile) ; nouveau job de publication sur `main` et sur tag qui construit et pousse les images vers GHCR (`permissions: packages: write`, jeton `GITHUB_TOKEN`, aucune clé ajoutée), puis lance la recette jetable `ci-recette.sh` en récupérant `Pixlova/deploy` au ref épinglé. Les jobs `rust`, `native-render` et `native-e2e` partent dans `player`.
- `player` : `rust` (fmt, clippy, tests avec `vendor/`), `native-render` (relevé WebKitGTK comparé au relevé Chromium livré dans l’artefact `render-lab`), `native-e2e` qui démarre l’image `ghcr.io/pixlova/api` et `worker` au tag épinglé avec PostgreSQL, au lieu de construire l’API.
- `site` : format, lint, build, tests unitaires et navigateur, image.
- `deploy` : validation `docker compose config`, ShellCheck des scripts, recette jetable sur les derniers tags publiés.
- Lecture d’un dépôt privé par un autre (assets de release, images GHCR) : une GitHub App de l’organisation ou un jeton fin en lecture seule, stocké en secret d’Actions de l’organisation. Aucun jeton personnel large.
- Règle d’`AGENTS.md` conservée : toute commande de build ou de test est documentée dans le dépôt qui l’ajoute.

### Recette et VPS

Aujourd’hui le VPS fait `git pull` puis `docker compose up -d --build` sur tout le dépôt. Après migration :

1. Le VPS clone seulement `Pixlova/deploy` (nouvelle clé de déploiement en lecture seule sur ce dépôt).
2. `compose.yaml` référence `ghcr.io/pixlova/<service>:${PIXLOVA_IMAGE_TAG}` au lieu de `build:`. Le VPS s’authentifie une fois sur GHCR (`docker login ghcr.io`) avec un jeton en lecture seule des paquets.
3. Mise à jour = changer `PIXLOVA_IMAGE_TAG` dans `.env`, `docker compose pull`, `docker compose up -d`. Retour arrière = remettre le tag précédent (déjà décrit par ADR-015 avec `PIXLOVA_IMAGE_TAG`).
4. Volumes, secrets `.env`, tunnel Cloudflare et sauvegardes ne bougent pas.

Le guide `deployer-recette-vps.md` et `docs/operations/RECETTE.md` seront mis à jour dans la même phase.

### Ordre de migration

Chaque phase est indépendante, se termine par une recette verte et peut s’arrêter là.

0. **Préparation** (responsable produit) : installer l’app GitHub Claude sur l’organisation Pixlova et lui donner accès aux dépôts concernés ; activer GitHub Actions et GHCR pour l’organisation ; attendre qu’aucune PR ne soit ouverte sur `pixlovadev`.
1. **Transfert** de `pixlovadev` vers `Pixlova/platform`. Sur le VPS : `git remote set-url origin` vers la nouvelle URL (la redirection couvre l’intervalle). Rien d’autre ne change.
2. **Site** : extraction vers `Pixlova/site`, CI propre, image publiée ; puis PR de suppression d’`apps/site` dans `platform` et bascule du service `site` de la recette sur l’image. Risque le plus faible, sert de répétition.
3. **Images publiées** : `platform` pousse ses images vers GHCR ; la recette passe de `build:` à `image:` en restant dans `platform`. Valide le flux par tags avant de déplacer l’infrastructure.
4. **Player** : publication des artefacts `contracts-vX.Y.Z` ; extraction vers `Pixlova/player` avec `upstream.toml` ; CI native verte côté `player` ; puis suppression de `native/`, `packaging/` et des jobs Rust dans `platform`.
5. **Deploy** : extraction de `infra/recette` vers `Pixlova/deploy` ; le VPS clone ce dépôt ; suppression dans `platform`.

## Options évaluées

| Option | Pour | Contre | Verdict |
|---|---|---|---|
| Garder le monorepo, versions par composant | Aucune migration | Ne répond pas à la demande de séparation ; le VPS continue de tout cloner | Écartée |
| Un dépôt par application et par paquet (~20) | Séparation maximale | Schéma, contrats et priorités dupliqués ou publiés en lockstep ; tests de bout en bout impossibles sans publier l’API ; débogage à travers des versions décalées | Écartée |
| Sous-modules git vers `platform` dans `player` | Pas d’artefact à publier | Checkout lourd, versions implicites, accès privé imbriqué dans la CI | Écartée au profit des artefacts épinglés |
| **Quatre dépôts par cycle de livraison** | Sépare ce qui se livre séparément (cloud, Player, site, déploiement) ; garde ensemble ce qui change ensemble | Trois artefacts à publier ; jeton de lecture inter-dépôts | **Retenue** |

## Conséquences et validation

- **Compatibilité Player** : un Player déployé peut avoir plusieurs versions de retard. `platform` doit continuer d’accepter les protocoles des Players encore en service ; la version majeure de `contracts-vX` rend un changement incompatible visible dans `player`.
- **Sécurité** : aucun secret ni clé privée n’entre dans les nouveaux dépôts ; les clés de signature des releases restent hors dépôt (ADR-019). Les images GHCR restent privées. Les jetons inter-dépôts sont en lecture seule.
- **Coût** : GitHub Actions et GHCR sur dépôts privés consomment le quota de l’organisation ; à surveiller.
- **Traçabilité** : les PR passées restent dans `platform` ; les ADR et le cahier des charges y restent la source, les autres dépôts y renvoient depuis leur README.
- **Critères d’acceptation** : pour chaque phase, CI verte dans les dépôts concernés, recette du VPS fonctionnelle après bascule (fumée `smoke.mjs`, `admin-smoke.mjs`, `site-smoke.mjs`), sauvegarde et restauration exercées après la phase 5.
- **Réexamen** : si un second service cloud doit être livré à un rythme différent de l’API, ou si un client externe consomme `@pixlova/contracts`.
