CREATE TABLE `asana_won_queue` (
	`deal_id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`deal_id`) REFERENCES `deal`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `hubspot_association` (
	`organization_id` text NOT NULL,
	`portal_id` text NOT NULL,
	`from_type` text NOT NULL,
	`from_id` text NOT NULL,
	`to_type` text NOT NULL,
	`to_id` text NOT NULL,
	`type_id` text NOT NULL,
	`category` text NOT NULL,
	`label` text,
	PRIMARY KEY(`organization_id`, `portal_id`, `from_type`, `from_id`, `to_type`, `to_id`, `category`, `type_id`),
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `hubspot_object` (
	`organization_id` text NOT NULL,
	`portal_id` text NOT NULL,
	`object_type` text NOT NULL,
	`source_id` text NOT NULL,
	`target_id` text NOT NULL,
	`data` text NOT NULL,
	`imported_at` text NOT NULL,
	PRIMARY KEY(`organization_id`, `portal_id`, `object_type`, `source_id`),
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `hubspot_target_idx` ON `hubspot_object` (`organization_id`,`target_id`);