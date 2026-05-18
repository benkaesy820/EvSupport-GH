CREATE TABLE `rate_limit_counters` (
	`scope` text NOT NULL,
	`key` text NOT NULL,
	`window_start` text NOT NULL,
	`count` integer DEFAULT 0 NOT NULL,
	`expires_at` text NOT NULL,
	PRIMARY KEY(`scope`, `key`, `window_start`)
);
--> statement-breakpoint
CREATE INDEX `rate_limit_counters_expires_idx` ON `rate_limit_counters` (`expires_at`);