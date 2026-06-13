CREATE TABLE `usage_events` (
	`id` text PRIMARY KEY NOT NULL,
	`canvas_id` text NOT NULL,
	`user_id` text NOT NULL,
	`type` text NOT NULL,
	`meta` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`canvas_id`) REFERENCES `canvases`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `usage_events_canvas_created_idx` ON `usage_events` (`canvas_id`,`created_at`);