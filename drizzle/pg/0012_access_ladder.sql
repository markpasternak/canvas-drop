CREATE TABLE "guest_invites" (
	"id" text PRIMARY KEY NOT NULL,
	"canvas_id" text NOT NULL,
	"email" text NOT NULL,
	"token_hash" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"expires_at" bigint,
	"consumed_at" bigint,
	"created_at" bigint NOT NULL,
	CONSTRAINT "guest_invites_state_chk" CHECK ("guest_invites"."state" in ('pending', 'active', 'revoked'))
);
--> statement-breakpoint
CREATE TABLE "guest_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"invite_id" text NOT NULL,
	"canvas_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" bigint NOT NULL,
	"revoked_at" bigint,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "guest_invites" ADD CONSTRAINT "guest_invites_canvas_id_canvases_id_fk" FOREIGN KEY ("canvas_id") REFERENCES "public"."canvases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guest_sessions" ADD CONSTRAINT "guest_sessions_invite_id_guest_invites_id_fk" FOREIGN KEY ("invite_id") REFERENCES "public"."guest_invites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guest_sessions" ADD CONSTRAINT "guest_sessions_canvas_id_canvases_id_fk" FOREIGN KEY ("canvas_id") REFERENCES "public"."canvases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "guest_invites_token_hash_uq" ON "guest_invites" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "guest_invites_canvas_email_uq" ON "guest_invites" USING btree ("canvas_id","email");--> statement-breakpoint
CREATE UNIQUE INDEX "guest_sessions_token_hash_uq" ON "guest_sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "guest_sessions_invite_idx" ON "guest_sessions" USING btree ("invite_id");