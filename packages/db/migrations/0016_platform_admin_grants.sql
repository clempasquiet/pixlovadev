-- Droits du rôle d’administration plateforme (ADR-016). `pixlova_platform` contourne la
-- RLS pour les vues de support inter-organisations, mais ne lit que les colonnes utiles au
-- diagnostic : jamais d’empreinte de mot de passe, de secret TOTP, de jeton ni de contenu
-- d’email. Les rôles applicatifs n’ont, eux, aucun accès aux tables `platform_*`.
GRANT USAGE ON SCHEMA public TO pixlova_platform;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON platform_users, platform_sessions, platform_mfa_credentials, platform_activation_tokens TO pixlova_platform;--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON platform_user_roles TO pixlova_platform;--> statement-breakpoint
-- Journal d’audit en ajout seul, comme pour les autres rôles (SEC-016).
GRANT SELECT, INSERT ON audit_logs TO pixlova_platform;--> statement-breakpoint
-- Consultation de support (ADM-003, ADM-004).
GRANT SELECT ON organizations, memberships, membership_grants, sites, players, player_outputs, displays, display_assignments, player_status, alerts, usage_counters TO pixlova_platform;--> statement-breakpoint
GRANT SELECT (id, email_normalized, display_name, email_verified_at, status, mfa_enabled, created_at, updated_at) ON users TO pixlova_platform;--> statement-breakpoint
GRANT SELECT (id, user_id, created_at, last_seen_at, idle_expires_at, expires_at, revoked_at) ON user_sessions TO pixlova_platform;--> statement-breakpoint
GRANT SELECT (id, user_id, type, confirmed_at, created_at, revoked_at) ON mfa_credentials TO pixlova_platform;--> statement-breakpoint
GRANT SELECT (id, user_id, used_at) ON mfa_recovery_codes TO pixlova_platform;--> statement-breakpoint
GRANT SELECT (id, template, created_at, sent_at, attempts, next_attempt_at) ON email_outbox TO pixlova_platform;--> statement-breakpoint
GRANT SELECT (id, organization_id, kind, state, attempts, max_attempts, run_after, lease_expires_at, last_error, created_at, updated_at, finished_at) ON jobs TO pixlova_platform;--> statement-breakpoint
-- Actions de support bornées (ADR-016) : désactivation d’un compte, révocation des
-- sessions, réinitialisation du second facteur, relance d’une tâche en échec.
GRANT UPDATE (status, mfa_enabled, updated_at) ON users TO pixlova_platform;--> statement-breakpoint
GRANT UPDATE (revoked_at, revoke_reason) ON user_sessions TO pixlova_platform;--> statement-breakpoint
GRANT UPDATE (revoked_at) ON mfa_credentials TO pixlova_platform;--> statement-breakpoint
GRANT UPDATE (used_at) ON mfa_recovery_codes TO pixlova_platform;--> statement-breakpoint
GRANT UPDATE (state, attempts, run_after, last_error, finished_at, updated_at) ON jobs TO pixlova_platform;--> statement-breakpoint
-- Version du schéma appliquée (santé de la plateforme).
GRANT USAGE ON SCHEMA drizzle TO pixlova_platform;--> statement-breakpoint
GRANT SELECT ON drizzle.__drizzle_migrations TO pixlova_platform;
