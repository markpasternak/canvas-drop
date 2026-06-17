CREATE TABLE "screenshot_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"canvas_id" text NOT NULL,
	"version_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" bigint DEFAULT 0 NOT NULL,
	"leased_at" bigint,
	"last_error" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "screenshot_jobs_status_chk" CHECK ("screenshot_jobs"."status" in ('pending', 'running', 'done', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "screenshot_jobs" ADD CONSTRAINT "screenshot_jobs_canvas_id_canvases_id_fk" FOREIGN KEY ("canvas_id") REFERENCES "public"."canvases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "screenshot_jobs_canvas_uq" ON "screenshot_jobs" USING btree ("canvas_id");--> statement-breakpoint
CREATE INDEX "screenshot_jobs_status_leased_idx" ON "screenshot_jobs" USING btree ("status","leased_at");--> statement-breakpoint
CREATE INDEX "screenshot_jobs_status_updated_idx" ON "screenshot_jobs" USING btree ("status","updated_at");