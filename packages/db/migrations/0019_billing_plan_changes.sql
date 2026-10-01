ALTER TABLE "billing_changes" DROP CONSTRAINT "billing_changes_kind_check";--> statement-breakpoint
ALTER TABLE "billing_changes" DROP CONSTRAINT "billing_changes_status_check";--> statement-breakpoint
ALTER TABLE "billing_changes" ALTER COLUMN "plan_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "billing_changes" ALTER COLUMN "plan_price_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "billing_changes" ADD COLUMN "subscription_id" uuid;--> statement-breakpoint
ALTER TABLE "billing_changes" ADD COLUMN "effective_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "billing_changes" ADD COLUMN "proration_date" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "billing_changes" ADD COLUMN "stripe_schedule_id" text;--> statement-breakpoint
ALTER TABLE "billing_changes" ADD COLUMN "keep_display_ids" uuid[];--> statement-breakpoint
ALTER TABLE "billing_changes" ADD COLUMN "selection_status" text;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "stripe_schedule_id" text;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "pending_update" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "billing_changes" ADD CONSTRAINT "billing_changes_subscription_same_tenant_fk" FOREIGN KEY ("organization_id","subscription_id") REFERENCES "public"."subscriptions"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "billing_changes_one_open_change" ON "billing_changes" USING btree ("organization_id","environment") WHERE "billing_changes"."kind" <> 'subscribe' and "billing_changes"."status" in ('requested', 'pending_payment', 'scheduled');--> statement-breakpoint
ALTER TABLE "billing_changes" ADD CONSTRAINT "billing_changes_plan_check" CHECK (("billing_changes"."kind" = 'cancel') = ("billing_changes"."plan_id" is null and "billing_changes"."plan_price_id" is null));--> statement-breakpoint
ALTER TABLE "billing_changes" ADD CONSTRAINT "billing_changes_subscription_check" CHECK ("billing_changes"."kind" = 'subscribe' or "billing_changes"."subscription_id" is not null);--> statement-breakpoint
ALTER TABLE "billing_changes" ADD CONSTRAINT "billing_changes_selection_check" CHECK ("billing_changes"."selection_status" is null or "billing_changes"."selection_status" in ('pending', 'applied', 'invalid'));--> statement-breakpoint
ALTER TABLE "billing_changes" ADD CONSTRAINT "billing_changes_kind_check" CHECK ("billing_changes"."kind" in ('subscribe', 'upgrade', 'downgrade', 'cancel'));--> statement-breakpoint
ALTER TABLE "billing_changes" ADD CONSTRAINT "billing_changes_status_check" CHECK ("billing_changes"."status" in ('requested', 'pending_payment', 'applied', 'failed', 'cancelled', 'expired', 'scheduled'));