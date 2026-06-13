CREATE TABLE `ai_usage` (
	`id` text PRIMARY KEY NOT NULL,
	`canvas_id` text NOT NULL,
	`user_id` text NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`input_tokens` integer NOT NULL,
	`output_tokens` integer NOT NULL,
	`cost_usd` real NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`canvas_id`) REFERENCES `canvases`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `ai_usage_canvas_created_idx` ON `ai_usage` (`canvas_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `ai_usage_user_created_idx` ON `ai_usage` (`user_id`,`created_at`);