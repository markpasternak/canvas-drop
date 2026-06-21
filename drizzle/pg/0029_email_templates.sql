CREATE TABLE "email_templates" (
	"key" text PRIMARY KEY NOT NULL,
	"subject" text NOT NULL,
	"body_html" text NOT NULL,
	"body_text" text NOT NULL,
	"updated_by" text,
	"updated_at" bigint NOT NULL
);
