CREATE TABLE `guest_invites` (
	`id` text PRIMARY KEY NOT NULL,
	`canvas_id` text NOT NULL,
	`email` text NOT NULL,
	`token_hash` text NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`expires_at` integer,
	`consumed_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`canvas_id`) REFERENCES `canvases`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "guest_invites_state_chk" CHECK("guest_invites"."state" in ('pending', 'active', 'revoked'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `guest_invites_token_hash_uq` ON `guest_invites` (`token_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `guest_invites_canvas_email_uq` ON `guest_invites` (`canvas_id`,`email`);--> statement-breakpoint
CREATE TABLE `guest_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`invite_id` text NOT NULL,
	`canvas_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`expires_at` integer NOT NULL,
	`revoked_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`invite_id`) REFERENCES `guest_invites`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`canvas_id`) REFERENCES `canvases`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `guest_sessions_token_hash_uq` ON `guest_sessions` (`token_hash`);--> statement-breakpoint
CREATE INDEX `guest_sessions_invite_idx` ON `guest_sessions` (`invite_id`);