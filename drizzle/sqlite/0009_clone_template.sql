ALTER TABLE `canvases` ADD `gallery_templatable` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `canvases` ADD `cloned_from_canvas_id` text;