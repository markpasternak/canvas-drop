CREATE TABLE "upload_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"canvas_id" text NOT NULL,
	"owner_id" text NOT NULL,
	"handle_hash" text NOT NULL,
	"manifest" jsonb NOT NULL,
	"staged_hashes" jsonb NOT NULL,
	"expires_at" bigint NOT NULL,
	"finalizing_at" bigint,
	"consumed_at" bigint,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "versions" DROP CONSTRAINT "versions_source_chk";--> statement-breakpoint
ALTER TABLE "upload_sessions" ADD CONSTRAINT "upload_sessions_canvas_id_canvases_id_fk" FOREIGN KEY ("canvas_id") REFERENCES "public"."canvases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upload_sessions" ADD CONSTRAINT "upload_sessions_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "upload_sessions_handle_hash_uq" ON "upload_sessions" USING btree ("handle_hash");--> statement-breakpoint
CREATE INDEX "upload_sessions_canvas_idx" ON "upload_sessions" USING btree ("canvas_id");--> statement-breakpoint
CREATE INDEX "upload_sessions_expires_idx" ON "upload_sessions" USING btree ("expires_at");--> statement-breakpoint
ALTER TABLE "versions" ADD CONSTRAINT "versions_source_chk" CHECK ("versions"."source" in ('folder', 'zip', 'paste', 'api', 'editor', 'upload'));