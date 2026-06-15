PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_ai_usage` (
	`id` text PRIMARY KEY NOT NULL,
	`canvas_id` text NOT NULL,
	`user_id` text NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`input_tokens` integer NOT NULL,
	`output_tokens` integer NOT NULL,
	`cost_usd` real NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`canvas_id`) REFERENCES `canvases`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_ai_usage`("id", "canvas_id", "user_id", "provider", "model", "input_tokens", "output_tokens", "cost_usd", "created_at") SELECT "id", "canvas_id", "user_id", "provider", "model", "input_tokens", "output_tokens", "cost_usd", "created_at" FROM `ai_usage`;--> statement-breakpoint
DROP TABLE `ai_usage`;--> statement-breakpoint
ALTER TABLE `__new_ai_usage` RENAME TO `ai_usage`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `ai_usage_canvas_created_idx` ON `ai_usage` (`canvas_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `ai_usage_user_created_idx` ON `ai_usage` (`user_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `__new_files` (
	`id` text PRIMARY KEY NOT NULL,
	`canvas_id` text NOT NULL,
	`filename` text NOT NULL,
	`mime` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`storage_key` text NOT NULL,
	`uploaded_by` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`canvas_id`) REFERENCES `canvases`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_files`("id", "canvas_id", "filename", "mime", "size_bytes", "storage_key", "uploaded_by", "created_at") SELECT "id", "canvas_id", "filename", "mime", "size_bytes", "storage_key", "uploaded_by", "created_at" FROM `files`;--> statement-breakpoint
DROP TABLE `files`;--> statement-breakpoint
ALTER TABLE `__new_files` RENAME TO `files`;--> statement-breakpoint
CREATE INDEX `files_canvas_id_idx` ON `files` (`canvas_id`);--> statement-breakpoint
CREATE TABLE `__new_kv_entries` (
	`canvas_id` text NOT NULL,
	`scope` text NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	`updated_by` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`canvas_id`, `scope`, `key`),
	FOREIGN KEY (`canvas_id`) REFERENCES `canvases`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_kv_entries`("canvas_id", "scope", "key", "value", "updated_by", "updated_at") SELECT "canvas_id", "scope", "key", "value", "updated_by", "updated_at" FROM `kv_entries`;--> statement-breakpoint
DROP TABLE `kv_entries`;--> statement-breakpoint
ALTER TABLE `__new_kv_entries` RENAME TO `kv_entries`;--> statement-breakpoint
CREATE TABLE `__new_usage_events` (
	`id` text PRIMARY KEY NOT NULL,
	`canvas_id` text NOT NULL,
	`user_id` text NOT NULL,
	`type` text NOT NULL,
	`meta` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`canvas_id`) REFERENCES `canvases`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_usage_events`("id", "canvas_id", "user_id", "type", "meta", "created_at") SELECT "id", "canvas_id", "user_id", "type", "meta", "created_at" FROM `usage_events`;--> statement-breakpoint
DROP TABLE `usage_events`;--> statement-breakpoint
ALTER TABLE `__new_usage_events` RENAME TO `usage_events`;--> statement-breakpoint
CREATE INDEX `usage_events_canvas_created_idx` ON `usage_events` (`canvas_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `usage_events_canvas_user_type_created_idx` ON `usage_events` (`canvas_id`,`user_id`,`type`,`created_at`);--> statement-breakpoint
ALTER TABLE `canvases` ADD `guest_ai_enabled` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `canvases` ADD `guest_ai_cap` real DEFAULT 0 NOT NULL;