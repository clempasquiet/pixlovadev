-- Droits des rôles applicatifs (ADR-004). Les rôles sont créés hors migration
-- (sql/bootstrap-roles.sql) ; les tables appartiennent au rôle qui exécute les migrations.
GRANT USAGE ON SCHEMA public TO pixlova_app, pixlova_system;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON
  organizations, users, memberships, sites, players, player_outputs, displays,
  display_assignments, display_groups, outbox_events
  TO pixlova_app, pixlova_system;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON display_group_members TO pixlova_app, pixlova_system;--> statement-breakpoint
-- Journal d’audit en ajout seul pour les comptes applicatifs (SEC-016).
GRANT SELECT, INSERT ON audit_logs TO pixlova_app, pixlova_system;--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE outbox_events_id_seq TO pixlova_app, pixlova_system;
