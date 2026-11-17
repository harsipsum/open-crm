CREATE TABLE `audit_log` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`actor_id` text,
	`actor_kind` text NOT NULL,
	`action` text NOT NULL,
	`record_id` text,
	`detail` text,
	`outcome` text NOT NULL,
	`at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `audit_log_org_at_idx` ON `audit_log` (`organization_id`,`at`);--> statement-breakpoint
CREATE INDEX `audit_log_org_record_idx` ON `audit_log` (`organization_id`,`record_id`);--> statement-breakpoint
CREATE TABLE `crm_role` (
	`organization_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text DEFAULT 'seller' NOT NULL,
	`manager_id` text,
	`left_at` text,
	`updated_by_id` text,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	PRIMARY KEY(`organization_id`, `user_id`),
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade
);
