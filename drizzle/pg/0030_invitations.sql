CREATE TABLE "invitations" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text NOT NULL,
	"role" text,
	"invited_by" text,
	"created_at" bigint NOT NULL,
	"consumed_at" bigint,
	CONSTRAINT "invitations_target_type_chk" CHECK ("invitations"."target_type" in ('team', 'canvas'))
);
--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_invited_by_users_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "invitations_email_idx" ON "invitations" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "invitations_email_target_uq" ON "invitations" USING btree ("email","target_type","target_id");--> statement-breakpoint
CREATE INDEX "invitations_invited_by_idx" ON "invitations" USING btree ("invited_by");