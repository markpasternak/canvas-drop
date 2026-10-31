CREATE TABLE `released_slugs` (
	`slug` text PRIMARY KEY NOT NULL,
	`canvas_id` text NOT NULL,
	`owner_id` text NOT NULL,
	`released_at` integer NOT NULL,
	FOREIGN KEY (`canvas_id`) REFERENCES `canvases`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
