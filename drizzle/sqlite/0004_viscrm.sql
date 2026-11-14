CREATE TABLE `asana_handoff` (
	`deal_id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`project_gid` text NOT NULL,
	`task_gid` text,
	`task_url` text,
	`error` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`deal_id`) REFERENCES `deal`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `conversion_event` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`deal_id` text NOT NULL,
	`platform` text NOT NULL,
	`event` text NOT NULL,
	`stage_name` text NOT NULL,
	`value` real,
	`currency` text,
	`click_id` text,
	`status` text NOT NULL,
	`payload` text NOT NULL,
	`response` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`deal_id`) REFERENCES `deal`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `conversion_event_deal_platform_event_uidx` ON `conversion_event` (`deal_id`,`platform`,`event`);--> statement-breakpoint
CREATE TABLE `deal_attribution` (
	`deal_id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`contact_id` text,
	`source` text NOT NULL,
	`campaign` text,
	`creative_id` text,
	`first_touch_at` text NOT NULL,
	`landing_url` text,
	`utm_source` text,
	`utm_medium` text,
	`gclid` text,
	`fbclid` text,
	`ctwa_clid` text,
	`li_fat_id` text,
	`consent` text DEFAULT 'UNKNOWN' NOT NULL,
	`consent_at` text,
	`product` text,
	`order_type` text DEFAULT 'NEW' NOT NULL,
	`country` text,
	`headcount` integer,
	`role` text,
	`erp` text,
	`timeline_months` integer,
	`users` integer,
	`fit_score` integer NOT NULL,
	`fit_reasons` text NOT NULL,
	`created_by_app` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`deal_id`) REFERENCES `deal`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`contact_id`) REFERENCES `contact`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `deal_attribution_organization_source_idx` ON `deal_attribution` (`organization_id`,`source`);--> statement-breakpoint
CREATE TABLE `deal_order` (
	`deal_id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`license_revenue` real,
	`implementation_value` real,
	`implementation_required` integer,
	`asana_license_type` text,
	`users` integer,
	`freshworks_products` text,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`deal_id`) REFERENCES `deal`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `deal_research` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`deal_id` text NOT NULL,
	`kind` text NOT NULL,
	`status` text DEFAULT 'PENDING' NOT NULL,
	`provider` text,
	`tool` text,
	`cost_usd` real DEFAULT 0 NOT NULL,
	`summary` text,
	`data` text,
	`error` text,
	`filled_by_app` text,
	`requested_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`completed_at` text,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`deal_id`) REFERENCES `deal`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `deal_research_deal_kind_uidx` ON `deal_research` (`deal_id`,`kind`);--> statement-breakpoint
CREATE INDEX `deal_research_organization_status_idx` ON `deal_research` (`organization_id`,`status`);--> statement-breakpoint
CREATE TABLE `sdr_timer` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`deal_id` text NOT NULL,
	`task_activity_id` text,
	`owner_id` text,
	`due_at` text NOT NULL,
	`escalate_at` text NOT NULL,
	`status` text DEFAULT 'OPEN' NOT NULL,
	`done_at` text,
	`escalated_at` text,
	`escalated_to_id` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`deal_id`) REFERENCES `deal`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`task_activity_id`) REFERENCES `activity`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`owner_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`escalated_to_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sdr_timer_deal_uidx` ON `sdr_timer` (`deal_id`);--> statement-breakpoint
CREATE INDEX `sdr_timer_organization_status_escalate_idx` ON `sdr_timer` (`organization_id`,`status`,`escalate_at`);--> statement-breakpoint
CREATE TABLE `vis_app_key` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`app` text NOT NULL,
	`label` text NOT NULL,
	`key_hash` text NOT NULL,
	`key_prefix` text NOT NULL,
	`created_by_id` text,
	`last_used_at` text,
	`revoked_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `vis_app_key_hash_uidx` ON `vis_app_key` (`key_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `vis_app_key_organization_app_live_uidx` ON `vis_app_key` (`organization_id`,`app`) WHERE "vis_app_key"."revoked_at" is null;