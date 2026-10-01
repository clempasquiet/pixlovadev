-- Droits du registre des releases (ADR-019). Seule l’administration plateforme dépose,
-- publie ou bloque une release ; l’API Player ne lit que ce qu’elle distribue. Les
-- rapports de mise à jour sont écrits par l’API sous contexte tenant (RLS) et consultés
-- par l’administration pour le résultat du déploiement.
GRANT SELECT, INSERT, DELETE ON player_releases TO pixlova_platform;--> statement-breakpoint
GRANT UPDATE (artifact_key, status, notes, updated_at, published_at, published_by, blocked_at, blocked_by, block_reason) ON player_releases TO pixlova_platform;--> statement-breakpoint
GRANT SELECT (id, version, version_major, version_minor, version_patch, os, architecture, status, envelope, sha256, size_bytes, artifact_key, published_at) ON player_releases TO pixlova_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON player_update_reports TO pixlova_app;--> statement-breakpoint
GRANT SELECT (id, organization_id, player_id, release_id, version, state, code, observed_at, received_at) ON player_update_reports TO pixlova_platform;
