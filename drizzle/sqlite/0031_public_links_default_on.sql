PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_users` (
	`id` text PRIMARY KEY NOT NULL,
	`provider_sub` text NOT NULL,
	`email` text NOT NULL,
	`name` text NOT NULL,
	`avatar_url` text,
	`is_admin` integer DEFAULT false NOT NULL,
	`is_blocked` integer DEFAULT false NOT NULL,
	`can_publish_public` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`last_seen_at` integer
);
--> statement-breakpoint
INSERT INTO `__new_users`("id", "provider_sub", "email", "name", "avatar_url", "is_admin", "is_blocked", "can_publish_public", "created_at", "last_seen_at") SELECT "id", "provider_sub", "email", "name", "avatar_url", "is_admin", "is_blocked", "can_publish_public", "created_at", "last_seen_at" FROM `users`;--> statement-breakpoint
DROP TABLE `users`;--> statement-breakpoint
ALTER TABLE `__new_users` RENAME TO `users`;--> statement-breakpoint
UPDATE `users` SET `can_publish_public` = true;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `users_provider_sub_uq` ON `users` (`provider_sub`);--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_uq` ON `users` (`email`);
