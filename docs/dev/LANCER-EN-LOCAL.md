# Lancer pixlova en local (développement)

Ce guide démarre l’API et le dashboard sur votre poste pour essayer le parcours disponible : compte, organisation, sites, membres, invitations, audit, appairage d’un Player simulé, Displays, remplacement et bibliothèque média. Il ne concerne ni la recette ni la production (lot L09-I).

## Prérequis

- Node.js 24, Corepack, Git ([ADR-001](../architecture/adr/0001-outillage-workspace-versions.md)).
- **Docker Desktop** (Windows/macOS) ou Docker Engine (Linux) pour PostgreSQL et Redis.
- **FFmpeg** (analyse et transcodage des vidéos par le worker média) :
  - Windows : `winget install Gyan.FFmpeg`, puis rouvrir le terminal ;
  - macOS : `brew install ffmpeg` ;
  - Linux : `sudo apt install ffmpeg`.

  `ffmpeg -version` et `ffprobe -version` doivent répondre dans le terminal qui lance le worker.

## 1. Services de données

```sh
docker compose -f infra/dev/compose.yaml up -d
```

Au premier démarrage, PostgreSQL crée les rôles `pixlova_owner`, `pixlova_app` et `pixlova_system`, avec des mots de passe de développement, ainsi que la base `pixlova`.

## 2. Installation, build et migrations

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm run build
```

Puis appliquer les migrations avec le rôle propriétaire.

Linux, macOS :

```sh
DATABASE_OWNER_URL=postgres://pixlova_owner:owner_dev@127.0.0.1:5432/pixlova pnpm --filter @pixlova/db migrate
```

Windows PowerShell :

```powershell
$env:DATABASE_OWNER_URL="postgres://pixlova_owner:owner_dev@127.0.0.1:5432/pixlova"; pnpm --filter @pixlova/db migrate
```

## 3. Configuration de l’API

Copier `apps/api/.env.example` en `apps/api/.env`. Remplacer `PIXLOVA_DATA_KEYS` par une clé générée :

```sh
node -e "console.log('dev:' + require('crypto').randomBytes(32).toString('base64'))"
```

Remplacer de même `PIXLOVA_STORAGE_LOCAL_SECRET` (secret des URLs signées du stockage local) :

```sh
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Les fichiers envoyés sont rangés dans `work/storage` à la racine du dépôt, un dossier ignoré par Git.

Remplacer enfin `PIXLOVA_MANIFEST_SIGNING_KEY`. C’est la graine de la clé qui signe les manifests des écrans ; le worker refuse de démarrer sans elle :

```sh
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

## 4. Démarrer

Dans trois terminaux :

```sh
pnpm --filter @pixlova/api run start:dev      # API sur http://127.0.0.1:3000
pnpm --filter @pixlova/workers run start:dev  # worker médias et manifests (lit apps/api/.env)
pnpm --filter @pixlova/dashboard run dev      # dashboard sur http://localhost:5173
```

Ouvrir **http://localhost:5173**, puis « Créer un compte ». Les emails ne sont pas envoyés en développement : ils s’affichent dans le terminal de l’API. Copiez-y le lien de confirmation, puis plus tard les liens d’invitation.

## Simuler un Player

En attendant les Players natif et Web (lot L06), un simulateur utilise le vrai protocole d’appairage et d’authentification. Il utilise une clé Ed25519 locale, envoie un heartbeat toutes les 30 s et déclare deux sorties virtuelles :

```sh
pnpm --filter @pixlova/api run simulate-player
```

Il affiche un code `XXXX-XXXX` à saisir dans **Players → Appairer un Player**. Il récupère aussi les manifests publiés (voir « Essayer la programmation »). Créez ensuite un Display dans **Écrans**, puis affectez-lui une sortie du Player simulé : le terminal affiche l’affectation reçue. Lancez un second simulateur pour essayer le remplacement d’un Player. Arrêtez le simulateur (Ctrl+C) : après 90 secondes, le Player apparaît hors ligne avec l’heure du dernier contact.

## Essayer la bibliothèque média

Dans **Bibliothèque**, glissez-déposez des images (JPEG, PNG, WebP) ou des vidéos (MP4, MOV, WebM). Chaque envoi affiche sa progression. Le worker vérifie ensuite chaque fichier et prépare ses variantes : les cartes passent de « En préparation » à « Prêt », ou à « Erreur » avec le motif. Une vidéo déjà compatible (MP4 H.264/AAC) est diffusée telle quelle ; les autres sont transcodées, ce qui prend plus de temps.

Sans worker lancé, les médias restent « En préparation » : c’est l’état attendu. Ils sont traités dès que le worker démarre. Le stockage gratuit est de 2 Go ; `PIXLOVA_DEV_STORAGE_BYTES` le modifie en développement.

## Essayer le créateur de compositions

Dans **Compositions**, créez une composition (paysage, portrait, bandeaux LED ou format libre), puis ajoutez textes, formes, images, vidéos, QR Code et horloge. Déplacez et redimensionnez les éléments sur le canvas ou saisissez leurs valeurs en pixels ; **Prévisualiser** montre le rendu des Players sur un écran existant ou un format libre. **Publier** crée une version immuable, refusée tant qu’une anomalie bloquante subsiste (média manquant, en préparation, supprimé…).

Les **Modèles** sont réservés aux offres payantes : `PIXLOVA_DEV_FEATURES=templates` (fichier `.env` d’exemple) les active en développement.

## Essayer la programmation

1. Dans **Playlists**, créez une playlist, ajoutez des images, vidéos ou compositions publiées, réglez durées et validités, puis **Publiez**.
2. Dans **Plannings**, ajoutez des créneaux (jours, heures, dates), choisissez les cibles, puis **Publiez** : le nombre d’écrans visés s’affiche. Les **Campagnes** ajoutent une période bornée et une priorité plus haute.
3. Sur la fiche d’un écran :
   - **Programme** explique ce qui joue et pourquoi (source, priorité, règles masquées), dans le fuseau de l’écran, pour un jour, une semaine ou un mois, y compris dans le futur ;
   - **Diffuser maintenant** interrompt la programmation pour une durée bornée ;
   - **Diffusion** distingue les versions désirée, préparée et appliquée.

Chaque publication fait compiler par le worker un manifest signé par écran affecté. Le simulateur télécharge chaque nouveau manifest à son heartbeat (30 s au plus). Il contrôle son schéma et sa cohérence, puis le déclare préparé et appliqué. Ces états sont **simulés** : il ne télécharge aucun asset et n’affiche rien. Les Players réels arrivent avec le lot L06.

## Arrêter et repartir de zéro

```sh
docker compose -f infra/dev/compose.yaml down        # arrêt, données conservées
docker compose -f infra/dev/compose.yaml down -v     # suppression des données locales
```

Après une suppression des données, supprimer aussi `work/storage` : ses fichiers ne correspondent plus à aucun média.
