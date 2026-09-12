ALTER TABLE "canvases" ADD COLUMN "publication_token" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "upload_sessions" ADD COLUMN "release_id" text;--> statement-breakpoint
ALTER TABLE "upload_sessions" ADD COLUMN "expected_publication_token" text;--> statement-breakpoint
ALTER TABLE "versions" ADD COLUMN "release_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "versions_canvas_release_ready_uq" ON "versions" USING btree ("canvas_id","release_id") WHERE "versions"."status" = 'ready' and "versions"."release_id" is not null;--> statement-breakpoint
UPDATE "canvases" SET "publication_token" = replace(gen_random_uuid()::text, '-', '') WHERE "publication_token" = '';
