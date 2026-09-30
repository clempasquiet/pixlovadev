-- Droits de la supervision (ADR-014). Timeline en ajout seul ; statut, commandes,
-- incidents et maintenances évoluent ; seules les captures expirées sont supprimées, par
-- la purge du worker (rôle système).
GRANT SELECT, INSERT, UPDATE ON player_status, player_commands, screenshots, alerts, maintenance_windows TO pixlova_app, pixlova_system;--> statement-breakpoint
GRANT SELECT, INSERT ON timeline_events TO pixlova_app, pixlova_system;--> statement-breakpoint
GRANT DELETE ON screenshots TO pixlova_system;
