ALTER TABLE `canvases` ADD `backend_enabled` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `canvases` ADD `cap_kv` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `canvases` ADD `cap_files` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `canvases` ADD `cap_ai` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `canvases` ADD `cap_realtime` integer DEFAULT true NOT NULL;