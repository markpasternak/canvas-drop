CREATE TABLE "drafts" (
	"id" text PRIMARY KEY NOT NULL,
	"canvas_id" text NOT NULL,
	"manifest" jsonb NOT NULL,
	"base_version_id" text,
	"stale" boolean DEFAULT false NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "versions" DROP CONSTRAINT "versions_source_chk";--> statement-breakpoint
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_canvas_id_canvases_id_fk" FOREIGN KEY ("canvas_id") REFERENCES "public"."canvases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "drafts_canvas_id_uq" ON "drafts" USING btree ("canvas_id");--> statement-breakpoint
ALTER TABLE "versions" ADD CONSTRAINT "versions_source_chk" CHECK ("versions"."source" in ('folder', 'zip', 'paste', 'api', 'editor'));