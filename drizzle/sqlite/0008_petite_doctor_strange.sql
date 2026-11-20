CREATE TABLE `company_tech` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`company_id` text NOT NULL,
	`product` text NOT NULL,
	`product_key` text NOT NULL,
	`category` text,
	`origin` text NOT NULL,
	`verified` integer DEFAULT false NOT NULL,
	`source` text,
	`observed_at` text,
	`entered_by_id` text,
	`confirmed_by_id` text,
	`confirmed_at` text,
	`archived_by_id` text,
	`archived_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`company_id`) REFERENCES `company`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`entered_by_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`confirmed_by_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`archived_by_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `company_tech_live_product_uidx` ON `company_tech` (`organization_id`,`company_id`,`product_key`) WHERE "company_tech"."archived_at" is null;--> statement-breakpoint
CREATE INDEX `company_tech_company_idx` ON `company_tech` (`company_id`);--> statement-breakpoint
CREATE INDEX `company_tech_entered_by_idx` ON `company_tech` (`entered_by_id`);--> statement-breakpoint
CREATE INDEX `company_tech_confirmed_by_idx` ON `company_tech` (`confirmed_by_id`);--> statement-breakpoint
CREATE INDEX `company_tech_archived_by_idx` ON `company_tech` (`archived_by_id`);