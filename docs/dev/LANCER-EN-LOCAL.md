# Lancer pixlova en local (développement)

Ce guide démarre l’API et le dashboard sur votre poste pour essayer le parcours disponible : compte, organisation, sites, membres, invitations et audit. Il ne concerne ni la recette ni la production (lot L09-I).

## Prérequis

- Node.js 24, Corepack, Git ([ADR-001](../architecture/adr/0001-outillage-workspace-versions.md)).
- **Docker Desktop** (Windows/macOS) ou Docker Engine (Linux) pour PostgreSQL et Redis.

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

## 4. Démarrer

Dans deux terminaux :

```sh
pnpm --filter @pixlova/api run start:dev      # API sur http://127.0.0.1:3000
pnpm --filter @pixlova/dashboard run dev      # dashboard sur http://localhost:5173
```

Ouvrir **http://localhost:5173**, puis « Créer un compte ». Les emails ne sont pas envoyés en développement : ils s’affichent dans le terminal de l’API. Copiez-y le lien de confirmation, puis plus tard les liens d’invitation.

## Arrêter et repartir de zéro

```sh
docker compose -f infra/dev/compose.yaml down        # arrêt, données conservées
docker compose -f infra/dev/compose.yaml down -v     # suppression des données locales
```
