CREATE TABLE "memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memberships_org_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "memberships_status_check" CHECK ("memberships"."status" in ('active', 'suspended', 'revoked'))
);
--> statement-breakpoint
ALTER TABLE "memberships" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"country" char(2) NOT NULL,
	"timezone" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"deletion_requested_at" timestamp with time zone,
	"purge_after" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "organizations_status_check" CHECK ("organizations"."status" in ('active', 'suspended', 'deletion_pending', 'deleted')),
	CONSTRAINT "organizations_country_check" CHECK ("organizations"."country" ~ '^[A-Z]{2}$')
);
--> statement-breakpoint
ALTER TABLE "organizations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "sites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"timezone" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "sites_org_id_unique" UNIQUE("organization_id","id")
);
--> statement-breakpoint
ALTER TABLE "sites" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email_normalized" text NOT NULL,
	"password_hash" text,
	"email_verified_at" timestamp with time zone,
	"status" text DEFAULT 'active' NOT NULL,
	"mfa_enabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_status_check" CHECK ("users"."status" in ('active', 'disabled')),
	CONSTRAINT "users_email_normalized_check" CHECK ("users"."email_normalized" = lower("users"."email_normalized"))
);
--> statement-breakpoint
CREATE TABLE "display_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"display_id" uuid NOT NULL,
	"player_output_id" uuid NOT NULL,
	"generation" bigint NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"assigned_by" uuid,
	CONSTRAINT "display_assignments_generation_check" CHECK ("display_assignments"."generation" >= 1),
	CONSTRAINT "display_assignments_period_check" CHECK ("display_assignments"."ended_at" is null or "display_assignments"."ended_at" >= "display_assignments"."started_at")
);
--> statement-breakpoint
ALTER TABLE "display_assignments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "display_group_members" (
	"organization_id" uuid NOT NULL,
	"group_id" uuid NOT NULL,
	"display_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "display_group_members_group_id_display_id_pk" PRIMARY KEY("group_id","display_id")
);
--> statement-breakpoint
ALTER TABLE "display_group_members" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "display_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "display_groups_org_id_unique" UNIQUE("organization_id","id")
);
--> statement-breakpoint
ALTER TABLE "display_groups" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "displays" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"name" text NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"orientation" integer DEFAULT 0 NOT NULL,
	"timezone" text,
	"lifecycle_status" text DEFAULT 'active' NOT NULL,
	"assignment_generation" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "displays_org_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "displays_width_check" CHECK ("displays"."width" between 1 and 32767),
	CONSTRAINT "displays_height_check" CHECK ("displays"."height" between 1 and 32767),
	CONSTRAINT "displays_orientation_check" CHECK ("displays"."orientation" in (0, 90, 180, 270)),
	CONSTRAINT "displays_lifecycle_check" CHECK ("displays"."lifecycle_status" in ('active', 'inactive', 'archived')),
	CONSTRAINT "displays_generation_check" CHECK ("displays"."assignment_generation" >= 0)
);
--> statement-breakpoint
ALTER TABLE "displays" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "player_outputs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"player_id" uuid NOT NULL,
	"output_key" text NOT NULL,
	"connector_type" text,
	"width" integer,
	"height" integer,
	"refresh_rate" real,
	"connected" boolean,
	"capabilities" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "player_outputs_org_id_unique" UNIQUE("organization_id","id")
);
--> statement-breakpoint
ALTER TABLE "player_outputs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "players" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"site_id" uuid,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"lifecycle_status" text DEFAULT 'paired' NOT NULL,
	"installation_uuid" uuid NOT NULL,
	"machine_uuid" uuid,
	"machine_fingerprint_hash" text,
	"app_version" text,
	"os" text,
	"architecture" text,
	"capabilities" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "players_org_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "players_type_check" CHECK ("players"."type" in ('native', 'web')),
	CONSTRAINT "players_lifecycle_check" CHECK ("players"."lifecycle_status" in ('paired', 'disabled', 'revoked', 'deleted'))
);
--> statement-breakpoint
ALTER TABLE "players" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid,
	"actor_type" text NOT NULL,
	"actor_id" uuid,
	"action" text NOT NULL,
	"permission" text,
	"target_type" text,
	"target_id" uuid,
	"result" text NOT NULL,
	"reason" text,
	"request_id" uuid,
	"ip" "inet",
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audit_logs_actor_type_check" CHECK ("audit_logs"."actor_type" in ('user', 'player', 'platform_user', 'system')),
	CONSTRAINT "audit_logs_result_check" CHECK ("audit_logs"."result" in ('success', 'denied', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "audit_logs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "outbox_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"organization_id" uuid,
	"aggregate_type" text NOT NULL,
	"aggregate_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"dispatched_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "outbox_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sites" ADD CONSTRAINT "sites_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "display_assignments" ADD CONSTRAINT "display_assignments_assigned_by_users_id_fk" FOREIGN KEY ("assigned_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "display_assignments" ADD CONSTRAINT "display_assignments_display_same_tenant_fk" FOREIGN KEY ("organization_id","display_id") REFERENCES "public"."displays"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "display_assignments" ADD CONSTRAINT "display_assignments_output_same_tenant_fk" FOREIGN KEY ("organization_id","player_output_id") REFERENCES "public"."player_outputs"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "display_group_members" ADD CONSTRAINT "display_group_members_group_same_tenant_fk" FOREIGN KEY ("organization_id","group_id") REFERENCES "public"."display_groups"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "display_group_members" ADD CONSTRAINT "display_group_members_display_same_tenant_fk" FOREIGN KEY ("organization_id","display_id") REFERENCES "public"."displays"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "display_groups" ADD CONSTRAINT "display_groups_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "displays" ADD CONSTRAINT "displays_site_same_tenant_fk" FOREIGN KEY ("organization_id","site_id") REFERENCES "public"."sites"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_outputs" ADD CONSTRAINT "player_outputs_player_same_tenant_fk" FOREIGN KEY ("organization_id","player_id") REFERENCES "public"."players"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "players" ADD CONSTRAINT "players_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "players" ADD CONSTRAINT "players_site_same_tenant_fk" FOREIGN KEY ("organization_id","site_id") REFERENCES "public"."sites"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbox_events" ADD CONSTRAINT "outbox_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "memberships_org_user_unique" ON "memberships" USING btree ("organization_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "organizations_slug_unique" ON "organizations" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_normalized_unique" ON "users" USING btree ("email_normalized");--> statement-breakpoint
CREATE UNIQUE INDEX "display_one_active_assignment" ON "display_assignments" USING btree ("display_id") WHERE "display_assignments"."ended_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "output_one_active_assignment" ON "display_assignments" USING btree ("player_output_id") WHERE "display_assignments"."ended_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "display_assignment_generation_unique" ON "display_assignments" USING btree ("display_id","generation");--> statement-breakpoint
CREATE INDEX "display_group_members_display_idx" ON "display_group_members" USING btree ("organization_id","display_id");--> statement-breakpoint
CREATE INDEX "displays_org_site_idx" ON "displays" USING btree ("organization_id","site_id");--> statement-breakpoint
CREATE UNIQUE INDEX "player_outputs_player_key_unique" ON "player_outputs" USING btree ("player_id","output_key");--> statement-breakpoint
CREATE INDEX "players_org_last_seen_idx" ON "players" USING btree ("organization_id","last_seen_at");--> statement-breakpoint
CREATE INDEX "audit_logs_org_created_idx" ON "audit_logs" USING btree ("organization_id","created_at","id");--> statement-breakpoint
CREATE INDEX "outbox_events_pending_idx" ON "outbox_events" USING btree ("id") WHERE "outbox_events"."dispatched_at" is null;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "memberships" AS PERMISSIVE FOR ALL TO "pixlova_app" USING ("memberships"."organization_id" = nullif(current_setting('pixlova.organization_id', true), '')::uuid) WITH CHECK ("memberships"."organization_id" = nullif(current_setting('pixlova.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "organizations" AS PERMISSIVE FOR ALL TO "pixlova_app" USING ("organizations"."id" = nullif(current_setting('pixlova.organization_id', true), '')::uuid) WITH CHECK ("organizations"."id" = nullif(current_setting('pixlova.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "sites" AS PERMISSIVE FOR ALL TO "pixlova_app" USING ("sites"."organization_id" = nullif(current_setting('pixlova.organization_id', true), '')::uuid) WITH CHECK ("sites"."organization_id" = nullif(current_setting('pixlova.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "display_assignments" AS PERMISSIVE FOR ALL TO "pixlova_app" USING ("display_assignments"."organization_id" = nullif(current_setting('pixlova.organization_id', true), '')::uuid) WITH CHECK ("display_assignments"."organization_id" = nullif(current_setting('pixlova.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "display_group_members" AS PERMISSIVE FOR ALL TO "pixlova_app" USING ("display_group_members"."organization_id" = nullif(current_setting('pixlova.organization_id', true), '')::uuid) WITH CHECK ("display_group_members"."organization_id" = nullif(current_setting('pixlova.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "display_groups" AS PERMISSIVE FOR ALL TO "pixlova_app" USING ("display_groups"."organization_id" = nullif(current_setting('pixlova.organization_id', true), '')::uuid) WITH CHECK ("display_groups"."organization_id" = nullif(current_setting('pixlova.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "displays" AS PERMISSIVE FOR ALL TO "pixlova_app" USING ("displays"."organization_id" = nullif(current_setting('pixlova.organization_id', true), '')::uuid) WITH CHECK ("displays"."organization_id" = nullif(current_setting('pixlova.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "player_outputs" AS PERMISSIVE FOR ALL TO "pixlova_app" USING ("player_outputs"."organization_id" = nullif(current_setting('pixlova.organization_id', true), '')::uuid) WITH CHECK ("player_outputs"."organization_id" = nullif(current_setting('pixlova.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "players" AS PERMISSIVE FOR ALL TO "pixlova_app" USING ("players"."organization_id" = nullif(current_setting('pixlova.organization_id', true), '')::uuid) WITH CHECK ("players"."organization_id" = nullif(current_setting('pixlova.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "audit_logs" AS PERMISSIVE FOR ALL TO "pixlova_app" USING ("audit_logs"."organization_id" = nullif(current_setting('pixlova.organization_id', true), '')::uuid) WITH CHECK ("audit_logs"."organization_id" = nullif(current_setting('pixlova.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "outbox_events" AS PERMISSIVE FOR ALL TO "pixlova_app" USING ("outbox_events"."organization_id" = nullif(current_setting('pixlova.organization_id', true), '')::uuid) WITH CHECK ("outbox_events"."organization_id" = nullif(current_setting('pixlova.organization_id', true), '')::uuid);