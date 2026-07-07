ALTER TABLE `ai_usage` ADD `cache_creation_input_tokens` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `ai_usage` ADD `cache_read_input_tokens` integer DEFAULT 0 NOT NULL;