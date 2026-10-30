CREATE TABLE "canvas_slug_aliases" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"canvas_id" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "canvas_slug_aliases" ADD CONSTRAINT "canvas_slug_aliases_canvas_id_canvases_id_fk" FOREIGN KEY ("canvas_id") REFERENCES "public"."canvases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canvas_slug_aliases" ADD CONSTRAINT "canvas_slug_aliases_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "canvas_slug_aliases_slug_uq" ON "canvas_slug_aliases" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "canvas_slug_aliases_canvas_idx" ON "canvas_slug_aliases" USING btree ("canvas_id");