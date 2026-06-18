ALTER TABLE "canvases" ADD COLUMN "view_count" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "canvases" ADD COLUMN "last_viewed_at" bigint;