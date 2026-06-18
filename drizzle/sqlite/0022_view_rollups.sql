ALTER TABLE `canvases` ADD `view_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `canvases` ADD `last_viewed_at` integer;