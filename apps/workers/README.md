# @pixlova/workers

Workers de fond ([ADR-009](../../docs/architecture/adr/0009-bibliotheque-media-stockage-pipeline.md)) :

- **file de tâches PostgreSQL** : réclamation `FOR UPDATE SKIP LOCKED` sous bail renouvelé ; un bail expiré, par exemple après l’arrêt brutal d’un worker, rend la tâche à un autre worker ;
- **préparation des médias** (`media.ingest`) :
  - octets vérifiés depuis la quarantaine (taille, SHA-256), puis format réel identifié par signature ;
  - images avec sharp/libvips, restreint aux décodeurs JPEG, PNG et WebP ;
  - vidéos avec FFprobe/FFmpeg : démuxeur imposé, fichiers locaux uniquement, délais bornés ;
  - variantes immuables `original`, `playback` et `thumbnail` ;
- **purge** (`media.purge`) des médias arrivés à échéance de corbeille ;
- **compilation des manifests** (`compile_display`, [ADR-011](../../docs/architecture/adr/0011-programmation-compilation-manifests.md)) : snapshot cohérent, préflight, signature, puis enregistrement seulement si la révision compilée est encore la révision désirée ;
- **balayages** : sessions d’upload expirées, quarantaine, purges dues, tâches anciennes, renouvellement des horizons de manifest.

Les écritures métier passent par le rôle applicatif sous `withTenant` (RLS). Le rôle système sert uniquement à réclamer les tâches et à balayer entre tenants.

## Lancer

```sh
pnpm --filter @pixlova/workers run build
pnpm --filter @pixlova/workers run start:dev   # lit apps/api/.env (base, stockage)
```

Prérequis : `ffmpeg` et `ffprobe` dans le `PATH`.

Variables obligatoires, en plus de la base et du stockage :

- `PIXLOVA_MANIFEST_KEY_ID` : identifiant de la clé ;
- `PIXLOVA_MANIFEST_SIGNING_KEY` : graine Ed25519 de 32 octets en base64url, jamais versionnée (génération dans `apps/api/.env.example`).

Variables facultatives :

- `PIXLOVA_WORKER_CONCURRENCY` : 2 par défaut ;
- `PIXLOVA_WORKER_TMP_DIR` : répertoire temporaire, un sous-dossier par tâche ;
- `PIXLOVA_MEDIA_TRASH_RETENTION_DAYS`.

## Tests

```sh
PIXLOVA_TEST_DATABASE_URL=… pnpm --filter @pixlova/workers test
```

Les fichiers de test sont générés à la volée par sharp et FFmpeg : aucun média client n’est versionné. Ils couvrent :

- fichiers valides, tronqués, faux types, formats refusés, dimensions excessives ;
- stockage indisponible, worker arrêté, fichier qui fait tomber le worker, rejeu et purge.

Le pilote S3 de `@pixlova/storage` se teste contre un service compatible (`moto`, comme en CI) :

```sh
python3 -m venv .venv-moto && .venv-moto/bin/pip install "moto[server]==5.2.3"
.venv-moto/bin/moto_server -p 5055 &
PIXLOVA_TEST_S3_ENDPOINT=http://127.0.0.1:5055 pnpm --filter @pixlova/storage test
```
