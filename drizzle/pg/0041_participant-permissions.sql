ALTER TABLE "canvases" ADD COLUMN "ai_audience" text DEFAULT 'editors' NOT NULL;--> statement-breakpoint
ALTER TABLE "canvases" ADD COLUMN "connections_audience" text DEFAULT 'editors' NOT NULL;--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "scope" text DEFAULT 'shared' NOT NULL;