CREATE TABLE `org_domains` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`domain` text NOT NULL,
	`verified_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `orgs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `org_domains_domain_uq` ON `org_domains` (`domain`);--> statement-breakpoint
CREATE INDEX `org_domains_org_id_idx` ON `org_domains` (`org_id`);--> statement-breakpoint
CREATE TABLE `orgs` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `orgs_slug_uq` ON `orgs` (`slug`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_canvases` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`slug_custom` integer DEFAULT false NOT NULL,
	`title` text DEFAULT '' NOT NULL,
	`description` text,
	`owner_id` text NOT NULL,
	`org_id` text,
	`access` text DEFAULT 'private' NOT NULL,
	`shared_expires_at` integer,
	`gallery_listed` integer DEFAULT false NOT NULL,
	`gallery_templatable` integer DEFAULT false NOT NULL,
	`tags` text,
	`gallery_featured` integer DEFAULT false NOT NULL,
	`search_text` text,
	`gallery_published_at` integer,
	`password_hash` text,
	`password_version` integer DEFAULT 0 NOT NULL,
	`spa_fallback` integer DEFAULT false NOT NULL,
	`preview_mode` text DEFAULT 'auto' NOT NULL,
	`backend_enabled` integer DEFAULT false NOT NULL,
	`cap_kv` integer DEFAULT true NOT NULL,
	`cap_files` integer DEFAULT true NOT NULL,
	`cap_ai` integer DEFAULT true NOT NULL,
	`cap_realtime` integer DEFAULT true NOT NULL,
	`guest_ai_enabled` integer DEFAULT false NOT NULL,
	`guest_ai_cap` real DEFAULT 0 NOT NULL,
	`api_key_hash` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`disabled_reason` text,
	`current_version_id` text,
	`cloned_from_canvas_id` text,
	`view_count` integer DEFAULT 0 NOT NULL,
	`last_viewed_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`org_id`) REFERENCES `orgs`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "canvases_status_chk" CHECK("__new_canvases"."status" in ('active', 'disabled', 'archived', 'deleted')),
	CONSTRAINT "canvases_access_chk" CHECK("__new_canvases"."access" in ('private', 'specific_people', 'team', 'whole_org', 'public_link'))
);
--> statement-breakpoint
INSERT INTO `__new_canvases`("id", "slug", "slug_custom", "title", "description", "owner_id", "access", "shared_expires_at", "gallery_listed", "gallery_templatable", "tags", "gallery_featured", "search_text", "gallery_published_at", "password_hash", "password_version", "spa_fallback", "preview_mode", "backend_enabled", "cap_kv", "cap_files", "cap_ai", "cap_realtime", "guest_ai_enabled", "guest_ai_cap", "api_key_hash", "status", "disabled_reason", "current_version_id", "cloned_from_canvas_id", "view_count", "last_viewed_at", "created_at", "updated_at", "deleted_at") SELECT "id", "slug", "slug_custom", "title", "description", "owner_id", "access", "shared_expires_at", "gallery_listed", "gallery_templatable", "tags", "gallery_featured", "search_text", "gallery_published_at", "password_hash", "password_version", "spa_fallback", "preview_mode", "backend_enabled", "cap_kv", "cap_files", "cap_ai", "cap_realtime", "guest_ai_enabled", "guest_ai_cap", "api_key_hash", "status", "disabled_reason", "current_version_id", "cloned_from_canvas_id", "view_count", "last_viewed_at", "created_at", "updated_at", "deleted_at" FROM `canvases`;--> statement-breakpoint
DROP TABLE `canvases`;--> statement-breakpoint
ALTER TABLE `__new_canvases` RENAME TO `canvases`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `canvases_slug_uq` ON `canvases` (`slug`);--> statement-breakpoint
CREATE INDEX `canvases_owner_created_idx` ON `canvases` (`owner_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `canvases_api_key_hash_uq` ON `canvases` (`api_key_hash`);--> statement-breakpoint
CREATE INDEX `canvases_status_deleted_idx` ON `canvases` (`status`,`deleted_at`);