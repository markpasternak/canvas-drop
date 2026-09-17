ALTER TABLE `canvas_connections` ADD `public_policy` text;--> statement-breakpoint
ALTER TABLE `canvas_connections` ADD `public_revision` text;--> statement-breakpoint
ALTER TABLE `canvas_connections` ADD `public_day` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `canvas_connections` ADD `public_requests` integer DEFAULT 0 NOT NULL;