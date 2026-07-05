CREATE TABLE `authoring_usage` (
	`id` text PRIMARY KEY NOT NULL,
	`actor_id` text NOT NULL,
	`source_canvas_id` text NOT NULL,
	`authored_canvas_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`actor_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_canvas_id`) REFERENCES `canvases`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`authored_canvas_id`) REFERENCES `canvases`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `authoring_usage_actor_created_idx` ON `authoring_usage` (`actor_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `authoring_usage_source_created_idx` ON `authoring_usage` (`source_canvas_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `canvases` ADD `cap_authoring` integer DEFAULT false NOT NULL;