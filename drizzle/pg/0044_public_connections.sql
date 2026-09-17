ALTER TABLE "canvas_connections" ADD COLUMN "public_policy" jsonb;--> statement-breakpoint
ALTER TABLE "canvas_connections" ADD COLUMN "public_revision" text;--> statement-breakpoint
ALTER TABLE "canvas_connections" ADD COLUMN "public_day" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "canvas_connections" ADD COLUMN "public_requests" bigint DEFAULT 0 NOT NULL;