CREATE TABLE "released_slugs" (
	"slug" text PRIMARY KEY NOT NULL,
	"canvas_id" text NOT NULL,
	"owner_id" text NOT NULL,
	"released_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "released_slugs" ADD CONSTRAINT "released_slugs_canvas_id_canvases_id_fk" FOREIGN KEY ("canvas_id") REFERENCES "public"."canvases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "released_slugs" ADD CONSTRAINT "released_slugs_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;