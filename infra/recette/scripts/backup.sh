#!/bin/sh
# Sauvegarde de l’instance de recette (ADR-015) : base (pg_dump) et objets du bucket
# (archive avec attributs étendus, qui portent les métadonnées S3 de versitygw).
# Le dossier produit contient des données de test personnelles possibles : le garder hors
# du dépôt (backups/ est ignoré) et le copier hors du serveur.
#
#   infra/recette/scripts/backup.sh        → infra/recette/backups/<horodatage>/
set -eu
cd "$(dirname "$0")/.."
compose() { docker compose -f compose.yaml "$@"; }
stamp=$(date -u +%Y%m%dT%H%M%SZ)
target="backups/$stamp"
umask 077
mkdir -p "$target"

echo "Base de données…"
compose exec -T postgres pg_dump -U pixlova_admin -d pixlova --format=custom > "$target/pixlova.dump"

# Les objets sont immuables (clés uniques) : une copie à chaud après le dump couvre au
# moins tout ce que la base référence.
echo "Objets du stockage…"
s3=$(compose ps -q s3)
docker run --rm --network none --volumes-from "$s3":ro -v "$PWD/$target:/backup" \
  postgres:16.15@sha256:1a6ab3f5345eb6dbe04a1349529caabdb0ab09293a09590fad07b2246bfa4b54 tar --xattrs --xattrs-include='user.*' -C /data -czf /backup/objects.tar.gz .

cp .env "$target/env.backup"
(cd "$target" && sha256sum pixlova.dump objects.tar.gz env.backup > SHA256SUMS)
echo "Sauvegarde : infra/recette/$target (inclut .env : secret)"
