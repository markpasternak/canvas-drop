ALTER TABLE "canvases" ADD COLUMN "purge_started_at" bigint;--> statement-breakpoint
ALTER TABLE "canvases" ADD COLUMN "purged_at" bigint;