CREATE TABLE `canvases` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`title` text DEFAULT '' NOT NULL,
	`description` text,
	`owner_id` text NOT NULL,
	`shared` integer DEFAULT false NOT NULL,
	`shared_at` integer,
	`shared_expires_at` integer,
	`gallery_listed` integer DEFAULT false NOT NULL,
	`gallery_summary` text,
	`gallery_tags` text,
	`gallery_published_at` integer,
	`password_hash` text,
	`password_version` integer DEFAULT 0 NOT NULL,
	`spa_fallback` integer DEFAULT false NOT NULL,
	`api_key_hash` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`current_version_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `canvases_slug_uq` ON `canvases` (`slug`);--> statement-breakpoint
CREATE INDEX `canvases_owner_id_idx` ON `canvases` (`owner_id`);--> statement-breakpoint
CREATE TABLE `versions` (
	`id` text PRIMARY KEY NOT NULL,
	`canvas_id` text NOT NULL,
	`number` integer NOT NULL,
	`created_by` text NOT NULL,
	`source` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`file_count` integer DEFAULT 0 NOT NULL,
	`total_bytes` integer DEFAULT 0 NOT NULL,
	`manifest` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`canvas_id`) REFERENCES `canvases`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `versions_canvas_number_uq` ON `versions` (`canvas_id`,`number`);--> statement-breakpoint
CREATE INDEX `versions_canvas_created_idx` ON `versions` (`canvas_id`,`created_at`);