ALTER TABLE `canvas_allowlist` ADD `role` text DEFAULT 'viewer' NOT NULL;--> statement-breakpoint
ALTER TABLE `canvas_teams` ADD `role` text DEFAULT 'viewer' NOT NULL;