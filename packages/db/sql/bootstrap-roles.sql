-- Rôles PostgreSQL pixlova (ADR-004), à exécuter une fois par cluster par un administrateur,
-- AVANT les migrations. Les mots de passe et l’attribut LOGIN sont fixés par l’environnement
-- (secrets hors dépôt) : ALTER ROLE … LOGIN PASSWORD …
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pixlova_owner') THEN
    -- Propriétaire du schéma ; exécute les migrations.
    CREATE ROLE pixlova_owner NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pixlova_app') THEN
    -- API et workers sous contexte tenant : soumis aux policies RLS.
    CREATE ROLE pixlova_app NOLOGIN NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pixlova_system') THEN
    -- Opérations explicitement inter-tenants (authentification Player, outbox, webhooks).
    CREATE ROLE pixlova_system NOLOGIN BYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pixlova_platform') THEN
    -- Administration plateforme privée (ADR-016) : lecture de support bornée par colonnes,
    -- tables des opérateurs ; aucun autre rôle n’accède à ces dernières.
    CREATE ROLE pixlova_platform NOLOGIN BYPASSRLS;
  END IF;
END
$$;
