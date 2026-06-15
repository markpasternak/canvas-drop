CREATE TABLE "canvas_allowlist" (
	"id" text PRIMARY KEY NOT NULL,
	"canvas_id" text NOT NULL,
	"principal_kind" text NOT NULL,
	"user_id" text,
	"email" text,
	"created_at" bigint NOT NULL,
	CONSTRAINT "canvas_allowlist_kind_chk" CHECK ("canvas_allowlist"."principal_kind" in ('member', 'guest'))
);
--> statement-breakpoint
ALTER TABLE "canvases" ADD COLUMN "access" text DEFAULT 'private' NOT NULL;--> statement-breakpoint
UPDATE "canvases" SET "access" = 'whole_org' WHERE "shared" = true;--> statement-breakpoint
ALTER TABLE "canvas_allowlist" ADD CONSTRAINT "canvas_allowlist_canvas_id_canvases_id_fk" FOREIGN KEY ("canvas_id") REFERENCES "public"."canvases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canvas_allowlist" ADD CONSTRAINT "canvas_allowlist_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "canvas_allowlist_canvas_idx" ON "canvas_allowlist" USING btree ("canvas_id");--> statement-breakpoint
CREATE UNIQUE INDEX "canvas_allowlist_canvas_user_uq" ON "canvas_allowlist" USING btree ("canvas_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "canvas_allowlist_canvas_email_uq" ON "canvas_allowlist" USING btree ("canvas_id","email");--> statement-breakpoint
ALTER TABLE "canvases" DROP COLUMN "shared";--> statement-breakpoint
ALTER TABLE "canvases" DROP COLUMN "shared_at";--> statement-breakpoint
ALTER TABLE "canvases" ADD CONSTRAINT "canvases_access_chk" CHECK ("canvases"."access" in ('private', 'specific_people', 'whole_org', 'public_link'));