CREATE TABLE "platform_activation_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"platform_user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform_mfa_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"platform_user_id" uuid NOT NULL,
	"encrypted_secret" text NOT NULL,
	"last_used_step" bigint,
	"confirmed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "platform_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"platform_user_id" uuid NOT NULL,
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
CREATE TABLE "platform_user_roles" (
	"platform_user_id" uuid NOT NULL,
	"role" text NOT NULL,
	"granted_by" uuid,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "platform_user_roles_platform_user_id_role_pk" PRIMARY KEY("platform_user_id","role"),
	CONSTRAINT "platform_user_roles_role_check" CHECK ("platform_user_roles"."role" in ('super_admin', 'support', 'billing_admin', 'operations', 'content_admin'))
);
--> statement-breakpoint
CREATE TABLE "platform_users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email_normalized" text NOT NULL,
	"display_name" text NOT NULL,
	"password_hash" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_by" uuid,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "platform_users_status_check" CHECK ("platform_users"."status" in ('pending', 'active', 'disabled')),
	CONSTRAINT "platform_users_email_normalized_check" CHECK ("platform_users"."email_normalized" = lower("platform_users"."email_normalized"))
);
--> statement-breakpoint
ALTER TABLE "platform_activation_tokens" ADD CONSTRAINT "platform_activation_tokens_platform_user_id_platform_users_id_fk" FOREIGN KEY ("platform_user_id") REFERENCES "public"."platform_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_activation_tokens" ADD CONSTRAINT "platform_activation_tokens_created_by_platform_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."platform_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_mfa_credentials" ADD CONSTRAINT "platform_mfa_credentials_platform_user_id_platform_users_id_fk" FOREIGN KEY ("platform_user_id") REFERENCES "public"."platform_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_sessions" ADD CONSTRAINT "platform_sessions_platform_user_id_platform_users_id_fk" FOREIGN KEY ("platform_user_id") REFERENCES "public"."platform_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_user_roles" ADD CONSTRAINT "platform_user_roles_platform_user_id_platform_users_id_fk" FOREIGN KEY ("platform_user_id") REFERENCES "public"."platform_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_user_roles" ADD CONSTRAINT "platform_user_roles_granted_by_platform_users_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."platform_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_users" ADD CONSTRAINT "platform_users_created_by_platform_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."platform_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "platform_activation_tokens_hash_unique" ON "platform_activation_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "platform_activation_tokens_user_idx" ON "platform_activation_tokens" USING btree ("platform_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "platform_mfa_credentials_one_active" ON "platform_mfa_credentials" USING btree ("platform_user_id") WHERE "platform_mfa_credentials"."revoked_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "platform_sessions_token_hash_unique" ON "platform_sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "platform_sessions_user_idx" ON "platform_sessions" USING btree ("platform_user_id","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "platform_users_email_unique" ON "platform_users" USING btree ("email_normalized");