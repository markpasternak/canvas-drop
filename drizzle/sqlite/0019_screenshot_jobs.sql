CREATE TABLE `screenshot_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`canvas_id` text NOT NULL,
	`version_id` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`leased_at` integer,
	`last_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`canvas_id`) REFERENCES `canvases`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "screenshot_jobs_status_chk" CHECK("screenshot_jobs"."status" in ('pending', 'running', 'done', 'failed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `screenshot_jobs_canvas_uq` ON `screenshot_jobs` (`canvas_id`);--> statement-breakpoint
CREATE INDEX `screenshot_jobs_status_leased_idx` ON `screenshot_jobs` (`status`,`leased_at`);--> statement-breakpoint
CREATE INDEX `screenshot_jobs_status_updated_idx` ON `screenshot_jobs` (`status`,`updated_at`);