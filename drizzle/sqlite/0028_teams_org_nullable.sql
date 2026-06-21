PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_teams` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `orgs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_teams`("id", "org_id", "name", "slug", "created_by", "created_at") SELECT "id", "org_id", "name", "slug", "created_by", "created_at" FROM `teams`;--> statement-breakpoint
DROP TABLE `teams`;--> statement-breakpoint
ALTER TABLE `__new_teams` RENAME TO `teams`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `teams_org_slug_uq` ON `teams` (`org_id`,`slug`);--> statement-breakpoint
CREATE INDEX `teams_org_idx` ON `teams` (`org_id`);