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
	"deleted_at" bigint
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
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "canvases" ADD CONSTRAINT "canvases_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "versions" ADD CONSTRAINT "versions_canvas_id_canvases_id_fk" FOREIGN KEY ("canvas_id") REFERENCES "public"."canvases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "versions" ADD CONSTRAINT "versions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "canvases_slug_uq" ON "canvases" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "canvases_owner_id_idx" ON "canvases" USING btree ("owner_id");--> statement-breakpoint
CREATE UNIQUE INDEX "versions_canvas_number_uq" ON "versions" USING btree ("canvas_id","number");--> statement-breakpoint
CREATE INDEX "versions_canvas_created_idx" ON "versions" USING btree ("canvas_id","created_at");