ALTER TABLE `canvases` ADD `tags` text;--> statement-breakpoint
ALTER TABLE `canvases` ADD `gallery_featured` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `canvases` ADD `search_text` text;--> statement-breakpoint
ALTER TABLE `canvases` DROP COLUMN `gallery_tags`;