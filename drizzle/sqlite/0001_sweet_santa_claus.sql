PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_canvases` (
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
	CONSTRAINT "canvases_status_chk" CHECK("__new_canvases"."status" in ('active', 'disabled', 'archived', 'deleted'))
);
--> statement-breakpoint
INSERT INTO `__new_canvases`("id", "slug", "title", "description", "owner_id", "shared", "shared_at", "shared_expires_at", "gallery_listed", "gallery_summary", "gallery_tags", "gallery_published_at", "password_hash", "password_version", "spa_fallback", "api_key_hash", "status", "current_version_id", "created_at", "updated_at", "deleted_at") SELECT "id", "slug", "title", "description", "owner_id", "shared", "shared_at", "shared_expires_at", "gallery_listed", "gallery_summary", "gallery_tags", "gallery_published_at", "password_hash", "password_version", "spa_fallback", "api_key_hash", "status", "current_version_id", "created_at", "updated_at", "deleted_at" FROM `canvases`;--> statement-breakpoint
DROP TABLE `canvases`;--> statement-breakpoint
ALTER TABLE `__new_canvases` RENAME TO `canvases`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `canvases_slug_uq` ON `canvases` (`slug`);--> statement-breakpoint
CREATE INDEX `canvases_owner_created_idx` ON `canvases` (`owner_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `canvases_api_key_hash_uq` ON `canvases` (`api_key_hash`);--> statement-breakpoint
CREATE INDEX `canvases_status_deleted_idx` ON `canvases` (`status`,`deleted_at`);