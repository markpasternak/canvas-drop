CREATE TABLE "org_domains" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"domain" text NOT NULL,
	"verified_at" bigint,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orgs" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "canvases" DROP CONSTRAINT "canvases_access_chk";--> statement-breakpoint
ALTER TABLE "canvases" ADD COLUMN "org_id" text;--> statement-breakpoint
ALTER TABLE "org_domains" ADD CONSTRAINT "org_domains_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "org_domains_domain_uq" ON "org_domains" USING btree ("domain");--> statement-breakpoint
CREATE INDEX "org_domains_org_id_idx" ON "org_domains" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "orgs_slug_uq" ON "orgs" USING btree ("slug");--> statement-breakpoint
ALTER TABLE "canvases" ADD CONSTRAINT "canvases_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canvases" ADD CONSTRAINT "canvases_access_chk" CHECK ("canvases"."access" in ('private', 'specific_people', 'team', 'whole_org', 'public_link'));