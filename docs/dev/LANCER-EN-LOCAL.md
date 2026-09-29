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

## 4. Démarrer

Dans trois terminaux :

```sh
pnpm --filter @pixlova/api run start:dev      # API sur http://127.0.0.1:3000
pnpm --filter @pixlova/workers run start:dev  # worker média (lit apps/api/.env)
pnpm --filter @pixlova/dashboard run dev      # dashboard sur http://localhost:5173
```

Ouvrir **http://localhost:5173**, puis « Créer un compte ». Les emails ne sont pas envoyés en développement : ils s’affichent dans le terminal de l’API. Copiez-y le lien de confirmation, puis plus tard les liens d’invitation.

## Simuler un Player

En attendant les Players natif et Web (lot L06), un simulateur utilise le vrai protocole d’appairage et d’authentification. Il utilise une clé Ed25519 locale, envoie un heartbeat toutes les 30 s et déclare deux sorties virtuelles :

```sh
pnpm --filter @pixlova/api run simulate-player
```

Il affiche un code `XXXX-XXXX` à saisir dans **Players → Appairer un Player**. Créez ensuite un Display dans **Écrans**, puis affectez-lui une sortie du Player simulé : le terminal affiche l’affectation reçue. Lancez un second simulateur pour essayer le remplacement d’un Player. Arrêtez le simulateur (Ctrl+C) : après 90 secondes, le Player apparaît hors ligne avec l’heure du dernier contact.

## Essayer la bibliothèque média

Dans **Bibliothèque**, glissez-déposez des images (JPEG, PNG, WebP) ou des vidéos (MP4, MOV, WebM). Chaque envoi affiche sa progression. Le worker vérifie ensuite chaque fichier et prépare ses variantes : les cartes passent de « En préparation » à « Prêt », ou à « Erreur » avec le motif. Une vidéo déjà compatible (MP4 H.264/AAC) est diffusée telle quelle ; les autres sont transcodées, ce qui prend plus de temps.

Sans worker lancé, les médias restent « En préparation » : c’est l’état attendu. Ils sont traités dès que le worker démarre. Le stockage gratuit est de 2 Go ; `PIXLOVA_DEV_STORAGE_BYTES` le modifie en développement.

## Arrêter et repartir de zéro

```sh
docker compose -f infra/dev/compose.yaml down        # arrêt, données conservées
docker compose -f infra/dev/compose.yaml down -v     # suppression des données locales
```

Après une suppression des données, supprimer aussi `work/storage` : ses fichiers ne correspondent plus à aucun média.
