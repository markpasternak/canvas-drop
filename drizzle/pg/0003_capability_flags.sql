ALTER TABLE "canvases" ADD COLUMN "backend_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "canvases" ADD COLUMN "cap_kv" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "canvases" ADD COLUMN "cap_files" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "canvases" ADD COLUMN "cap_ai" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "canvases" ADD COLUMN "cap_realtime" boolean DEFAULT true NOT NULL;