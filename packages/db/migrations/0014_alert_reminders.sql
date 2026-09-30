ALTER TABLE "alerts" ADD COLUMN "last_notified_at" timestamp with time zone;--> statement-breakpoint
-- Purge des événements de timeline au-delà de leur rétention [à valider] (ADR-014).
GRANT DELETE ON timeline_events TO pixlova_system;
