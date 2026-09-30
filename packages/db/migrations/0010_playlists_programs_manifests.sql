CREATE TABLE "playlist_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"playlist_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"schema_version" integer NOT NULL,
	"document" jsonb NOT NULL,
	"published_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "playlist_versions_org_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "playlist_versions_number_unique" UNIQUE("playlist_id","version"),
	CONSTRAINT "playlist_versions_version_check" CHECK ("playlist_versions"."version" >= 1)
);
--> statement-breakpoint
ALTER TABLE "playlist_versions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "playlists" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"site_id" uuid,
	"name" text NOT NULL,
	"draft_document" jsonb NOT NULL,
	"draft_revision" integer DEFAULT 1 NOT NULL,
	"has_unpublished_changes" boolean DEFAULT true NOT NULL,
	"published_version" integer,
	"published_version_id" uuid,
	"published_at" timestamp with time zone,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "playlists_org_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "playlists_revision_check" CHECK ("playlists"."draft_revision" >= 1),
	CONSTRAINT "playlists_published_pair" CHECK (("playlists"."published_version" is null) = ("playlists"."published_version_id" is null))
);
--> statement-breakpoint
ALTER TABLE "playlists" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "program_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"program_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"schema_version" integer NOT NULL,
	"document" jsonb NOT NULL,
	"published_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "program_versions_org_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "program_versions_number_unique" UNIQUE("program_id","version"),
	CONSTRAINT "program_versions_version_check" CHECK ("program_versions"."version" >= 1)
);
--> statement-breakpoint
ALTER TABLE "program_versions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "programs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"site_id" uuid,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"draft_document" jsonb NOT NULL,
	"draft_revision" integer DEFAULT 1 NOT NULL,
	"has_unpublished_changes" boolean DEFAULT true NOT NULL,
	"published_version" integer,
	"published_version_id" uuid,
	"published_at" timestamp with time zone,
	"effective_until" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"cancelled_by" uuid,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "programs_org_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "programs_kind_check" CHECK ("programs"."kind" in ('schedule', 'campaign', 'override')),
	CONSTRAINT "programs_revision_check" CHECK ("programs"."draft_revision" >= 1),
	CONSTRAINT "programs_published_pair" CHECK (("programs"."published_version" is null) = ("programs"."published_version_id" is null))
);
--> statement-breakpoint
ALTER TABLE "programs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "display_compilations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"display_id" uuid NOT NULL,
	"config_revision" bigint NOT NULL,
	"status" text NOT NULL,
	"input_hash" text,
	"manifest_id" uuid,
	"issues" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"explanation" jsonb,
	"window_from" timestamp with time zone,
	"window_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "display_compilations_status_check" CHECK ("display_compilations"."status" in ('published', 'unchanged', 'superseded', 'rejected', 'unassigned'))
);
--> statement-breakpoint
ALTER TABLE "display_compilations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "manifest_assets" (
	"organization_id" uuid NOT NULL,
	"manifest_id" uuid NOT NULL,
	"media_asset_id" uuid NOT NULL,
	"required" boolean DEFAULT true NOT NULL,
	CONSTRAINT "manifest_assets_manifest_id_media_asset_id_pk" PRIMARY KEY("manifest_id","media_asset_id")
);
--> statement-breakpoint
ALTER TABLE "manifest_assets" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "manifest_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"manifest_id" uuid NOT NULL,
	"display_id" uuid NOT NULL,
	"player_id" uuid NOT NULL,
	"assignment_generation" bigint NOT NULL,
	"state" text DEFAULT 'desired' NOT NULL,
	"error_code" text,
	"detail" text,
	"received_at" timestamp with time zone,
	"ready_at" timestamp with time zone,
	"applied_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "manifest_deliveries_manifest_player_unique" UNIQUE("manifest_id","player_id"),
	CONSTRAINT "manifest_deliveries_state_check" CHECK ("manifest_deliveries"."state" in ('desired', 'received', 'downloading', 'ready', 'applied', 'failed', 'superseded'))
);
--> statement-breakpoint
ALTER TABLE "manifest_deliveries" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "manifests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"display_id" uuid NOT NULL,
	"player_id" uuid NOT NULL,
	"version" bigint NOT NULL,
	"assignment_generation" bigint NOT NULL,
	"config_revision" bigint NOT NULL,
	"schema_version" integer NOT NULL,
	"payload_hash" text NOT NULL,
	"input_hash" text NOT NULL,
	"key_id" text NOT NULL,
	"envelope" text NOT NULL,
	"generated_at" timestamp with time zone NOT NULL,
	"valid_from" timestamp with time zone NOT NULL,
	"schedule_until" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "manifests_org_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "manifests_display_version_unique" UNIQUE("display_id","version"),
	CONSTRAINT "manifests_version_check" CHECK ("manifests"."version" >= 1),
	CONSTRAINT "manifests_hash_format" CHECK ("manifests"."payload_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "manifests_window_check" CHECK ("manifests"."valid_from" < "manifests"."schedule_until")
);
--> statement-breakpoint
ALTER TABLE "manifests" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "displays" DROP CONSTRAINT "displays_fallback_check";--> statement-breakpoint
ALTER TABLE "content_dependencies" DROP CONSTRAINT "content_dependencies_composition_version_id_media_id_pk";--> statement-breakpoint
ALTER TABLE "content_dependencies" ALTER COLUMN "composition_version_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "content_dependencies" ALTER COLUMN "media_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "displays" ADD COLUMN "fallback_media_id" uuid;--> statement-breakpoint
ALTER TABLE "displays" ADD COLUMN "fallback_composition_id" uuid;--> statement-breakpoint
ALTER TABLE "displays" ADD COLUMN "fallback_playlist_id" uuid;--> statement-breakpoint
ALTER TABLE "displays" ADD COLUMN "config_revision" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "displays" ADD COLUMN "manifest_version" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "content_dependencies" ADD COLUMN "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL;--> statement-breakpoint
ALTER TABLE "content_dependencies" ADD COLUMN "playlist_version_id" uuid;--> statement-breakpoint
ALTER TABLE "content_dependencies" ADD COLUMN "program_version_id" uuid;--> statement-breakpoint
ALTER TABLE "content_dependencies" ADD COLUMN "composition_id" uuid;--> statement-breakpoint
ALTER TABLE "content_dependencies" ADD COLUMN "playlist_id" uuid;--> statement-breakpoint
ALTER TABLE "playlist_versions" ADD CONSTRAINT "playlist_versions_published_by_users_id_fk" FOREIGN KEY ("published_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playlist_versions" ADD CONSTRAINT "playlist_versions_playlist_same_tenant_fk" FOREIGN KEY ("organization_id","playlist_id") REFERENCES "public"."playlists"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playlists" ADD CONSTRAINT "playlists_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playlists" ADD CONSTRAINT "playlists_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playlists" ADD CONSTRAINT "playlists_site_same_tenant_fk" FOREIGN KEY ("organization_id","site_id") REFERENCES "public"."sites"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "program_versions" ADD CONSTRAINT "program_versions_published_by_users_id_fk" FOREIGN KEY ("published_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "program_versions" ADD CONSTRAINT "program_versions_program_same_tenant_fk" FOREIGN KEY ("organization_id","program_id") REFERENCES "public"."programs"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "programs" ADD CONSTRAINT "programs_cancelled_by_users_id_fk" FOREIGN KEY ("cancelled_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "programs" ADD CONSTRAINT "programs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "programs" ADD CONSTRAINT "programs_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "programs" ADD CONSTRAINT "programs_site_same_tenant_fk" FOREIGN KEY ("organization_id","site_id") REFERENCES "public"."sites"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "display_compilations" ADD CONSTRAINT "display_compilations_display_same_tenant_fk" FOREIGN KEY ("organization_id","display_id") REFERENCES "public"."displays"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "display_compilations" ADD CONSTRAINT "display_compilations_manifest_same_tenant_fk" FOREIGN KEY ("organization_id","manifest_id") REFERENCES "public"."manifests"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "manifest_assets" ADD CONSTRAINT "manifest_assets_manifest_same_tenant_fk" FOREIGN KEY ("organization_id","manifest_id") REFERENCES "public"."manifests"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "manifest_assets" ADD CONSTRAINT "manifest_assets_asset_same_tenant_fk" FOREIGN KEY ("organization_id","media_asset_id") REFERENCES "public"."media_assets"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "manifest_deliveries" ADD CONSTRAINT "manifest_deliveries_manifest_same_tenant_fk" FOREIGN KEY ("organization_id","manifest_id") REFERENCES "public"."manifests"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "manifest_deliveries" ADD CONSTRAINT "manifest_deliveries_display_same_tenant_fk" FOREIGN KEY ("organization_id","display_id") REFERENCES "public"."displays"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "manifest_deliveries" ADD CONSTRAINT "manifest_deliveries_player_same_tenant_fk" FOREIGN KEY ("organization_id","player_id") REFERENCES "public"."players"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "manifests" ADD CONSTRAINT "manifests_display_same_tenant_fk" FOREIGN KEY ("organization_id","display_id") REFERENCES "public"."displays"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "manifests" ADD CONSTRAINT "manifests_player_same_tenant_fk" FOREIGN KEY ("organization_id","player_id") REFERENCES "public"."players"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "playlists_org_updated_idx" ON "playlists" USING btree ("organization_id","updated_at","id");--> statement-breakpoint
CREATE INDEX "programs_org_kind_updated_idx" ON "programs" USING btree ("organization_id","kind","updated_at","id");--> statement-breakpoint
CREATE INDEX "programs_org_live_idx" ON "programs" USING btree ("organization_id","effective_until") WHERE "programs"."published_version_id" is not null and "programs"."cancelled_at" is null and "programs"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "display_compilations_display_idx" ON "display_compilations" USING btree ("organization_id","display_id","created_at");--> statement-breakpoint
CREATE INDEX "manifest_assets_asset_idx" ON "manifest_assets" USING btree ("organization_id","media_asset_id");--> statement-breakpoint
CREATE INDEX "manifest_deliveries_display_idx" ON "manifest_deliveries" USING btree ("organization_id","display_id","created_at");--> statement-breakpoint
CREATE INDEX "manifests_display_version_idx" ON "manifests" USING btree ("display_id","version" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "displays" ADD CONSTRAINT "displays_fallback_media_same_tenant_fk" FOREIGN KEY ("organization_id","fallback_media_id") REFERENCES "public"."media"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "displays" ADD CONSTRAINT "displays_fallback_composition_same_tenant_fk" FOREIGN KEY ("organization_id","fallback_composition_id") REFERENCES "public"."compositions"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "displays" ADD CONSTRAINT "displays_fallback_playlist_same_tenant_fk" FOREIGN KEY ("organization_id","fallback_playlist_id") REFERENCES "public"."playlists"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_dependencies" ADD CONSTRAINT "content_dependencies_playlist_version_same_tenant_fk" FOREIGN KEY ("organization_id","playlist_version_id") REFERENCES "public"."playlist_versions"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_dependencies" ADD CONSTRAINT "content_dependencies_program_version_same_tenant_fk" FOREIGN KEY ("organization_id","program_version_id") REFERENCES "public"."program_versions"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_dependencies" ADD CONSTRAINT "content_dependencies_composition_same_tenant_fk" FOREIGN KEY ("organization_id","composition_id") REFERENCES "public"."compositions"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_dependencies" ADD CONSTRAINT "content_dependencies_playlist_same_tenant_fk" FOREIGN KEY ("organization_id","playlist_id") REFERENCES "public"."playlists"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "content_dependencies_composition_idx" ON "content_dependencies" USING btree ("organization_id","composition_id");--> statement-breakpoint
CREATE INDEX "content_dependencies_playlist_idx" ON "content_dependencies" USING btree ("organization_id","playlist_id");--> statement-breakpoint
ALTER TABLE "content_dependencies" ADD CONSTRAINT "content_dependencies_edge_unique" UNIQUE NULLS NOT DISTINCT("composition_version_id","playlist_version_id","program_version_id","media_id","composition_id","playlist_id");--> statement-breakpoint
ALTER TABLE "displays" ADD CONSTRAINT "displays_revision_check" CHECK ("displays"."config_revision" >= 0 and "displays"."manifest_version" >= 0);--> statement-breakpoint
ALTER TABLE "displays" ADD CONSTRAINT "displays_fallback_check" CHECK (("displays"."fallback_mode" = 'standby_screen' and num_nonnulls("displays"."fallback_media_id", "displays"."fallback_composition_id", "displays"."fallback_playlist_id") = 0) or ("displays"."fallback_mode" = 'content' and num_nonnulls("displays"."fallback_media_id", "displays"."fallback_composition_id", "displays"."fallback_playlist_id") = 1));--> statement-breakpoint
ALTER TABLE "content_dependencies" ADD CONSTRAINT "content_dependencies_one_source" CHECK (num_nonnulls("content_dependencies"."composition_version_id", "content_dependencies"."playlist_version_id", "content_dependencies"."program_version_id") = 1);--> statement-breakpoint
ALTER TABLE "content_dependencies" ADD CONSTRAINT "content_dependencies_one_target" CHECK (num_nonnulls("content_dependencies"."media_id", "content_dependencies"."composition_id", "content_dependencies"."playlist_id") = 1);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "playlist_versions" AS PERMISSIVE FOR ALL TO "pixlova_app" USING ("playlist_versions"."organization_id" = nullif(current_setting('pixlova.organization_id', true), '')::uuid) WITH CHECK ("playlist_versions"."organization_id" = nullif(current_setting('pixlova.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "playlists" AS PERMISSIVE FOR ALL TO "pixlova_app" USING ("playlists"."organization_id" = nullif(current_setting('pixlova.organization_id', true), '')::uuid) WITH CHECK ("playlists"."organization_id" = nullif(current_setting('pixlova.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "program_versions" AS PERMISSIVE FOR ALL TO "pixlova_app" USING ("program_versions"."organization_id" = nullif(current_setting('pixlova.organization_id', true), '')::uuid) WITH CHECK ("program_versions"."organization_id" = nullif(current_setting('pixlova.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "programs" AS PERMISSIVE FOR ALL TO "pixlova_app" USING ("programs"."organization_id" = nullif(current_setting('pixlova.organization_id', true), '')::uuid) WITH CHECK ("programs"."organization_id" = nullif(current_setting('pixlova.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "display_compilations" AS PERMISSIVE FOR ALL TO "pixlova_app" USING ("display_compilations"."organization_id" = nullif(current_setting('pixlova.organization_id', true), '')::uuid) WITH CHECK ("display_compilations"."organization_id" = nullif(current_setting('pixlova.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "manifest_assets" AS PERMISSIVE FOR ALL TO "pixlova_app" USING ("manifest_assets"."organization_id" = nullif(current_setting('pixlova.organization_id', true), '')::uuid) WITH CHECK ("manifest_assets"."organization_id" = nullif(current_setting('pixlova.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "manifest_deliveries" AS PERMISSIVE FOR ALL TO "pixlova_app" USING ("manifest_deliveries"."organization_id" = nullif(current_setting('pixlova.organization_id', true), '')::uuid) WITH CHECK ("manifest_deliveries"."organization_id" = nullif(current_setting('pixlova.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "manifests" AS PERMISSIVE FOR ALL TO "pixlova_app" USING ("manifests"."organization_id" = nullif(current_setting('pixlova.organization_id', true), '')::uuid) WITH CHECK ("manifests"."organization_id" = nullif(current_setting('pixlova.organization_id', true), '')::uuid);