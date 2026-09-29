-- Droits des tables d’appairage et d’authentification Player (ADR-008).
-- Enregistrement et appairage précèdent tout tenant : rôle système uniquement.
GRANT SELECT, INSERT, UPDATE ON pairing_sessions TO pixlova_system;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON player_credentials, player_auth_challenges, player_access_tokens
  TO pixlova_app, pixlova_system;--> statement-breakpoint
GRANT SELECT, INSERT ON idempotency_keys TO pixlova_app, pixlova_system;--> statement-breakpoint
GRANT DELETE ON idempotency_keys TO pixlova_system;
