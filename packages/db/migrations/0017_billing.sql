CREATE TABLE "billing_changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"environment" text NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'requested' NOT NULL,
	"requested_by" uuid,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"plan_id" uuid NOT NULL,
	"plan_price_id" uuid NOT NULL,
	"extra_display_slots" integer DEFAULT 0 NOT NULL,
	"stripe_checkout_session_id" text,
	"checkout_url" text,
	"checkout_expires_at" timestamp with time zone,
	"stripe_subscription_id" text,
	"failure_reason" text,
	"applied_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_changes_org_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "billing_changes_environment_check" CHECK ("billing_changes"."environment" in ('test', 'live')),
	CONSTRAINT "billing_changes_kind_check" CHECK ("billing_changes"."kind" in ('subscribe')),
	CONSTRAINT "billing_changes_status_check" CHECK ("billing_changes"."status" in ('requested', 'pending_payment', 'applied', 'failed', 'cancelled', 'expired')),
	CONSTRAINT "billing_changes_extra_check" CHECK ("billing_changes"."extra_display_slots" >= 0)
);
--> statement-breakpoint
ALTER TABLE "billing_changes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "billing_customers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"environment" text NOT NULL,
	"stripe_customer_id" text NOT NULL,
	"sync_status" text DEFAULT 'pending' NOT NULL,
	"sync_error" text,
	"last_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_customers_org_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "billing_customers_environment_check" CHECK ("billing_customers"."environment" in ('test', 'live')),
	CONSTRAINT "billing_customers_sync_check" CHECK ("billing_customers"."sync_status" in ('pending', 'ok', 'error'))
);
--> statement-breakpoint
ALTER TABLE "billing_customers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "plan_prices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plan_id" uuid NOT NULL,
	"environment" text NOT NULL,
	"interval" text NOT NULL,
	"currency" char(3) NOT NULL,
	"base_amount_minor" integer NOT NULL,
	"extra_slot_amount_minor" integer,
	"base_stripe_price_id" text,
	"extra_slot_stripe_price_id" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plan_prices_environment_check" CHECK ("plan_prices"."environment" in ('test', 'live')),
	CONSTRAINT "plan_prices_interval_check" CHECK ("plan_prices"."interval" in ('month', 'year')),
	CONSTRAINT "plan_prices_currency_check" CHECK ("plan_prices"."currency" ~ '^[a-z]{3}$'),
	CONSTRAINT "plan_prices_amounts_check" CHECK ("plan_prices"."base_amount_minor" >= 0 and coalesce("plan_prices"."extra_slot_amount_minor", 0) >= 0),
	CONSTRAINT "plan_prices_extra_check" CHECK ("plan_prices"."extra_slot_stripe_price_id" is null or "plan_prices"."extra_slot_amount_minor" is not null)
);
--> statement-breakpoint
CREATE TABLE "plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"version" integer NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"is_fallback" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"included_display_slots" integer NOT NULL,
	"max_extra_display_slots" integer DEFAULT 0 NOT NULL,
	"entitlements" jsonb NOT NULL,
	"indicative" boolean DEFAULT true NOT NULL,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plans_status_check" CHECK ("plans"."status" in ('draft', 'published', 'archived')),
	CONSTRAINT "plans_key_check" CHECK ("plans"."key" ~ '^[a-z][a-z0-9_-]{1,39}$'),
	CONSTRAINT "plans_version_check" CHECK ("plans"."version" >= 1),
	CONSTRAINT "plans_slots_check" CHECK ("plans"."included_display_slots" >= 0 and "plans"."max_extra_display_slots" >= 0)
);
--> statement-breakpoint
CREATE TABLE "promotion_redemptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"environment" text NOT NULL,
	"subscription_id" uuid NOT NULL,
	"billing_change_id" uuid,
	"stripe_discount_id" text NOT NULL,
	"stripe_coupon_id" text,
	"stripe_promotion_code_id" text,
	"code_snapshot" text,
	"percent_off" numeric(5, 2),
	"amount_off_minor" integer,
	"currency" char(3),
	"duration" text,
	"duration_in_months" integer,
	"applied_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone,
	"applied_by" uuid,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "promotion_redemptions_environment_check" CHECK ("promotion_redemptions"."environment" in ('test', 'live'))
);
--> statement-breakpoint
ALTER TABLE "promotion_redemptions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "stripe_webhook_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"environment" text NOT NULL,
	"stripe_event_id" text NOT NULL,
	"type" text NOT NULL,
	"api_version" text,
	"object_id" text,
	"stripe_customer_id" text,
	"stripe_created_at" timestamp with time zone NOT NULL,
	"payload" jsonb,
	"status" text DEFAULT 'received' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	CONSTRAINT "stripe_webhook_events_environment_check" CHECK ("stripe_webhook_events"."environment" in ('test', 'live')),
	CONSTRAINT "stripe_webhook_events_status_check" CHECK ("stripe_webhook_events"."status" in ('received', 'processed', 'ignored', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"environment" text NOT NULL,
	"billing_customer_id" uuid NOT NULL,
	"stripe_subscription_id" text NOT NULL,
	"plan_id" uuid NOT NULL,
	"plan_price_id" uuid NOT NULL,
	"stripe_status" text NOT NULL,
	"extra_display_slots" integer DEFAULT 0 NOT NULL,
	"stripe_base_item_id" text,
	"stripe_extra_item_id" text,
	"stripe_created_at" timestamp with time zone NOT NULL,
	"current_period_start" timestamp with time zone,
	"current_period_end" timestamp with time zone,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"canceled_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"grace_until" timestamp with time zone,
	"last_synced_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subscriptions_org_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "subscriptions_environment_check" CHECK ("subscriptions"."environment" in ('test', 'live')),
	CONSTRAINT "subscriptions_status_check" CHECK ("subscriptions"."stripe_status" in ('incomplete', 'incomplete_expired', 'trialing', 'active', 'past_due', 'canceled', 'unpaid', 'paused')),
	CONSTRAINT "subscriptions_extra_check" CHECK ("subscriptions"."extra_display_slots" >= 0)
);
--> statement-breakpoint
ALTER TABLE "subscriptions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "billing_changes" ADD CONSTRAINT "billing_changes_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_changes" ADD CONSTRAINT "billing_changes_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_changes" ADD CONSTRAINT "billing_changes_plan_price_id_plan_prices_id_fk" FOREIGN KEY ("plan_price_id") REFERENCES "public"."plan_prices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_changes" ADD CONSTRAINT "billing_changes_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_customers" ADD CONSTRAINT "billing_customers_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_prices" ADD CONSTRAINT "plan_prices_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promotion_redemptions" ADD CONSTRAINT "promotion_redemptions_applied_by_users_id_fk" FOREIGN KEY ("applied_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promotion_redemptions" ADD CONSTRAINT "promotion_redemptions_subscription_same_tenant_fk" FOREIGN KEY ("organization_id","subscription_id") REFERENCES "public"."subscriptions"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promotion_redemptions" ADD CONSTRAINT "promotion_redemptions_change_same_tenant_fk" FOREIGN KEY ("organization_id","billing_change_id") REFERENCES "public"."billing_changes"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_plan_price_id_plan_prices_id_fk" FOREIGN KEY ("plan_price_id") REFERENCES "public"."plan_prices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_customer_same_tenant_fk" FOREIGN KEY ("organization_id","billing_customer_id") REFERENCES "public"."billing_customers"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "billing_changes_idempotency_unique" ON "billing_changes" USING btree ("organization_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "billing_changes_one_open_subscribe" ON "billing_changes" USING btree ("organization_id","environment") WHERE "billing_changes"."kind" = 'subscribe' and "billing_changes"."status" in ('requested', 'pending_payment');--> statement-breakpoint
CREATE UNIQUE INDEX "billing_changes_checkout_unique" ON "billing_changes" USING btree ("stripe_checkout_session_id") WHERE "billing_changes"."stripe_checkout_session_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "billing_customers_org_env_unique" ON "billing_customers" USING btree ("organization_id","environment");--> statement-breakpoint
CREATE UNIQUE INDEX "billing_customers_stripe_unique" ON "billing_customers" USING btree ("environment","stripe_customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "plan_prices_plan_env_interval_currency_unique" ON "plan_prices" USING btree ("plan_id","environment","interval","currency");--> statement-breakpoint
CREATE UNIQUE INDEX "plan_prices_base_price_unique" ON "plan_prices" USING btree ("environment","base_stripe_price_id") WHERE "plan_prices"."base_stripe_price_id" is not null and "plan_prices"."active";--> statement-breakpoint
CREATE UNIQUE INDEX "plans_key_version_unique" ON "plans" USING btree ("key","version");--> statement-breakpoint
CREATE UNIQUE INDEX "plans_one_published_version" ON "plans" USING btree ("key") WHERE "plans"."status" = 'published';--> statement-breakpoint
CREATE UNIQUE INDEX "plans_one_published_fallback" ON "plans" USING btree ("is_fallback") WHERE "plans"."is_fallback" and "plans"."status" = 'published';--> statement-breakpoint
CREATE UNIQUE INDEX "promotion_redemptions_discount_unique" ON "promotion_redemptions" USING btree ("environment","stripe_discount_id");--> statement-breakpoint
CREATE UNIQUE INDEX "stripe_event_unique" ON "stripe_webhook_events" USING btree ("environment","stripe_event_id");--> statement-breakpoint
CREATE INDEX "stripe_webhook_events_received_idx" ON "stripe_webhook_events" USING btree ("received_at");--> statement-breakpoint
CREATE UNIQUE INDEX "subscriptions_stripe_unique" ON "subscriptions" USING btree ("environment","stripe_subscription_id");--> statement-breakpoint
CREATE INDEX "subscriptions_org_idx" ON "subscriptions" USING btree ("organization_id","environment");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "billing_changes" AS PERMISSIVE FOR ALL TO "pixlova_app" USING ("billing_changes"."organization_id" = nullif(current_setting('pixlova.organization_id', true), '')::uuid) WITH CHECK ("billing_changes"."organization_id" = nullif(current_setting('pixlova.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "billing_customers" AS PERMISSIVE FOR ALL TO "pixlova_app" USING ("billing_customers"."organization_id" = nullif(current_setting('pixlova.organization_id', true), '')::uuid) WITH CHECK ("billing_customers"."organization_id" = nullif(current_setting('pixlova.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "promotion_redemptions" AS PERMISSIVE FOR ALL TO "pixlova_app" USING ("promotion_redemptions"."organization_id" = nullif(current_setting('pixlova.organization_id', true), '')::uuid) WITH CHECK ("promotion_redemptions"."organization_id" = nullif(current_setting('pixlova.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "subscriptions" AS PERMISSIVE FOR ALL TO "pixlova_app" USING ("subscriptions"."organization_id" = nullif(current_setting('pixlova.organization_id', true), '')::uuid) WITH CHECK ("subscriptions"."organization_id" = nullif(current_setting('pixlova.organization_id', true), '')::uuid);