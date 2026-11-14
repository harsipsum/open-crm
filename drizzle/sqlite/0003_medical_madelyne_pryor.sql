CREATE TABLE `pipeline` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`name` text NOT NULL,
	`position` integer NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pipeline_organization_name_uidx` ON `pipeline` (`organization_id`,lower("name"));--> statement-breakpoint
CREATE TABLE `pipeline_stage` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`pipeline_id` text NOT NULL,
	`name` text NOT NULL,
	`kind` text DEFAULT 'OPEN' NOT NULL,
	`position` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`pipeline_id`) REFERENCES `pipeline`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pipeline_stage_pipeline_name_uidx` ON `pipeline_stage` (`pipeline_id`,lower("name"));--> statement-breakpoint
CREATE INDEX `pipeline_stage_organization_idx` ON `pipeline_stage` (`organization_id`);--> statement-breakpoint
ALTER TABLE `deal` ADD `pipeline_id` text REFERENCES pipeline(id) ON DELETE set null;--> statement-breakpoint
ALTER TABLE `deal` ADD `pipeline_stage_id` text REFERENCES pipeline_stage(id) ON DELETE set null;--> statement-breakpoint
CREATE INDEX `deal_pipeline_idx` ON `deal` (`pipeline_id`);--> statement-breakpoint
CREATE INDEX `deal_pipeline_stage_idx` ON `deal` (`pipeline_stage_id`);