CREATE TABLE "usage_events" (
	"id" text PRIMARY KEY NOT NULL,
	"canvas_id" text NOT NULL,
	"user_id" text NOT NULL,
	"type" text NOT NULL,
	"meta" jsonb,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_canvas_id_canvases_id_fk" FOREIGN KEY ("canvas_id") REFERENCES "public"."canvases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "usage_events_canvas_created_idx" ON "usage_events" USING btree ("canvas_id","created_at");