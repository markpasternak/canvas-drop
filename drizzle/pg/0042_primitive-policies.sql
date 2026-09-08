ALTER TABLE "canvases" ADD COLUMN "runtime_policy" text;--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "record_id" text;--> statement-breakpoint
ALTER TABLE "kv_entries" ADD COLUMN "author_id" text;