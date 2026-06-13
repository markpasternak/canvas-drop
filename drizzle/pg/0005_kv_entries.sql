CREATE TABLE "kv_entries" (
	"canvas_id" text NOT NULL,
	"scope" text NOT NULL,
	"key" text NOT NULL,
	"value" jsonb NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "kv_entries_canvas_id_scope_key_pk" PRIMARY KEY("canvas_id","scope","key")
);
--> statement-breakpoint
ALTER TABLE "kv_entries" ADD CONSTRAINT "kv_entries_canvas_id_canvases_id_fk" FOREIGN KEY ("canvas_id") REFERENCES "public"."canvases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kv_entries" ADD CONSTRAINT "kv_entries_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;