CREATE TABLE "ai_usage" (
	"id" text PRIMARY KEY NOT NULL,
	"canvas_id" text NOT NULL,
	"user_id" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"input_tokens" bigint NOT NULL,
	"output_tokens" bigint NOT NULL,
	"cost_usd" double precision NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_usage" ADD CONSTRAINT "ai_usage_canvas_id_canvases_id_fk" FOREIGN KEY ("canvas_id") REFERENCES "public"."canvases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_usage" ADD CONSTRAINT "ai_usage_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_usage_canvas_created_idx" ON "ai_usage" USING btree ("canvas_id","created_at");--> statement-breakpoint
CREATE INDEX "ai_usage_user_created_idx" ON "ai_usage" USING btree ("user_id","created_at");