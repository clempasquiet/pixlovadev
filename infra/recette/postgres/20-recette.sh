#!/bin/sh
# Premier démarrage du cluster de recette (ADR-004, ADR-015) : ouvre les rôles créés par
# bootstrap-roles.sql avec les mots de passe de l’environnement, puis crée la base.
# N’est rejoué par l’image officielle que sur un volume de données vide.
set -eu
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
  -v owner="$PIXLOVA_DB_OWNER_PASSWORD" \
  -v app="$PIXLOVA_DB_APP_PASSWORD" \
  -v system="$PIXLOVA_DB_SYSTEM_PASSWORD" <<'SQL'
ALTER ROLE pixlova_owner LOGIN PASSWORD :'owner';
ALTER ROLE pixlova_app LOGIN PASSWORD :'app';
ALTER ROLE pixlova_system LOGIN PASSWORD :'system';
CREATE DATABASE pixlova OWNER pixlova_owner;
SQL
