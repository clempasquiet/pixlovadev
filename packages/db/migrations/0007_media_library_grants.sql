-- Droits de la bibliothèque média, des tâches et des compteurs d’usage (ADR-009).
-- La purge définitive (corbeille expirée, abandon d’upload) supprime des lignes : DELETE
-- est accordé au rôle applicatif sous RLS, les tâches système passent par pixlova_system.
GRANT SELECT, INSERT, UPDATE, DELETE ON
  media_folders, media, upload_sessions, media_assets, tags, media_tags
  TO pixlova_app, pixlova_system;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON usage_counters TO pixlova_app, pixlova_system;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON jobs TO pixlova_app, pixlova_system;--> statement-breakpoint
GRANT DELETE ON jobs TO pixlova_system;
