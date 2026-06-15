ALTER TABLE "ai_usage" DROP CONSTRAINT "ai_usage_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "files" DROP CONSTRAINT "files_uploaded_by_users_id_fk";
--> statement-breakpoint
ALTER TABLE "kv_entries" DROP CONSTRAINT "kv_entries_updated_by_users_id_fk";
--> statement-breakpoint
ALTER TABLE "usage_events" DROP CONSTRAINT "usage_events_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "canvases" ADD COLUMN "guest_ai_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "canvases" ADD COLUMN "guest_ai_cap" double precision DEFAULT 0 NOT NULL;