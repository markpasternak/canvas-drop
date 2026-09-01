ALTER TABLE "canvas_allowlist" ADD COLUMN "role" text DEFAULT 'viewer' NOT NULL;--> statement-breakpoint
ALTER TABLE "canvas_teams" ADD COLUMN "role" text DEFAULT 'viewer' NOT NULL;