ALTER TABLE "canvases" ADD COLUMN "gallery_templatable" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "canvases" ADD COLUMN "cloned_from_canvas_id" text;