ALTER TABLE "canvases" ADD COLUMN "discoverability" text DEFAULT 'link_only' NOT NULL;--> statement-breakpoint
UPDATE "canvases" SET "discoverability" = 'listed' WHERE "access" = 'whole_org' AND "gallery_listed" = true;--> statement-breakpoint
ALTER TABLE "canvases" ADD CONSTRAINT "canvases_discoverability_chk" CHECK ("canvases"."discoverability" in ('link_only', 'listed'));
