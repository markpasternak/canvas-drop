ALTER TABLE "canvases" ADD COLUMN "link_preview_mode" text;--> statement-breakpoint
UPDATE "canvases" SET "link_preview_mode" = 'on' WHERE "link_preview" = true;
