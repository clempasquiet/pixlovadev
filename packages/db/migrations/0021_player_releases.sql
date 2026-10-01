CREATE TABLE "player_releases" (
	"id" uuid PRIMARY KEY NOT NULL,
	"version" text NOT NULL,
	"version_major" integer NOT NULL,
	"version_minor" integer NOT NULL,
	"version_patch" integer NOT NULL,
	"channel" text DEFAULT 'stable' NOT NULL,
	"os" text NOT NULL,
	"architecture" text NOT NULL,
	"sha256" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"key_id" text NOT NULL,
	"payload_hash" text NOT NULL,
	"envelope" text NOT NULL,
	"protocol_min" integer NOT NULL,
	"protocol_max" integer NOT NULL,
	"sqlite_schema" integer NOT NULL,
	"sqlite_reader_level" integer NOT NULL,
	"renderer_build" text NOT NULL,
	"artifact_key" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"notes" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone,
	"published_by" uuid,
	"blocked_at" timestamp with time zone,
	"blocked_by" uuid,
	"block_reason" text,
	CONSTRAINT "player_releases_status_check" CHECK ("player_releases"."status" in ('draft', 'published', 'blocked')),
	CONSTRAINT "player_releases_channel_check" CHECK ("player_releases"."channel" = 'stable'),
	CONSTRAINT "player_releases_os_check" CHECK ("player_releases"."os" in ('linux', 'windows')),
	CONSTRAINT "player_releases_architecture_check" CHECK ("player_releases"."architecture" in ('x86_64', 'aarch64')),
	CONSTRAINT "player_releases_sha256_check" CHECK ("player_releases"."sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "player_releases_version_check" CHECK ("player_releases"."version" = "player_releases"."version_major" || '.' || "player_releases"."version_minor" || '.' || "player_releases"."version_patch"),
	CONSTRAINT "player_releases_artifact_check" CHECK ("player_releases"."status" = 'draft' or "player_releases"."artifact_key" is not null),
	CONSTRAINT "player_releases_published_check" CHECK ("player_releases"."status" = 'draft' or "player_releases"."published_at" is not null),
	CONSTRAINT "player_releases_blocked_check" CHECK (("player_releases"."status" = 'blocked') = ("player_releases"."blocked_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "player_update_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"player_id" uuid NOT NULL,
	"release_id" uuid NOT NULL,
	"version" text NOT NULL,
	"state" text NOT NULL,
	"code" text,
	"detail" text,
	"observed_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "player_update_reports_state_check" CHECK ("player_update_reports"."state" in ('installed', 'promoted', 'rolled_back', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "player_update_reports" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "player_releases" ADD CONSTRAINT "player_releases_created_by_platform_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."platform_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_releases" ADD CONSTRAINT "player_releases_published_by_platform_users_id_fk" FOREIGN KEY ("published_by") REFERENCES "public"."platform_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_releases" ADD CONSTRAINT "player_releases_blocked_by_platform_users_id_fk" FOREIGN KEY ("blocked_by") REFERENCES "public"."platform_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_update_reports" ADD CONSTRAINT "player_update_reports_player_same_tenant_fk" FOREIGN KEY ("organization_id","player_id") REFERENCES "public"."players"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "player_releases_platform_version_unique" ON "player_releases" USING btree ("os","architecture","version");--> statement-breakpoint
CREATE INDEX "player_releases_desired_idx" ON "player_releases" USING btree ("os","architecture","status","version_major","version_minor","version_patch");--> statement-breakpoint
CREATE UNIQUE INDEX "player_update_reports_player_release_unique" ON "player_update_reports" USING btree ("player_id","release_id");--> statement-breakpoint
CREATE INDEX "player_update_reports_release_idx" ON "player_update_reports" USING btree ("release_id","state");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "player_update_reports" AS PERMISSIVE FOR ALL TO "pixlova_app" USING ("player_update_reports"."organization_id" = nullif(current_setting('pixlova.organization_id', true), '')::uuid) WITH CHECK ("player_update_reports"."organization_id" = nullif(current_setting('pixlova.organization_id', true), '')::uuid);