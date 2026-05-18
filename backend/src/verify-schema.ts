import { libsql } from "./db.js";

const requiredTables = [
  "users",
  "user_sessions",
  "password_reset_tokens",
  "two_factor_challenges",
  "customers",
  "agents",
  "support_chats",
  "chat_assignments",
  "chat_admin_participants",
  "messages",
  "internal_notes",
  "message_files",
  "message_reads",
  "files",
  "announcements",
  "announcement_targets",
  "announcement_comments",
  "announcement_files",
  "announcement_reactions",
  "reports",
  "report_files",
  "report_internal_comments",
  "ratings",
  "notifications",
  "team_messages",
  "team_message_files",
  "team_message_reads",
  "audit_logs",
  "system_settings",
  "idempotency_keys",
  "rate_limit_counters",
  "__drizzle_migrations",
];

const requiredIndexes = [
  "users_email_unique",
  "support_chats_customer_unique",
  "support_chats_queue_idx",
  "messages_chat_created_idx",
  "message_reads_unique",
  "files_resource_idx",
  "announcements_status_idx",
  "announcements_schedule_idx",
  "announcement_reactions_unique",
  "reports_customer_idem_unique",
  "ratings_chat_cycle_customer_unique",
  "notifications_user_unread_idx",
  "team_messages_created_idx",
  "audit_logs_resource_idx",
  "idempotency_keys_expires_idx",
];

async function names(type: "table" | "index") {
  const result = await libsql.execute({
    sql: "select name from sqlite_master where type = ?",
    args: [type],
  });
  return new Set(result.rows.map((row) => String(row.name)));
}

const tables = await names("table");
const indexes = await names("index");
const missingTables = requiredTables.filter((table) => !tables.has(table));
const missingIndexes = requiredIndexes.filter((index) => !indexes.has(index));

if (missingTables.length || missingIndexes.length) {
  console.error(JSON.stringify({ ok: false, missingTables, missingIndexes }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({ ok: true, tables: requiredTables.length, indexes: requiredIndexes.length }, null, 2));
