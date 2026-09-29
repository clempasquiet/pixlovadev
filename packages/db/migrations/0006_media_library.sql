CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid,
	"kind" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"run_after" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "jobs_state_check" CHECK ("jobs"."state" in ('queued', 'running', 'succeeded', 'failed')),
	CONSTRAINT "jobs_attempts_check" CHECK ("jobs"."attempts" >= 0 and "jobs"."max_attempts" >= 1)
);
--> statement-breakpoint
ALTER TABLE "jobs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "usage_counters" (
	"organization_id" uuid NOT NULL,
	"category" text NOT NULL,
	"observed_value" bigint DEFAULT 0 NOT NULL,
	"reserved_value" bigint DEFAULT 0 NOT NULL,
	"measured_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "usage_counters_organization_id_category_pk" PRIMARY KEY("organization_id","category"),
	CONSTRAINT "usage_counters_category_check" CHECK ("usage_counters"."category" in ('storage_bytes')),
	CONSTRAINT "usage_counters_values_check" CHECK ("usage_counters"."observed_value" >= 0 and "usage_counters"."reserved_value" >= 0)
);
--> statement-breakpoint
ALTER TABLE "usage_counters" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "media" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"site_id" uuid,
	"folder_id" uuid,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"status" text DEFAULT 'uploading' NOT NULL,
	"declared_mime_type" text NOT NULL,
	"mime_type" text,
	"original_filename" text NOT NULL,
	"size_bytes" bigint,
	"checksum_sha256" text,
	"width" integer,
	"height" integer,
	"duration_ms" integer,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error_code" text,
	"error_detail" text,
	"quota_bytes" bigint DEFAULT 0 NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid,
	"purge_after" timestamp with time zone,
	"purge_started_at" timestamp with time zone,
	CONSTRAINT "media_org_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "media_type_check" CHECK ("media"."type" in ('image', 'video')),
	CONSTRAINT "media_status_check" CHECK ("media"."status" in ('uploading', 'processing', 'ready', 'error')),
	CONSTRAINT "media_sizes_check" CHECK ("media"."size_bytes" is null or "media"."size_bytes" >= 0),
	CONSTRAINT "media_quota_check" CHECK ("media"."quota_bytes" >= 0),
	CONSTRAINT "media_checksum_format" CHECK ("media"."checksum_sha256" is null or "media"."checksum_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "media_ready_complete" CHECK ("media"."status" <> 'ready' or ("media"."checksum_sha256" is not null and "media"."size_bytes" is not null and "media"."mime_type" is not null))
);
--> statement-breakpoint
ALTER TABLE "media" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "media_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"media_id" uuid NOT NULL,
	"variant" text NOT NULL,
	"profile" text NOT NULL,
	"storage_key" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"checksum_sha256" text NOT NULL,
	"width" integer,
	"height" integer,
	"duration_ms" integer,
	"codec_metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "media_assets_org_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "media_assets_variant_check" CHECK ("media_assets"."variant" in ('original', 'playback', 'thumbnail')),
	CONSTRAINT "media_assets_size_check" CHECK ("media_assets"."size_bytes" >= 0),
	CONSTRAINT "media_assets_checksum_format" CHECK ("media_assets"."checksum_sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "media_assets" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "media_folders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"site_id" uuid,
	"parent_id" uuid,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "media_folders_org_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "media_folders_not_own_parent" CHECK ("media_folders"."parent_id" is null or "media_folders"."parent_id" <> "media_folders"."id")
);
--> statement-breakpoint
ALTER TABLE "media_folders" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "media_tags" (
	"organization_id" uuid NOT NULL,
	"media_id" uuid NOT NULL,
	"tag_id" uuid NOT NULL,
	CONSTRAINT "media_tags_media_id_tag_id_pk" PRIMARY KEY("media_id","tag_id")
);
--> statement-breakpoint
ALTER TABLE "media_tags" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "tags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tags_org_id_unique" UNIQUE("organization_id","id")
);
--> statement-breakpoint
ALTER TABLE "tags" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "upload_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"media_id" uuid NOT NULL,
	"object_key" text NOT NULL,
	"declared_size" bigint NOT NULL,
	"declared_mime_type" text NOT NULL,
	"client_checksum_sha256" text,
	"reserved_bytes" bigint NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"cleaned_at" timestamp with time zone,
	CONSTRAINT "upload_sessions_org_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "upload_sessions_state_check" CHECK ("upload_sessions"."state" in ('pending', 'completed', 'aborted', 'expired')),
	CONSTRAINT "upload_sessions_sizes_check" CHECK ("upload_sessions"."declared_size" > 0 and "upload_sessions"."reserved_bytes" >= 0),
	CONSTRAINT "upload_sessions_checksum_format" CHECK ("upload_sessions"."client_checksum_sha256" is null or "upload_sessions"."client_checksum_sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "upload_sessions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_counters" ADD CONSTRAINT "usage_counters_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media" ADD CONSTRAINT "media_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media" ADD CONSTRAINT "media_deleted_by_users_id_fk" FOREIGN KEY ("deleted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media" ADD CONSTRAINT "media_site_same_tenant_fk" FOREIGN KEY ("organization_id","site_id") REFERENCES "public"."sites"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media" ADD CONSTRAINT "media_folder_same_tenant_fk" FOREIGN KEY ("organization_id","folder_id") REFERENCES "public"."media_folders"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_media_same_tenant_fk" FOREIGN KEY ("organization_id","media_id") REFERENCES "public"."media"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_folders" ADD CONSTRAINT "media_folders_site_same_tenant_fk" FOREIGN KEY ("organization_id","site_id") REFERENCES "public"."sites"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_folders" ADD CONSTRAINT "media_folders_parent_same_tenant_fk" FOREIGN KEY ("organization_id","parent_id") REFERENCES "public"."media_folders"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_tags" ADD CONSTRAINT "media_tags_media_same_tenant_fk" FOREIGN KEY ("organization_id","media_id") REFERENCES "public"."media"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_tags" ADD CONSTRAINT "media_tags_tag_same_tenant_fk" FOREIGN KEY ("organization_id","tag_id") REFERENCES "public"."tags"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upload_sessions" ADD CONSTRAINT "upload_sessions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upload_sessions" ADD CONSTRAINT "upload_sessions_media_same_tenant_fk" FOREIGN KEY ("organization_id","media_id") REFERENCES "public"."media"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_active_dedupe_unique" ON "jobs" USING btree ("kind","dedupe_key") WHERE "jobs"."state" in ('queued', 'running');--> statement-breakpoint
CREATE INDEX "jobs_queued_idx" ON "jobs" USING btree ("run_after") WHERE "jobs"."state" = 'queued';--> statement-breakpoint
CREATE INDEX "jobs_running_lease_idx" ON "jobs" USING btree ("lease_expires_at") WHERE "jobs"."state" = 'running';--> statement-breakpoint
CREATE INDEX "jobs_org_kind_idx" ON "jobs" USING btree ("organization_id","kind","created_at");--> statement-breakpoint
CREATE INDEX "media_org_status_deleted_idx" ON "media" USING btree ("organization_id","status","deleted_at");--> statement-breakpoint
CREATE INDEX "media_org_created_idx" ON "media" USING btree ("organization_id","created_at","id");--> statement-breakpoint
CREATE INDEX "media_org_folder_idx" ON "media" USING btree ("organization_id","folder_id");--> statement-breakpoint
CREATE INDEX "media_purge_idx" ON "media" USING btree ("purge_after") WHERE "media"."deleted_at" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "media_assets_media_variant_unique" ON "media_assets" USING btree ("media_id","variant");--> statement-breakpoint
CREATE UNIQUE INDEX "media_folders_name_unique" ON "media_folders" USING btree ("organization_id",coalesce("parent_id", '00000000-0000-0000-0000-000000000000'::uuid),lower("name"));--> statement-breakpoint
CREATE INDEX "media_tags_tag_idx" ON "media_tags" USING btree ("organization_id","tag_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tags_org_name_unique" ON "tags" USING btree ("organization_id",lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "upload_sessions_object_key_unique" ON "upload_sessions" USING btree ("object_key");--> statement-breakpoint
CREATE UNIQUE INDEX "upload_sessions_media_unique" ON "upload_sessions" USING btree ("media_id");--> statement-breakpoint
CREATE INDEX "upload_sessions_pending_idx" ON "upload_sessions" USING btree ("expires_at") WHERE "upload_sessions"."state" = 'pending';--> statement-breakpoint
CREATE INDEX "upload_sessions_uncleaned_idx" ON "upload_sessions" USING btree ("expires_at") WHERE "upload_sessions"."cleaned_at" is null;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "jobs" AS PERMISSIVE FOR ALL TO "pixlova_app" USING ("jobs"."organization_id" = nullif(current_setting('pixlova.organization_id', true), '')::uuid) WITH CHECK ("jobs"."organization_id" = nullif(current_setting('pixlova.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "usage_counters" AS PERMISSIVE FOR ALL TO "pixlova_app" USING ("usage_counters"."organization_id" = nullif(current_setting('pixlova.organization_id', true), '')::uuid) WITH CHECK ("usage_counters"."organization_id" = nullif(current_setting('pixlova.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "media" AS PERMISSIVE FOR ALL TO "pixlova_app" USING ("media"."organization_id" = nullif(current_setting('pixlova.organization_id', true), '')::uuid) WITH CHECK ("media"."organization_id" = nullif(current_setting('pixlova.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "media_assets" AS PERMISSIVE FOR ALL TO "pixlova_app" USING ("media_assets"."organization_id" = nullif(current_setting('pixlova.organization_id', true), '')::uuid) WITH CHECK ("media_assets"."organization_id" = nullif(current_setting('pixlova.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "media_folders" AS PERMISSIVE FOR ALL TO "pixlova_app" USING ("media_folders"."organization_id" = nullif(current_setting('pixlova.organization_id', true), '')::uuid) WITH CHECK ("media_folders"."organization_id" = nullif(current_setting('pixlova.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "media_tags" AS PERMISSIVE FOR ALL TO "pixlova_app" USING ("media_tags"."organization_id" = nullif(current_setting('pixlova.organization_id', true), '')::uuid) WITH CHECK ("media_tags"."organization_id" = nullif(current_setting('pixlova.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "tags" AS PERMISSIVE FOR ALL TO "pixlova_app" USING ("tags"."organization_id" = nullif(current_setting('pixlova.organization_id', true), '')::uuid) WITH CHECK ("tags"."organization_id" = nullif(current_setting('pixlova.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "upload_sessions" AS PERMISSIVE FOR ALL TO "pixlova_app" USING ("upload_sessions"."organization_id" = nullif(current_setting('pixlova.organization_id', true), '')::uuid) WITH CHECK ("upload_sessions"."organization_id" = nullif(current_setting('pixlova.organization_id', true), '')::uuid);