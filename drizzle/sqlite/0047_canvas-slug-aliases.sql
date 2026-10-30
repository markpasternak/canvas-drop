CREATE TABLE `canvas_slug_aliases` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`canvas_id` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`canvas_id`) REFERENCES `canvases`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `canvas_slug_aliases_slug_uq` ON `canvas_slug_aliases` (`slug`);--> statement-breakpoint
CREATE INDEX `canvas_slug_aliases_canvas_idx` ON `canvas_slug_aliases` (`canvas_id`);