CREATE TABLE "audit_log" (
	"id" text PRIMARY KEY NOT NULL,
	"actor_id" text,
	"action" text NOT NULL,
	"target_type" text,
	"target_id" text,
	"meta" jsonb,
	"ip" text,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "canvases" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"description" text,
	"owner_id" text NOT NULL,
	"shared" boolean DEFAULT false NOT NULL,
	"shared_at" bigint,
	"shared_expires_at" bigint,
	"gallery_listed" boolean DEFAULT false NOT NULL,
	"gallery_summary" text,
	"gallery_tags" jsonb,
	"gallery_published_at" bigint,
	"password_hash" text,
	"password_version" bigint DEFAULT 0 NOT NULL,
	"spa_fallback" boolean DEFAULT false NOT NULL,
	"api_key_hash" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"current_version_id" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	"deleted_at" bigint,
	CONSTRAINT "canvases_status_chk" CHECK ("canvases"."status" in ('active', 'disabled', 'deleted'))
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" bigint NOT NULL,
	"expires_at" bigint NOT NULL,
	"ip" text,
	"user_agent" text,
	"revoked_at" bigint
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"provider_sub" text NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"avatar_url" text,
	"is_admin" boolean DEFAULT false NOT NULL,
	"is_blocked" boolean DEFAULT false NOT NULL,
	"created_at" bigint NOT NULL,
	"last_seen_at" bigint
);
--> statement-breakpoint
CREATE TABLE "versions" (
	"id" text PRIMARY KEY NOT NULL,
	"canvas_id" text NOT NULL,
	"number" bigint NOT NULL,
	"created_by" text NOT NULL,
	"source" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"file_count" bigint DEFAULT 0 NOT NULL,
	"total_bytes" bigint DEFAULT 0 NOT NULL,
	"manifest" jsonb,
	"created_at" bigint NOT NULL,
	CONSTRAINT "versions_status_chk" CHECK ("versions"."status" in ('pending', 'ready')),
	CONSTRAINT "versions_source_chk" CHECK ("versions"."source" in ('folder', 'zip', 'paste', 'api'))
);
--> statement-breakpoint
ALTER TABLE "canvases" ADD CONSTRAINT "canvases_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "versions" ADD CONSTRAINT "versions_canvas_id_canvases_id_fk" FOREIGN KEY ("canvas_id") REFERENCES "public"."canvases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "versions" ADD CONSTRAINT "versions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_log_created_at_idx" ON "audit_log" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "canvases_slug_uq" ON "canvases" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "canvases_owner_created_idx" ON "canvases" USING btree ("owner_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "canvases_api_key_hash_uq" ON "canvases" USING btree ("api_key_hash");--> statement-breakpoint
CREATE INDEX "canvases_status_deleted_idx" ON "canvases" USING btree ("status","deleted_at");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_token_hash_uq" ON "sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "sessions_user_id_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_provider_sub_uq" ON "users" USING btree ("provider_sub");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_uq" ON "users" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "versions_canvas_number_uq" ON "versions" USING btree ("canvas_id","number");