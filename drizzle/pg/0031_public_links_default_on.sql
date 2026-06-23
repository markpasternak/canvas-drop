ALTER TABLE "users" ALTER COLUMN "can_publish_public" SET DEFAULT true;--> statement-breakpoint
UPDATE "users" SET "can_publish_public" = true;
