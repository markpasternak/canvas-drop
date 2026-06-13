CREATE TABLE `drafts` (
	`id` text PRIMARY KEY NOT NULL,
	`canvas_id` text NOT NULL,
	`manifest` text NOT NULL,
	`base_version_id` text,
	`stale` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`canvas_id`) REFERENCES `canvases`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `drafts_canvas_id_uq` ON `drafts` (`canvas_id`);--> statement-breakpoint
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
	CONSTRAINT "versions_source_chk" CHECK("__new_versions"."source" in ('folder', 'zip', 'paste', 'api', 'editor'))
);
--> statement-breakpoint
INSERT INTO `__new_versions`("id", "canvas_id", "number", "created_by", "source", "status", "file_count", "total_bytes", "manifest", "created_at") SELECT "id", "canvas_id", "number", "created_by", "source", "status", "file_count", "total_bytes", "manifest", "created_at" FROM `versions`;--> statement-breakpoint
DROP TABLE `versions`;--> statement-breakpoint
ALTER TABLE `__new_versions` RENAME TO `versions`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `versions_canvas_number_uq` ON `versions` (`canvas_id`,`number`);