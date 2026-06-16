CREATE TABLE `upload_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`canvas_id` text NOT NULL,
	`owner_id` text NOT NULL,
	`handle_hash` text NOT NULL,
	`manifest` text NOT NULL,
	`staged_hashes` text NOT NULL,
	`expires_at` integer NOT NULL,
	`finalizing_at` integer,
	`consumed_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`canvas_id`) REFERENCES `canvases`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `upload_sessions_handle_hash_uq` ON `upload_sessions` (`handle_hash`);--> statement-breakpoint
CREATE INDEX `upload_sessions_canvas_idx` ON `upload_sessions` (`canvas_id`);--> statement-breakpoint
CREATE INDEX `upload_sessions_expires_idx` ON `upload_sessions` (`expires_at`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_versions` (
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
	CONSTRAINT "versions_status_chk" CHECK("__new_versions"."status" in ('pending', 'ready')),
	CONSTRAINT "versions_source_chk" CHECK("__new_versions"."source" in ('folder', 'zip', 'paste', 'api', 'editor', 'upload'))
);
--> statement-breakpoint
INSERT INTO `__new_versions`("id", "canvas_id", "number", "created_by", "source", "status", "file_count", "total_bytes", "manifest", "created_at") SELECT "id", "canvas_id", "number", "created_by", "source", "status", "file_count", "total_bytes", "manifest", "created_at" FROM `versions`;--> statement-breakpoint
DROP TABLE `versions`;--> statement-breakpoint
ALTER TABLE `__new_versions` RENAME TO `versions`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `versions_canvas_number_uq` ON `versions` (`canvas_id`,`number`);