PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_canvas_allowlist` (
	`id` text PRIMARY KEY NOT NULL,
	`canvas_id` text NOT NULL,
	`principal_kind` text NOT NULL,
	`user_id` text,
	`email` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`canvas_id`) REFERENCES `canvases`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "canvas_allowlist_kind_chk" CHECK("__new_canvas_allowlist"."principal_kind" in ('member', 'guest')),
	CONSTRAINT "canvas_allowlist_member_chk" CHECK("__new_canvas_allowlist"."principal_kind" != 'member' OR "__new_canvas_allowlist"."user_id" IS NOT NULL),
	CONSTRAINT "canvas_allowlist_guest_chk" CHECK("__new_canvas_allowlist"."principal_kind" != 'guest' OR "__new_canvas_allowlist"."email" IS NOT NULL)
);
--> statement-breakpoint
INSERT INTO `__new_canvas_allowlist`("id", "canvas_id", "principal_kind", "user_id", "email", "created_at") SELECT "id", "canvas_id", "principal_kind", "user_id", "email", "created_at" FROM `canvas_allowlist`;--> statement-breakpoint
DROP TABLE `canvas_allowlist`;--> statement-breakpoint
ALTER TABLE `__new_canvas_allowlist` RENAME TO `canvas_allowlist`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `canvas_allowlist_canvas_idx` ON `canvas_allowlist` (`canvas_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `canvas_allowlist_canvas_user_uq` ON `canvas_allowlist` (`canvas_id`,`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `canvas_allowlist_canvas_email_uq` ON `canvas_allowlist` (`canvas_id`,`email`);