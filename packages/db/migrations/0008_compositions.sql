CREATE TABLE "composition_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"composition_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"schema_version" integer NOT NULL,
	"document" jsonb NOT NULL,
	"restored_from" integer,
	"published_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "composition_versions_org_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "composition_versions_number_unique" UNIQUE("composition_id","version"),
	CONSTRAINT "composition_versions_version_check" CHECK ("composition_versions"."version" >= 1)
);
--> statement-breakpoint
ALTER TABLE "composition_versions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "compositions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"site_id" uuid,
	"name" text NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"draft_document" jsonb NOT NULL,
	"draft_revision" integer DEFAULT 1 NOT NULL,
	"has_unpublished_changes" boolean DEFAULT true NOT NULL,
	"published_version" integer,
	"published_version_id" uuid,
	"published_at" timestamp with time zone,
	"source_template_key" text,
	"source_template_version" integer,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "compositions_org_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "compositions_revision_check" CHECK ("compositions"."draft_revision" >= 1),
	CONSTRAINT "compositions_dimensions_check" CHECK ("compositions"."width" between 1 and 32767 and "compositions"."height" between 1 and 32767),
	CONSTRAINT "compositions_published_pair" CHECK (("compositions"."published_version" is null) = ("compositions"."published_version_id" is null))
);
--> statement-breakpoint
ALTER TABLE "compositions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "content_dependencies" (
	"organization_id" uuid NOT NULL,
	"composition_version_id" uuid NOT NULL,
	"media_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "content_dependencies_composition_version_id_media_id_pk" PRIMARY KEY("composition_version_id","media_id")
);
--> statement-breakpoint
ALTER TABLE "content_dependencies" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "composition_versions" ADD CONSTRAINT "composition_versions_published_by_users_id_fk" FOREIGN KEY ("published_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "composition_versions" ADD CONSTRAINT "composition_versions_composition_same_tenant_fk" FOREIGN KEY ("organization_id","composition_id") REFERENCES "public"."compositions"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compositions" ADD CONSTRAINT "compositions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compositions" ADD CONSTRAINT "compositions_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compositions" ADD CONSTRAINT "compositions_site_same_tenant_fk" FOREIGN KEY ("organization_id","site_id") REFERENCES "public"."sites"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_dependencies" ADD CONSTRAINT "content_dependencies_version_same_tenant_fk" FOREIGN KEY ("organization_id","composition_version_id") REFERENCES "public"."composition_versions"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_dependencies" ADD CONSTRAINT "content_dependencies_media_same_tenant_fk" FOREIGN KEY ("organization_id","media_id") REFERENCES "public"."media"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "compositions_org_updated_idx" ON "compositions" USING btree ("organization_id","updated_at","id");--> statement-breakpoint
CREATE INDEX "content_dependencies_media_idx" ON "content_dependencies" USING btree ("organization_id","media_id");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "composition_versions" AS PERMISSIVE FOR ALL TO "pixlova_app" USING ("composition_versions"."organization_id" = nullif(current_setting('pixlova.organization_id', true), '')::uuid) WITH CHECK ("composition_versions"."organization_id" = nullif(current_setting('pixlova.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "compositions" AS PERMISSIVE FOR ALL TO "pixlova_app" USING ("compositions"."organization_id" = nullif(current_setting('pixlova.organization_id', true), '')::uuid) WITH CHECK ("compositions"."organization_id" = nullif(current_setting('pixlova.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "content_dependencies" AS PERMISSIVE FOR ALL TO "pixlova_app" USING ("content_dependencies"."organization_id" = nullif(current_setting('pixlova.organization_id', true), '')::uuid) WITH CHECK ("content_dependencies"."organization_id" = nullif(current_setting('pixlova.organization_id', true), '')::uuid);