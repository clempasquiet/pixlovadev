-- Droits des compositions (ADR-010). Versions publiées et dépendances : ajout seul pour
-- le rôle applicatif (immuabilité, CMP-007) ; aucune mise à jour ni suppression.
GRANT SELECT, INSERT, UPDATE ON compositions TO pixlova_app, pixlova_system;--> statement-breakpoint
GRANT SELECT, INSERT ON composition_versions, content_dependencies TO pixlova_app, pixlova_system;
