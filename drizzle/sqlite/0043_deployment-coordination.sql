ALTER TABLE `canvases` ADD `publication_token` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `upload_sessions` ADD `release_id` text;--> statement-breakpoint
ALTER TABLE `upload_sessions` ADD `expected_publication_token` text;--> statement-breakpoint
ALTER TABLE `versions` ADD `release_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `versions_canvas_release_ready_uq` ON `versions` (`canvas_id`,`release_id`) WHERE "versions"."status" = 'ready' and "versions"."release_id" is not null;--> statement-breakpoint
UPDATE `canvases` SET `publication_token` = lower(hex(randomblob(16))) WHERE `publication_token` = '';
