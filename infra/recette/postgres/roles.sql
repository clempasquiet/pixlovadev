-- Rôles de l’instance (ADR-004, ADR-016), rejoués à chaque démarrage par le service
-- `db-roles` après bootstrap-roles.sql : un nouveau rôle (pixlova_platform) apparaît sans
-- recréer le cluster, et les mots de passe suivent `.env`. Aucun secret en argument.
\set ON_ERROR_STOP on
\getenv owner PIXLOVA_DB_OWNER_PASSWORD
\getenv app PIXLOVA_DB_APP_PASSWORD
\getenv system PIXLOVA_DB_SYSTEM_PASSWORD
\getenv platform PIXLOVA_DB_PLATFORM_PASSWORD
ALTER ROLE pixlova_owner LOGIN PASSWORD :'owner';
ALTER ROLE pixlova_app LOGIN PASSWORD :'app';
ALTER ROLE pixlova_system LOGIN PASSWORD :'system';
ALTER ROLE pixlova_platform LOGIN PASSWORD :'platform';
