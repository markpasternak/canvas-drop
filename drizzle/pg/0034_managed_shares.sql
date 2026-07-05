ALTER TABLE "canvases" ADD COLUMN "revoked_at" bigint;--> statement-breakpoint
ALTER TABLE "canvases" ADD COLUMN "metadata" jsonb;