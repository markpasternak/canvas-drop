ALTER TABLE `canvases` ADD `ai_audience` text DEFAULT 'editors' NOT NULL;--> statement-breakpoint
ALTER TABLE `canvases` ADD `connections_audience` text DEFAULT 'editors' NOT NULL;--> statement-breakpoint
ALTER TABLE `files` ADD `scope` text DEFAULT 'shared' NOT NULL;