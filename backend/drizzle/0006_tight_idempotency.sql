UPDATE `chat_assignments`
SET `ended_at` = CURRENT_TIMESTAMP
WHERE `ended_at` IS NULL
  AND rowid NOT IN (
    SELECT rowid FROM (
      SELECT rowid, row_number() OVER (PARTITION BY `chat_id` ORDER BY `started_at` DESC, rowid DESC) AS rn
      FROM `chat_assignments`
      WHERE `ended_at` IS NULL
    )
    WHERE rn = 1
  );--> statement-breakpoint
CREATE UNIQUE INDEX `chat_assignments_open_chat_unique` ON `chat_assignments` (`chat_id`) WHERE `ended_at` is null;--> statement-breakpoint
CREATE UNIQUE INDEX `ratings_customer_idem_unique` ON `ratings` (`customer_id`,`idempotency_key`);
