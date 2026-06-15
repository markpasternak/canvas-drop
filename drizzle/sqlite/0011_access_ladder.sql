CREATE TABLE `canvas_allowlist` (
	`id` text PRIMARY KEY NOT NULL,
	`canvas_id` text NOT NULL,
	`principal_kind` text NOT NULL,
	`user_id` text,
	`email` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`canvas_id`) REFERENCES `canvases`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "canvas_allowlist_kind_chk" CHECK("canvas_allowlist"."principal_kind" in ('member', 'guest'))
);
--> statement-breakpoint
CREATE INDEX `canvas_allowlist_canvas_idx` ON `canvas_allowlist` (`canvas_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `canvas_allowlist_canvas_user_uq` ON `canvas_allowlist` (`canvas_id`,`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `canvas_allowlist_canvas_email_uq` ON `canvas_allowlist` (`canvas_id`,`email`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_canvases` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`title` text DEFAULT '' NOT NULL,
	`description` text,
	`owner_id` text NOT NULL,
	`access` text DEFAULT 'private' NOT NULL,
	`shared_expires_at` integer,
	`gallery_listed` integer DEFAULT false NOT NULL,
	`gallery_templatable` integer DEFAULT false NOT NULL,
	`gallery_summary` text,
	`gallery_tags` text,
	`gallery_published_at` integer,
	`password_hash` text,
	`password_version` integer DEFAULT 0 NOT NULL,
	`spa_fallback` integer DEFAULT false NOT NULL,
	`backend_enabled` integer DEFAULT false NOT NULL,
	`cap_kv` integer DEFAULT true NOT NULL,
	`cap_files` integer DEFAULT true NOT NULL,
	`cap_ai` integer DEFAULT true NOT NULL,
	`cap_realtime` integer DEFAULT true NOT NULL,
	`api_key_hash` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`disabled_reason` text,
	`current_version_id` text,
	`cloned_from_canvas_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "canvases_status_chk" CHECK("__new_canvases"."status" in ('active', 'disabled', 'archived', 'deleted')),
	CONSTRAINT "canvases_access_chk" CHECK("__new_canvases"."access" in ('private', 'specific_people', 'whole_org', 'public_link'))
);
--> statement-breakpoint
INSERT INTO `__new_canvases`("id", "slug", "title", "description", "owner_id", "access", "shared_expires_at", "gallery_listed", "gallery_templatable", "gallery_summary", "gallery_tags", "gallery_published_at", "password_hash", "password_version", "spa_fallback", "backend_enabled", "cap_kv", "cap_files", "cap_ai", "cap_realtime", "api_key_hash", "status", "disabled_reason", "current_version_id", "cloned_from_canvas_id", "created_at", "updated_at", "deleted_at") SELECT "id", "slug", "title", "description", "owner_id", CASE WHEN "shared" = 1 THEN 'whole_org' ELSE 'private' END, "shared_expires_at", "gallery_listed", "gallery_templatable", "gallery_summary", "gallery_tags", "gallery_published_at", "password_hash", "password_version", "spa_fallback", "backend_enabled", "cap_kv", "cap_files", "cap_ai", "cap_realtime", "api_key_hash", "status", "disabled_reason", "current_version_id", "cloned_from_canvas_id", "created_at", "updated_at", "deleted_at" FROM `canvases`;--> statement-breakpoint
DROP TABLE `canvases`;--> statement-breakpoint
ALTER TABLE `__new_canvases` RENAME TO `canvases`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `canvases_slug_uq` ON `canvases` (`slug`);--> statement-breakpoint
CREATE INDEX `canvases_owner_created_idx` ON `canvases` (`owner_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `canvases_api_key_hash_uq` ON `canvases` (`api_key_hash`);--> statement-breakpoint
CREATE INDEX `canvases_status_deleted_idx` ON `canvases` (`status`,`deleted_at`);