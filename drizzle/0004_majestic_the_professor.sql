CREATE TABLE `outbox_events` (
	`id` text PRIMARY KEY NOT NULL,
	`event` text NOT NULL,
	`channels` text NOT NULL,
	`payload` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `outbox_events_created_idx` ON `outbox_events` (`created_at`);