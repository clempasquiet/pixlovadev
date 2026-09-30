-- Développement local uniquement : mots de passe connus, jamais réutilisés ailleurs.
ALTER ROLE pixlova_owner LOGIN PASSWORD 'owner_dev';
ALTER ROLE pixlova_app LOGIN PASSWORD 'app_dev';
ALTER ROLE pixlova_system LOGIN PASSWORD 'system_dev';
CREATE DATABASE pixlova OWNER pixlova_owner;
