-- Droits des rôles applicatifs sur les tables d’identité et d’accès (ADR-004, ADR-006).
GRANT SELECT, INSERT, UPDATE ON user_sessions, auth_tokens, mfa_credentials, mfa_recovery_codes
  TO pixlova_app, pixlova_system;--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON membership_grants, membership_grant_sites TO pixlova_app, pixlova_system;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON invitations TO pixlova_app, pixlova_system;--> statement-breakpoint
GRANT SELECT, INSERT ON invitation_sites TO pixlova_app, pixlova_system;--> statement-breakpoint
-- Outbox email : l’application écrit, seul le dispatcher (rôle système) lit, marque et purge.
GRANT INSERT ON email_outbox TO pixlova_app;--> statement-breakpoint
GRANT USAGE ON SEQUENCE email_outbox_id_seq TO pixlova_app, pixlova_system;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON email_outbox TO pixlova_system;
