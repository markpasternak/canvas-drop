CREATE TABLE `allowed_emails` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `allowed_emails_email_uq` ON `allowed_emails` (`email`);