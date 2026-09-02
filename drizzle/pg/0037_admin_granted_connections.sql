CREATE TABLE "canvas_connections" (
	"canvas_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" bigint NOT NULL,
	CONSTRAINT "canvas_connections_canvas_id_connection_id_pk" PRIMARY KEY("canvas_id","connection_id")
);
--> statement-breakpoint
CREATE TABLE "connection_profiles" (
	"id" text PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"label" text NOT NULL,
	"origin" text NOT NULL,
	"allowed_methods" jsonb NOT NULL,
	"protected_headers_envelope" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_by" text NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "canvas_connections" ADD CONSTRAINT "canvas_connections_canvas_id_canvases_id_fk" FOREIGN KEY ("canvas_id") REFERENCES "public"."canvases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canvas_connections" ADD CONSTRAINT "canvas_connections_connection_id_connection_profiles_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connection_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canvas_connections" ADD CONSTRAINT "canvas_connections_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connection_profiles" ADD CONSTRAINT "connection_profiles_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "canvas_connections_connection_idx" ON "canvas_connections" USING btree ("connection_id");--> statement-breakpoint
CREATE UNIQUE INDEX "connection_profiles_key_uq" ON "connection_profiles" USING btree ("key");