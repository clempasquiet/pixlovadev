CREATE TABLE "auth_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_tokens_purpose_check" CHECK ("auth_tokens"."purpose" in ('email_verification', 'password_reset'))
);
--> statement-breakpoint
CREATE TABLE "email_outbox" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"template" text NOT NULL,
	"recipient" text NOT NULL,
	"payload_encrypted" "bytea",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text
);
--> statement-breakpoint
CREATE TABLE "mfa_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"type" text NOT NULL,
	"encrypted_secret" text NOT NULL,
	"last_used_step" bigint,
	"confirmed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "mfa_credentials_type_check" CHECK ("mfa_credentials"."type" = 'totp')
);
--> statement-breakpoint
CREATE TABLE "mfa_recovery_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"code_hash" text NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"idle_expires_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"authenticated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"mfa_verified_at" timestamp with time zone,
	"ip" "inet",
	"user_agent" text,
	"revoked_at" timestamp with time zone,
	"revoke_reason" text
);
--> statement-breakpoint
CREATE TABLE "invitation_sites" (
	"organization_id" uuid NOT NULL,
	"invitation_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	CONSTRAINT "invitation_sites_invitation_id_site_id_pk" PRIMARY KEY("invitation_id","site_id")
);
--> statement-breakpoint
ALTER TABLE "invitation_sites" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "invitations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"email_normalized" text NOT NULL,
	"role_key" text NOT NULL,
	"scope_type" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"accepted_by" uuid,
	"revoked_at" timestamp with time zone,
	"invited_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invitations_org_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "invitations_role_check" CHECK ("invitations"."role_key" in ('Owner', 'Admin', 'ContentManager', 'Operator', 'Technician', 'Viewer', 'BillingManager')),
	CONSTRAINT "invitations_scope_check" CHECK ("invitations"."scope_type" in ('organization', 'sites'))
);
--> statement-breakpoint
ALTER TABLE "invitations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "membership_grant_sites" (
	"organization_id" uuid NOT NULL,
	"grant_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	CONSTRAINT "membership_grant_sites_grant_id_site_id_pk" PRIMARY KEY("grant_id","site_id")
);
--> statement-breakpoint
ALTER TABLE "membership_grant_sites" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "membership_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"membership_id" uuid NOT NULL,
	"role_key" text NOT NULL,
	"scope_type" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	CONSTRAINT "membership_grants_org_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "membership_grants_role_check" CHECK ("membership_grants"."role_key" in ('Owner', 'Admin', 'ContentManager', 'Operator', 'Technician', 'Viewer', 'BillingManager')),
	CONSTRAINT "membership_grants_scope_check" CHECK ("membership_grants"."scope_type" in ('organization', 'sites'))
);
--> statement-breakpoint
ALTER TABLE "membership_grants" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "display_name" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "password_changed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "auth_tokens" ADD CONSTRAINT "auth_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mfa_credentials" ADD CONSTRAINT "mfa_credentials_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mfa_recovery_codes" ADD CONSTRAINT "mfa_recovery_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_sessions" ADD CONSTRAINT "user_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitation_sites" ADD CONSTRAINT "invitation_sites_invitation_same_tenant_fk" FOREIGN KEY ("organization_id","invitation_id") REFERENCES "public"."invitations"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitation_sites" ADD CONSTRAINT "invitation_sites_site_same_tenant_fk" FOREIGN KEY ("organization_id","site_id") REFERENCES "public"."sites"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_accepted_by_users_id_fk" FOREIGN KEY ("accepted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_invited_by_users_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership_grant_sites" ADD CONSTRAINT "membership_grant_sites_grant_same_tenant_fk" FOREIGN KEY ("organization_id","grant_id") REFERENCES "public"."membership_grants"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership_grant_sites" ADD CONSTRAINT "membership_grant_sites_site_same_tenant_fk" FOREIGN KEY ("organization_id","site_id") REFERENCES "public"."sites"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership_grants" ADD CONSTRAINT "membership_grants_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership_grants" ADD CONSTRAINT "membership_grants_membership_same_tenant_fk" FOREIGN KEY ("organization_id","membership_id") REFERENCES "public"."memberships"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "auth_tokens_token_hash_unique" ON "auth_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "auth_tokens_user_purpose_idx" ON "auth_tokens" USING btree ("user_id","purpose");--> statement-breakpoint
CREATE INDEX "email_outbox_pending_idx" ON "email_outbox" USING btree ("next_attempt_at") WHERE "email_outbox"."sent_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "mfa_credentials_one_active" ON "mfa_credentials" USING btree ("user_id") WHERE "mfa_credentials"."revoked_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "mfa_recovery_codes_hash_unique" ON "mfa_recovery_codes" USING btree ("user_id","code_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "user_sessions_token_hash_unique" ON "user_sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "user_sessions_user_idx" ON "user_sessions" USING btree ("user_id","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "invitations_token_hash_unique" ON "invitations" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "invitations_one_pending" ON "invitations" USING btree ("organization_id","email_normalized") WHERE "invitations"."accepted_at" is null and "invitations"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "membership_grant_sites_site_idx" ON "membership_grant_sites" USING btree ("organization_id","site_id");--> statement-breakpoint
CREATE UNIQUE INDEX "membership_grants_role_scope_unique" ON "membership_grants" USING btree ("membership_id","role_key","scope_type");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "invitation_sites" AS PERMISSIVE FOR ALL TO "pixlova_app" USING ("invitation_sites"."organization_id" = nullif(current_setting('pixlova.organization_id', true), '')::uuid) WITH CHECK ("invitation_sites"."organization_id" = nullif(current_setting('pixlova.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "invitations" AS PERMISSIVE FOR ALL TO "pixlova_app" USING ("invitations"."organization_id" = nullif(current_setting('pixlova.organization_id', true), '')::uuid) WITH CHECK ("invitations"."organization_id" = nullif(current_setting('pixlova.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "membership_grant_sites" AS PERMISSIVE FOR ALL TO "pixlova_app" USING ("membership_grant_sites"."organization_id" = nullif(current_setting('pixlova.organization_id', true), '')::uuid) WITH CHECK ("membership_grant_sites"."organization_id" = nullif(current_setting('pixlova.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "membership_grants" AS PERMISSIVE FOR ALL TO "pixlova_app" USING ("membership_grants"."organization_id" = nullif(current_setting('pixlova.organization_id', true), '')::uuid) WITH CHECK ("membership_grants"."organization_id" = nullif(current_setting('pixlova.organization_id', true), '')::uuid);