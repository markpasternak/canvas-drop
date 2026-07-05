CREATE TABLE "authoring_usage" (
	"id" text PRIMARY KEY NOT NULL,
	"actor_id" text NOT NULL,
	"source_canvas_id" text NOT NULL,
	"authored_canvas_id" text NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "canvases" ADD COLUMN "cap_authoring" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "authoring_usage" ADD CONSTRAINT "authoring_usage_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "authoring_usage" ADD CONSTRAINT "authoring_usage_source_canvas_id_canvases_id_fk" FOREIGN KEY ("source_canvas_id") REFERENCES "public"."canvases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "authoring_usage" ADD CONSTRAINT "authoring_usage_authored_canvas_id_canvases_id_fk" FOREIGN KEY ("authored_canvas_id") REFERENCES "public"."canvases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "authoring_usage_actor_created_idx" ON "authoring_usage" USING btree ("actor_id","created_at");--> statement-breakpoint
CREATE INDEX "authoring_usage_source_created_idx" ON "authoring_usage" USING btree ("source_canvas_id","created_at");