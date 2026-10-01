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

Cinq dépôts privés, chacun déployé en continu par `build`, demandés par le responsable produit (2026-10-01), plus le profil d’organisation. Le cœur cloud reste un monorepo ; les deux Players, le site et le déploiement en sortent.

| Dépôt | Contenu | Livrable et version |
|---|---|---|
| `Pixlova/platform` | `apps/{api,workers,dashboard,admin-console}`, tous les `packages/*`, `docs/` (cahier des charges, ADR, planning, opérations), `scripts/`, `infra/dev` | Images `ghcr.io/pixlova/{api,worker,dashboard,admin}` taguées `vAAAA.MM.N` ; paquets npm `@pixlova/contracts`, `@pixlova/render-engine`, `@pixlova/player-core` en SemVer |
| `Pixlova/player-web` | `apps/web-player` | Image statique `ghcr.io/pixlova/player-web` (Caddy), SemVer ; servie sur `player.pixlova.com` |
| `Pixlova/player-natif` | `native/{agent,renderer,contracts}`, `Cargo.*`, `rust-toolchain.toml`, `packaging/linux`, `apps/player-shell` (page embarquée), `apps/render-lab` (comparaison Chromium / WebKitGTK) | Paquet signé du Player natif, SemVer `vX.Y.Z` (règle d’ADR-019) |
| `Pixlova/www` | `apps/site` avec sa configuration autonome | Image `ghcr.io/pixlova/www`, déployée depuis `main` |
| `Pixlova/build` | Infrastructure en code : Terraform (cluster, répartiteur, S3, bases), charts Helm, versions déployées par environnement, recette Compose actuelle (`infra/recette`), workflows réutilisables | Aucune image ; chaque fusion change ce qui tourne (GitOps) |
| `Pixlova/.github` | Profil d’organisation, modèle de PR, modèles d’issues | Aucun |

L’API, le worker, le dashboard, l’administration et les paquets partagés restent ensemble dans `platform` : ils partagent le schéma PostgreSQL, les migrations, les contrats et l’arbitrage des priorités, qu’`AGENTS.md` interdit de dupliquer. Chaque dépôt garde son propre `Dockerfile` ; l’image se construit là où vit le code.

### Paquets partagés entre dépôts

Les Players consomment du code TypeScript de `platform`. Il est publié sur **GitHub Packages (npm)** sous la portée `@pixlova`, qui correspond au nom de l’organisation :

| Paquet | Contenu | Consommateurs |
|---|---|---|
| `@pixlova/contracts` | Schémas, types, vérifications et **vecteurs communs** (`fixtures/`, PROTO-021) | `player-web`, `player-natif` (TypeScript et tests Rust) |
| `@pixlova/render-engine` | Moteur de rendu unique (ADR-005) | `player-web`, `player-natif` (page embarquée, banc de rendu) |
| `@pixlova/player-core` | Lecture partagée entre Player Web et natif (ADR-013) | `player-web`, `player-natif` |

- **Versions** : SemVer indépendant par paquet, géré par Changesets dans `platform`. Une version majeure de `@pixlova/contracts` signale un protocole incompatible avec les Players déployés.
- **Publication** : workflow sur `main` de `platform` qui publie les versions annoncées par Changesets (`permissions: packages: write`, `GITHUB_TOKEN`), avec provenance. Le `platform` lui-même continue d’utiliser `workspace:*`.
- **Consommation** : versions exactes dans le `package.json` des Players et lockfile commité ; Renovate (ou Dependabot) ouvre la PR de montée de version, et la CI du Player la valide. Les tests Rust lisent les vecteurs dans `node_modules/@pixlova/contracts/fixtures` après un `pnpm install` dans `player-natif`.
- **Coût assumé** : un changement de `player-core` ou du moteur de rendu demande une publication puis une PR de montée dans chaque Player. C’est le prix de versions lisibles par Player.

### Tests de bout en bout entre dépôts

Les parcours qui démarraient l’API depuis les sources la démarrent depuis les **images publiées** au tag épinglé, avec PostgreSQL éphémère :

- `player-web` : `test:browser` lance `ghcr.io/pixlova/api` et `worker` au lieu des devDependencies `@pixlova/api`, `@pixlova/workers`, `@pixlova/db`. L’amorçage des données de test passe par l’API ou par un script d’amorçage livré dans l’image (`apps/api/scripts`), pas par l’import de `@pixlova/db`.
- `player-natif` : `e2e-native-player.mjs` déménage dans ce dépôt et fait de même.
- `platform` garde des tests de contrat côté serveur pour les routes Player, afin de détecter une rupture avant publication.

### Historique git

- `platform` = **transfert** de `clempasquiet/pixlovadev` vers l’organisation puis renommage. Le transfert conserve l’historique, les PR #1 à #33, les issues et les clés de déploiement, et redirige l’ancienne URL. Les dossiers partis ailleurs sont ensuite supprimés par une PR ordinaire.
- `player-web`, `player-natif`, `www`, `build` = extraction avec `git filter-repo --path …` depuis un clone frais, en ne gardant que leurs chemins. Les commits gardent auteurs et dates ; le premier commit propre au nouveau dépôt renvoie au SHA d’origine dans `platform`.
- Aucun force-push ni réécriture sur `platform` : les extractions se font sur des clones jetables poussés vers des dépôts neufs.

### CI

- `platform` : format, lint, build, typecheck, tests, migrations, tests navigateur du dashboard et de l’administration ; publication des paquets npm et des images GHCR sur `main` ; recette jetable en récupérant `Pixlova/build` au ref épinglé.
- `player-web` : format, lint, build, tests unitaires, `test:browser` contre les images de l’API, image.
- `player-natif` : `rust` (fmt, clippy, tests), `native-render` (banc de rendu Chromium puis WebKitGTK sous Xvfb), `native-e2e` contre les images de l’API, construction et signature du paquet hors CI publique des clés.
- `www` : format, lint, build, tests unitaires et navigateur, image.
- `build` : `docker compose config`, ShellCheck, recette jetable sur les derniers tags publiés. Les autres dépôts appellent ses workflows réutilisables (`uses: Pixlova/build/.github/workflows/…@<sha>`) pour ne pas recopier l’installation Node, pnpm et Rust.
- Lecture privée entre dépôts (paquets npm, images GHCR, workflows réutilisables) : accès accordé dans les réglages des paquets et du dépôt `build` à l’organisation, `GITHUB_TOKEN` en lecture ; aucun jeton personnel large.
- Règle d’`AGENTS.md` conservée : toute commande de build ou de test est documentée dans le dépôt qui l’ajoute.

### Recette et VPS

Aujourd’hui le VPS fait `git pull` puis `docker compose up -d --build` sur tout le dépôt. Après migration :

1. Le VPS clone seulement `Pixlova/build` (nouvelle clé de déploiement en lecture seule).
2. `compose.yaml` référence `ghcr.io/pixlova/<service>:<tag>` au lieu de `build:`, avec un digest par livrable fixé dans `environments/recette.env`. La passerelle Caddy route `/api`, `/player`, `/webhooks` vers `api`, le dashboard vers `dashboard` et le Player Web vers `player-web`, comme aujourd’hui mais vers des conteneurs séparés.
3. Le VPS s’authentifie une fois sur GHCR (`docker login ghcr.io`) avec un jeton en lecture seule des paquets.
4. Les mises à jour ne se font plus à la main : l’agent de déploiement applique les digests fixés dans `build` (voir « Déploiement continu par dépôt »). Volumes, secrets, tunnel Cloudflare et sauvegardes ne bougent pas.

Le guide `deployer-recette-vps.md` et `docs/operations/RECETTE.md` sont mis à jour dans la phase concernée.

### Rôle de `build` : l’infrastructure décrite en code (GitOps)

La production cible n’est pas un serveur unique : répartition de charge, cluster Kubernetes, stockage S3, base PostgreSQL, Redis, DNS. `build` est le dépôt qui **décrit toute cette infrastructure et les versions qui y tournent**. Les dépôts applicatifs produisent des images ; `build` dit où, combien et quelle version.

| Dossier de `build` | Contenu | Outil |
|---|---|---|
| `terraform/` | Ressources du fournisseur : cluster Kubernetes, répartiteur de charge, buckets S3, PostgreSQL et Redis gérés, DNS, réseaux | OpenTofu/Terraform, état distant chiffré |
| `charts/` | Un chart Helm par service (`api`, `worker`, `dashboard`, `admin`, `player-web`, `www`) : réplicas, ressources, sondes, `HorizontalPodAutoscaler`, `Ingress`, `NetworkPolicy` | Helm |
| `environments/production/`, `environments/staging/` | Valeurs par environnement, dont le **digest d’image** de chaque service | Argo CD (ou Flux) |
| `recette/` | La recette Docker Compose actuelle du VPS (ADR-015), conservée telle quelle | Docker Compose |
| `.github/workflows/` | Workflows réutilisables (Node, pnpm, Rust, publication GHCR) appelés par les autres dépôts | GitHub Actions |

Aucun secret en clair : les secrets vivent dans le gestionnaire du fournisseur ou sont chiffrés (SOPS ou Sealed Secrets) ; `build` ne contient que leurs références.

### Déploiement continu par dépôt

Demande du responsable produit (2026-10-01) : une mise à jour fusionnée dans un dépôt met à jour l’infrastructure, pour chaque dépôt.

1. **Dépôt applicatif** (`platform`, `player-web`, `www`) : après fusion sur `main` et CI verte, l’image est construite, taguée avec le SHA, publiée sur GHCR, puis un `repository_dispatch` envoie à `build` le service et le **digest** (`sha256:…`). Ces dépôts ne détiennent aucun accès aux serveurs.
2. **`build`** ouvre une PR qui met à jour le digest dans `environments/staging/` (et `recette/`). La CI de `build` valide (`helm lint`, `kubeconform`, `tofu plan`, recette jetable Compose). Verte → **fusion automatique**.
3. **Argo CD**, installé dans le cluster, surveille `build` et applique le changement : déploiement progressif (*rolling update*), sondes de disponibilité, retour automatique si les nouveaux pods ne deviennent pas sains. Rien ne pousse vers le cluster depuis GitHub. Sur le VPS de recette, un petit agent (minuteur systemd) fait l’équivalent avec Docker Compose et les scripts de fumée.
4. **Production** : quand `staging` est vert sur un ensemble de digests, `build` ouvre une PR qui recopie **les mêmes digests** dans `environments/production/`. Sa fusion par le responsable produit est l’autorisation de mise en production ; Argo CD l’applique. Rien n’est reconstruit entre `staging` et la production.
5. **Infrastructure elle-même** (nouveau bucket, taille du cluster, règle du répartiteur) : PR sur `terraform/`, `tofu plan` affiché dans la PR, `tofu apply` seulement après fusion et approbation, jamais automatiquement en production.
6. **Retour arrière** : revert de la PR dans `build`. L’historique de `build` est le journal de tous les déploiements.

Garde-fous :

- **Migrations** : exécutées par un `Job` Kubernetes avant le déploiement de l’API (hook Argo CD `PreSync`), en mode *expand / contract* pour que l’API N et N+1 tournent ensemble pendant le *rolling update* et que le retour arrière reste possible. Une migration destructive se fait sur deux livraisons.
- **Plusieurs réplicas** : l’API et le worker doivent être sans état local pour tourner derrière le répartiteur. La file de tâches PostgreSQL à bail (ADR-009) est déjà faite pour plusieurs workers ; les autres états en mémoire (limites de débit, caches, sessions) sont à **vérifier** avant la mise en production et à déplacer vers Redis ou PostgreSQL si besoin. Ce point est un prérequis du lot de mise en production, pas du découpage.
- **Ordre entre dépôts** : un changement qui touche l’API et un Player passe d’abord par `platform`, compatible avec les deux versions, puis par le Player (règle de version de `@pixlova/contracts`).
- **Player natif** : pas de déploiement automatique sur les écrans. Un tag `vX.Y.Z` de `player-natif` construit, signe et dépose le paquet en **brouillon** ; la publication aux Players reste une action de l’administration avec TOTP et périmètre (ADR-019).
- **Choix ouverts** : fournisseur cloud, Kubernetes géré ou non, Argo CD ou Flux, stockage S3 du fournisseur ou autre. Ils relèvent du lot de mise en production et ne bloquent pas le découpage : le format de `build` reste le même.

### Ordre de migration

Chaque phase se termine par une CI et une recette vertes et peut s’arrêter là.

0. **Préparation** (responsable produit) : installer l’app GitHub Claude sur l’organisation Pixlova avec accès aux dépôts ; activer Actions, GHCR et GitHub Packages ; aucune PR ouverte sur `pixlovadev`.
1. **Transfert** de `pixlovadev` vers `Pixlova/platform`. Sur le VPS : `git remote set-url origin` vers la nouvelle URL.
2. **`www`** : extraction, CI, image ; suppression d’`apps/site` dans `platform`. Répétition à faible risque.
3. **Images, `build` et déploiement continu de la recette** : `platform` et `www` publient leurs images (dashboard séparé de la passerelle) ; extraction d’`infra/recette` vers `build/recette` en passant de `build:` à des digests ; installation de l’agent sur le VPS (commandes lancées par le responsable produit). À partir d’ici, chaque fusion sur `main` met la recette à jour.
4. **Paquets npm** : Changesets et publication de `contracts`, `render-engine`, `player-core` depuis `platform`.
5. **`player-web`** : extraction, dépendances vers les paquets publiés, e2e contre les images ; image `player-web` dans la recette ; suppression dans `platform`.
6. **`player-natif`** : extraction avec `player-shell` et `render-lab`, vecteurs lus depuis `@pixlova/contracts`, e2e contre les images, paquet signé déposé en brouillon sur tag ; suppression de `native/`, `packaging/` et des jobs Rust dans `platform`.
7. **Production** : une fois le fournisseur choisi (lot de mise en production), `terraform/` crée cluster, répartiteur, S3 et bases ; charts Helm et Argo CD ; environnement `staging` puis PR « production ».

## Options évaluées

| Option | Pour | Contre | Verdict |
|---|---|---|---|
| Garder le monorepo, versions par composant | Aucune migration | Ne répond pas à la demande | Écartée |
| Un dépôt par application et par paquet (~20) | Séparation maximale | Schéma, migrations et priorités dupliqués ou publiés en lockstep ; débogage à travers des versions décalées | Écartée |
| Quatre dépôts, Player Web dans `platform` (première version de cette proposition) | Aucun paquet npm à publier | Le Player Web n’a pas sa version propre | Remplacée à la demande du responsable produit |
| Artefacts tar épinglés au lieu de npm | Pas de registre | Rejoue à la main ce que fait npm dès qu’un consommateur TypeScript existe | Écartée |
| **Cinq dépôts, paquets partagés sur GitHub Packages** | Chaque Player et le site ont leur version, leur CI et leur image ; le cœur cloud reste cohérent | Publication et montée de version pour `contracts`, `render-engine`, `player-core` | **Retenue** |

## Conséquences et validation

- **Compatibilité Player** : un Player déployé peut avoir plusieurs versions de retard. `platform` doit continuer d’accepter les protocoles des Players encore en service ; la version majeure de `contracts-vX` rend un changement incompatible visible dans `player`.
- **Sécurité** : aucun secret ni clé privée n’entre dans les nouveaux dépôts ; les clés de signature des releases restent hors dépôt (ADR-019). Images et paquets restent privés à l’organisation. Les jetons inter-dépôts sont en lecture seule.
- **Coût** : GitHub Actions et GHCR sur dépôts privés consomment le quota de l’organisation ; à surveiller.
- **Traçabilité** : les PR passées restent dans `platform` ; les ADR et le cahier des charges y restent la source, les autres dépôts y renvoient depuis leur README.
- **Critères d’acceptation** : pour chaque phase, CI verte dans les dépôts concernés, recette du VPS fonctionnelle après bascule (fumée `smoke.mjs`, `admin-smoke.mjs`, `site-smoke.mjs`), sauvegarde et restauration exercées après la phase 3.
- **Réexamen** : si un service cloud doit être livré à un rythme différent de l’API, ou si les montées de version des paquets partagés deviennent un frein mesuré.
