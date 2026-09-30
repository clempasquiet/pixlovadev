#!/bin/sh
# Restauration d’une sauvegarde de recette (ADR-015) : remplace la base et les objets
# actuels. Sert au retour arrière après une mise à jour et à la reprise après sinistre.
#
#   infra/recette/scripts/restore.sh infra/recette/backups/<horodatage>
set -eu
source_dir=$(cd "$1" && pwd)
cd "$(dirname "$0")/.."
compose() { docker compose -f compose.yaml "$@"; }
(cd "$source_dir" && sha256sum -c --quiet SHA256SUMS)
if ! cmp -s "$source_dir/env.backup" .env; then
  echo "Le .env actuel diffère de celui de la sauvegarde : restaurer d’abord env.backup en .env" >&2
  echo "(mots de passe et clés de données doivent correspondre aux données)." >&2
  exit 1
fi

echo "Arrêt des services applicatifs…"
compose stop cloudflared gateway api worker 2>/dev/null || compose stop gateway api worker
compose up -d --wait postgres s3

echo "Base de données…"
compose exec -T postgres psql -U pixlova_admin -d postgres -v ON_ERROR_STOP=1 \
  -c 'DROP DATABASE IF EXISTS pixlova WITH (FORCE)' \
  -c 'CREATE DATABASE pixlova OWNER pixlova_owner'
compose exec -T postgres pg_restore -U pixlova_admin -d pixlova --exit-on-error < "$source_dir/pixlova.dump"

echo "Objets du stockage…"
compose stop s3
s3=$(compose ps -a -q s3)
docker run --rm --network none --volumes-from "$s3" -v "$source_dir:/backup:ro" \
  postgres:16.15@sha256:1a6ab3f5345eb6dbe04a1349529caabdb0ab09293a09590fad07b2246bfa4b54 sh -c 'find /data -mindepth 1 -delete && tar --xattrs --xattrs-include="user.*" -C /data -xzf /backup/objects.tar.gz'

echo "Redémarrage…"
compose up -d --wait
echo "Restauration terminée depuis $source_dir"
