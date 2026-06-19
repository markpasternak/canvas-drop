ALTER TABLE "canvases" ADD COLUMN "tags" jsonb;--> statement-breakpoint
ALTER TABLE "canvases" ADD COLUMN "gallery_featured" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "canvases" ADD COLUMN "search_text" text;--> statement-breakpoint
ALTER TABLE "canvases" DROP COLUMN "gallery_tags";