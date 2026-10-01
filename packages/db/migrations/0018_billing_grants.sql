-- Droits de la facturation (ADR-017). Le catalogue est global et lisible par l’API ; seule
-- l’administration plateforme le publie. La projection Stripe (abonnements, réductions,
-- état de synchronisation) n’est écrite que par le rôle système, à partir de l’état relu
-- chez Stripe : l’API sous contexte tenant ne peut ni s’accorder des droits, ni modifier un
-- abonnement. Les événements Stripe bruts ne sont accessibles qu’au rôle système.
GRANT SELECT ON plans, plan_prices TO pixlova_app, pixlova_system;--> statement-breakpoint
GRANT SELECT ON billing_customers, subscriptions, promotion_redemptions TO pixlova_app;--> statement-breakpoint
-- Création du client Stripe canonique au premier achat ; l’état de synchronisation n’accorde
-- aucun droit (seule la projection des abonnements, écrite par le rôle système, le fait).
GRANT INSERT ON billing_customers TO pixlova_app;--> statement-breakpoint
GRANT SELECT, INSERT ON billing_changes TO pixlova_app;--> statement-breakpoint
GRANT UPDATE (status, stripe_checkout_session_id, checkout_url, checkout_expires_at, failure_reason, updated_at) ON billing_changes TO pixlova_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON billing_customers, subscriptions, billing_changes, promotion_redemptions, stripe_webhook_events TO pixlova_system;--> statement-breakpoint
-- Administration plateforme (ADM-004, ADM-005) : publication du catalogue et consultation.
GRANT SELECT, INSERT ON plans, plan_prices TO pixlova_platform;--> statement-breakpoint
GRANT UPDATE (status, published_at) ON plans TO pixlova_platform;--> statement-breakpoint
GRANT UPDATE (active) ON plan_prices TO pixlova_platform;--> statement-breakpoint
GRANT SELECT ON billing_customers, subscriptions, promotion_redemptions TO pixlova_platform;--> statement-breakpoint
GRANT SELECT (id, organization_id, environment, kind, status, plan_id, plan_price_id, extra_display_slots, stripe_checkout_session_id, stripe_subscription_id, failure_reason, applied_at, created_at, updated_at) ON billing_changes TO pixlova_platform;--> statement-breakpoint
GRANT SELECT (id, environment, stripe_event_id, type, object_id, stripe_customer_id, stripe_created_at, status, attempts, error, received_at, processed_at) ON stripe_webhook_events TO pixlova_platform;
