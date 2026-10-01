-- Changements d’abonnement (ADR-017, tranche 2). L’API enregistre la demande, l’identifiant
-- de planification Stripe et la sélection des Displays à conserver ; seule la projection
-- (rôle système) constate l’effet et applique la sélection à l’échéance.
GRANT UPDATE (stripe_schedule_id, keep_display_ids, selection_status, effective_at) ON billing_changes TO pixlova_app;--> statement-breakpoint
GRANT SELECT (subscription_id, effective_at, selection_status, keep_display_ids) ON billing_changes TO pixlova_platform;
