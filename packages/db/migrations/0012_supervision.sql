CREATE TABLE "alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"rule" text NOT NULL,
	"severity" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" uuid NOT NULL,
	"site_id" uuid,
	"status" text DEFAULT 'open' NOT NULL,
	"opened_at" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone,
	"clearing_since" timestamp with time zone,
	"notified_open_at" timestamp with time zone,
	"notified_resolved_at" timestamp with time zone,
	"suspected_platform" boolean DEFAULT false NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "alerts_rule_check" CHECK ("alerts"."rule" in ('player_offline', 'manifest_not_applied', 'delivery_failed', 'playback_errors', 'disk_low')),
	CONSTRAINT "alerts_status_check" CHECK ("alerts"."status" in ('open', 'resolved'))
);
--> statement-breakpoint
ALTER TABLE "alerts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "maintenance_windows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"scope_type" text NOT NULL,
	"scope_id" uuid,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"reason" text NOT NULL,
	"created_by" uuid NOT NULL,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "maintenance_windows_period_check" CHECK ("maintenance_windows"."starts_at" < "maintenance_windows"."ends_at"),
	CONSTRAINT "maintenance_windows_scope_check" CHECK (("maintenance_windows"."scope_type" = 'organization') = ("maintenance_windows"."scope_id" is null))
);
--> statement-breakpoint
ALTER TABLE "maintenance_windows" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "player_commands" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"player_id" uuid NOT NULL,
	"display_id" uuid,
	"assignment_generation" text,
	"type" text NOT NULL,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"envelope" text NOT NULL,
	"payload_hash" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"requested_by" uuid,
	"issued_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"sent_at" timestamp with time zone,
	"acknowledged_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"result_code" text,
	"result_detail" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "player_commands_org_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "player_commands_status_check" CHECK ("player_commands"."status" in ('pending', 'sent', 'acknowledged', 'success', 'failed', 'rejected', 'expired', 'cancelled', 'unknown')),
	CONSTRAINT "player_commands_window_check" CHECK ("player_commands"."issued_at" < "player_commands"."expires_at")
);
--> statement-breakpoint
ALTER TABLE "player_commands" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "player_status" (
	"player_id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"heartbeat_received_at" timestamp with time zone,
	"renderer" text,
	"displays" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status_observed_at" timestamp with time zone,
	"status_received_at" timestamp with time zone,
	"renderer_restarts" integer,
	"disk_free_bytes" bigint,
	"disk_total_bytes" bigint,
	"payload" jsonb
);
--> statement-breakpoint
ALTER TABLE "player_status" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "screenshots" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"player_id" uuid NOT NULL,
	"display_id" uuid NOT NULL,
	"command_id" uuid NOT NULL,
	"object_key" text NOT NULL,
	"status" text DEFAULT 'requested' NOT NULL,
	"size_bytes" integer,
	"sha256" text,
	"captured_at" timestamp with time zone,
	"received_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"requested_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "screenshots_command_unique" UNIQUE("command_id"),
	CONSTRAINT "screenshots_status_check" CHECK ("screenshots"."status" in ('requested', 'uploading', 'available'))
);
--> statement-breakpoint
ALTER TABLE "screenshots" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "timeline_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"source" text NOT NULL,
	"player_id" uuid,
	"display_id" uuid,
	"event_id" uuid,
	"boot_id" uuid,
	"seq" bigint,
	"assignment_generation" text,
	"type" text NOT NULL,
	"severity" text NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "timeline_events_source_check" CHECK ("timeline_events"."source" in ('player', 'cloud')),
	CONSTRAINT "timeline_events_severity_check" CHECK ("timeline_events"."severity" in ('info', 'warning', 'error', 'critical')),
	CONSTRAINT "timeline_events_player_source_check" CHECK ("timeline_events"."source" = 'cloud' or ("timeline_events"."event_id" is not null and "timeline_events"."player_id" is not null))
);
--> statement-breakpoint
ALTER TABLE "timeline_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "memberships" ADD COLUMN "alert_emails" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "screenshots_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_windows" ADD CONSTRAINT "maintenance_windows_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_windows" ADD CONSTRAINT "maintenance_windows_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_commands" ADD CONSTRAINT "player_commands_player_same_tenant_fk" FOREIGN KEY ("organization_id","player_id") REFERENCES "public"."players"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_commands" ADD CONSTRAINT "player_commands_display_same_tenant_fk" FOREIGN KEY ("organization_id","display_id") REFERENCES "public"."displays"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_commands" ADD CONSTRAINT "player_commands_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_status" ADD CONSTRAINT "player_status_player_same_tenant_fk" FOREIGN KEY ("organization_id","player_id") REFERENCES "public"."players"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "screenshots" ADD CONSTRAINT "screenshots_command_same_tenant_fk" FOREIGN KEY ("organization_id","command_id") REFERENCES "public"."player_commands"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "screenshots" ADD CONSTRAINT "screenshots_display_same_tenant_fk" FOREIGN KEY ("organization_id","display_id") REFERENCES "public"."displays"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "screenshots" ADD CONSTRAINT "screenshots_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timeline_events" ADD CONSTRAINT "timeline_events_player_same_tenant_fk" FOREIGN KEY ("organization_id","player_id") REFERENCES "public"."players"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timeline_events" ADD CONSTRAINT "timeline_events_display_same_tenant_fk" FOREIGN KEY ("organization_id","display_id") REFERENCES "public"."displays"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "alerts_open_unique" ON "alerts" USING btree ("organization_id","rule","target_id") WHERE "alerts"."status" = 'open';--> statement-breakpoint
CREATE INDEX "alerts_org_status_idx" ON "alerts" USING btree ("organization_id","status","opened_at");--> statement-breakpoint
CREATE INDEX "maintenance_windows_org_idx" ON "maintenance_windows" USING btree ("organization_id","ends_at");--> statement-breakpoint
CREATE INDEX "player_commands_player_status_idx" ON "player_commands" USING btree ("player_id","status","expires_at");--> statement-breakpoint
CREATE INDEX "player_commands_org_created_idx" ON "player_commands" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "screenshots_display_idx" ON "screenshots" USING btree ("organization_id","display_id","created_at");--> statement-breakpoint
CREATE INDEX "screenshots_expires_idx" ON "screenshots" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "timeline_events_player_event_unique" ON "timeline_events" USING btree ("player_id","event_id") WHERE "timeline_events"."event_id" is not null;--> statement-breakpoint
CREATE INDEX "timeline_events_display_idx" ON "timeline_events" USING btree ("organization_id","display_id","observed_at");--> statement-breakpoint
CREATE INDEX "timeline_events_player_idx" ON "timeline_events" USING btree ("organization_id","player_id","observed_at");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "alerts" AS PERMISSIVE FOR ALL TO "pixlova_app" USING ("alerts"."organization_id" = nullif(current_setting('pixlova.organization_id', true), '')::uuid) WITH CHECK ("alerts"."organization_id" = nullif(current_setting('pixlova.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "maintenance_windows" AS PERMISSIVE FOR ALL TO "pixlova_app" USING ("maintenance_windows"."organization_id" = nullif(current_setting('pixlova.organization_id', true), '')::uuid) WITH CHECK ("maintenance_windows"."organization_id" = nullif(current_setting('pixlova.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "player_commands" AS PERMISSIVE FOR ALL TO "pixlova_app" USING ("player_commands"."organization_id" = nullif(current_setting('pixlova.organization_id', true), '')::uuid) WITH CHECK ("player_commands"."organization_id" = nullif(current_setting('pixlova.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "player_status" AS PERMISSIVE FOR ALL TO "pixlova_app" USING ("player_status"."organization_id" = nullif(current_setting('pixlova.organization_id', true), '')::uuid) WITH CHECK ("player_status"."organization_id" = nullif(current_setting('pixlova.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "screenshots" AS PERMISSIVE FOR ALL TO "pixlova_app" USING ("screenshots"."organization_id" = nullif(current_setting('pixlova.organization_id', true), '')::uuid) WITH CHECK ("screenshots"."organization_id" = nullif(current_setting('pixlova.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "timeline_events" AS PERMISSIVE FOR ALL TO "pixlova_app" USING ("timeline_events"."organization_id" = nullif(current_setting('pixlova.organization_id', true), '')::uuid) WITH CHECK ("timeline_events"."organization_id" = nullif(current_setting('pixlova.organization_id', true), '')::uuid);