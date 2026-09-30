CREATE TABLE "idempotency_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"actor_id" uuid NOT NULL,
	"operation" text NOT NULL,
	"key" text NOT NULL,
	"request_hash" text NOT NULL,
	"response_status" integer NOT NULL,
	"response_body" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "idempotency_keys" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "pairing_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"installation_uuid" uuid NOT NULL,
	"player_type" text NOT NULL,
	"public_key" text NOT NULL,
	"capabilities" jsonb NOT NULL,
	"outputs" jsonb NOT NULL,
	"app_version" text NOT NULL,
	"machine_fingerprint_hash" text,
	"code_hash" text NOT NULL,
	"poll_secret_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ip" "inet",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claimed_at" timestamp with time zone,
	"claimed_by" uuid,
	"organization_id" uuid,
	"player_id" uuid,
	"delivered_at" timestamp with time zone,
	CONSTRAINT "pairing_sessions_type_check" CHECK ("pairing_sessions"."player_type" in ('native', 'web')),
	CONSTRAINT "pairing_sessions_claim_check" CHECK (("pairing_sessions"."claimed_at" is null) = ("pairing_sessions"."organization_id" is null) and ("pairing_sessions"."claimed_at" is null) = ("pairing_sessions"."player_id" is null))
);
--> statement-breakpoint
ALTER TABLE "pairing_sessions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "player_access_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"player_id" uuid NOT NULL,
	"credential_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "player_access_tokens" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "player_auth_challenges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"player_id" uuid NOT NULL,
	"document" jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "player_auth_challenges" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "player_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"player_id" uuid NOT NULL,
	"credential_type" text NOT NULL,
	"public_key" text NOT NULL,
	"generation" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "player_credentials_org_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "player_credentials_type_check" CHECK ("player_credentials"."credential_type" = 'ed25519')
);
--> statement-breakpoint
ALTER TABLE "player_credentials" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "displays" ADD COLUMN "fallback_mode" text DEFAULT 'standby_screen' NOT NULL;--> statement-breakpoint
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pairing_sessions" ADD CONSTRAINT "pairing_sessions_claimed_by_users_id_fk" FOREIGN KEY ("claimed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pairing_sessions" ADD CONSTRAINT "pairing_sessions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_access_tokens" ADD CONSTRAINT "player_access_tokens_player_same_tenant_fk" FOREIGN KEY ("organization_id","player_id") REFERENCES "public"."players"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_access_tokens" ADD CONSTRAINT "player_access_tokens_credential_same_tenant_fk" FOREIGN KEY ("organization_id","credential_id") REFERENCES "public"."player_credentials"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_auth_challenges" ADD CONSTRAINT "player_auth_challenges_player_same_tenant_fk" FOREIGN KEY ("organization_id","player_id") REFERENCES "public"."players"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_credentials" ADD CONSTRAINT "player_credentials_player_same_tenant_fk" FOREIGN KEY ("organization_id","player_id") REFERENCES "public"."players"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idempotency_keys_scope_unique" ON "idempotency_keys" USING btree ("organization_id","actor_id","operation","key");--> statement-breakpoint
CREATE INDEX "idempotency_keys_created_idx" ON "idempotency_keys" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "pairing_sessions_pending_code_unique" ON "pairing_sessions" USING btree ("code_hash") WHERE "pairing_sessions"."claimed_at" is null;--> statement-breakpoint
CREATE INDEX "pairing_sessions_expires_idx" ON "pairing_sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "player_access_tokens_hash_unique" ON "player_access_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "player_access_tokens_player_idx" ON "player_access_tokens" USING btree ("player_id","expires_at");--> statement-breakpoint
CREATE INDEX "player_auth_challenges_player_idx" ON "player_auth_challenges" USING btree ("player_id","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "player_credentials_generation_unique" ON "player_credentials" USING btree ("player_id","generation");--> statement-breakpoint
CREATE UNIQUE INDEX "player_credentials_one_active" ON "player_credentials" USING btree ("player_id") WHERE "player_credentials"."revoked_at" is null;--> statement-breakpoint
ALTER TABLE "displays" ADD CONSTRAINT "displays_fallback_check" CHECK ("displays"."fallback_mode" in ('standby_screen'));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "idempotency_keys" AS PERMISSIVE FOR ALL TO "pixlova_app" USING ("idempotency_keys"."organization_id" = nullif(current_setting('pixlova.organization_id', true), '')::uuid) WITH CHECK ("idempotency_keys"."organization_id" = nullif(current_setting('pixlova.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "pairing_sessions" AS PERMISSIVE FOR ALL TO "pixlova_app" USING ("pairing_sessions"."organization_id" = nullif(current_setting('pixlova.organization_id', true), '')::uuid) WITH CHECK ("pairing_sessions"."organization_id" = nullif(current_setting('pixlova.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "player_access_tokens" AS PERMISSIVE FOR ALL TO "pixlova_app" USING ("player_access_tokens"."organization_id" = nullif(current_setting('pixlova.organization_id', true), '')::uuid) WITH CHECK ("player_access_tokens"."organization_id" = nullif(current_setting('pixlova.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "player_auth_challenges" AS PERMISSIVE FOR ALL TO "pixlova_app" USING ("player_auth_challenges"."organization_id" = nullif(current_setting('pixlova.organization_id', true), '')::uuid) WITH CHECK ("player_auth_challenges"."organization_id" = nullif(current_setting('pixlova.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "player_credentials" AS PERMISSIVE FOR ALL TO "pixlova_app" USING ("player_credentials"."organization_id" = nullif(current_setting('pixlova.organization_id', true), '')::uuid) WITH CHECK ("player_credentials"."organization_id" = nullif(current_setting('pixlova.organization_id', true), '')::uuid);