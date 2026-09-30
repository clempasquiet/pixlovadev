#!/bin/sh
# Premier démarrage du cluster de recette (ADR-015) : base possédée par le rôle
# propriétaire créé par bootstrap-roles.sql. Les mots de passe des rôles sont posés à
# chaque démarrage par le service `db-roles` (roles.sql). Rejoué seulement sur un volume vide.
set -eu
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
  -c 'CREATE DATABASE pixlova OWNER pixlova_owner'
