CREATE TABLE `audit_log` (
	`id` text PRIMARY KEY NOT NULL,
	`actor_id` text,
	`action` text NOT NULL,
	`target_type` text,
	`target_id` text,
	`meta` text,
	`ip` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `audit_log_created_at_idx` ON `audit_log` (`created_at`);--> statement-breakpoint
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
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "canvases_status_chk" CHECK("canvases"."status" in ('active', 'disabled', 'deleted'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `canvases_slug_uq` ON `canvases` (`slug`);--> statement-breakpoint
CREATE INDEX `canvases_owner_created_idx` ON `canvases` (`owner_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `canvases_api_key_hash_uq` ON `canvases` (`api_key_hash`);--> statement-breakpoint
CREATE INDEX `canvases_status_deleted_idx` ON `canvases` (`status`,`deleted_at`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`ip` text,
	`user_agent` text,
	`revoked_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_token_hash_uq` ON `sessions` (`token_hash`);--> statement-breakpoint
CREATE INDEX `sessions_user_id_idx` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`provider_sub` text NOT NULL,
	`email` text NOT NULL,
	`name` text NOT NULL,
	`avatar_url` text,
	`is_admin` integer DEFAULT false NOT NULL,
	`is_blocked` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`last_seen_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_provider_sub_uq` ON `users` (`provider_sub`);--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_uq` ON `users` (`email`);--> statement-breakpoint
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
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "versions_status_chk" CHECK("versions"."status" in ('pending', 'ready')),
	CONSTRAINT "versions_source_chk" CHECK("versions"."source" in ('folder', 'zip', 'paste', 'api'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `versions_canvas_number_uq` ON `versions` (`canvas_id`,`number`);