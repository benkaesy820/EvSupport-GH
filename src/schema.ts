import { relations, sql } from "drizzle-orm";
import { check, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

const timestamps = {
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
};

export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(),
    role: text("role", { enum: ["admin", "agent", "customer"] }).notNull(),
    email: text("email").notNull(),
    passwordHash: text("password_hash").notNull(),
    displayName: text("display_name").notNull(),
    avatarFileId: text("avatar_file_id"),
    status: text("status", { enum: ["pending_approval", "active", "suspended", "anonymized"] }).notNull().default("active"),
    phone: text("phone"),
    timezone: text("timezone").notNull().default("UTC"),
    notificationPrefs: text("notification_prefs", { mode: "json" }).$type<Record<string, boolean>>().notNull().default({}),
    twoFactorEnabled: integer("two_factor_enabled", { mode: "boolean" }).notNull().default(false),
    lastActiveAt: text("last_active_at"),
    anonymizedAt: text("anonymized_at"),
    ...timestamps,
  },
  (t) => ({
    emailUnique: uniqueIndex("users_email_unique").on(t.email),
    roleStatusIdx: index("users_role_status_idx").on(t.role, t.status),
  }),
);

export const userSessions = sqliteTable(
  "user_sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id),
    refreshTokenHash: text("refresh_token_hash").notNull(),
    userAgent: text("user_agent"),
    ipHash: text("ip_hash"),
    expiresAt: text("expires_at").notNull(),
    revokedAt: text("revoked_at"),
    ...timestamps,
  },
  (t) => ({
    tokenUnique: uniqueIndex("user_sessions_refresh_token_unique").on(t.refreshTokenHash),
    userIdx: index("user_sessions_user_idx").on(t.userId, t.revokedAt),
  }),
);

export const passwordResetTokens = sqliteTable("password_reset_tokens", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: text("expires_at").notNull(),
  usedAt: text("used_at"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const twoFactorChallenges = sqliteTable(
  "two_factor_challenges",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id),
    purpose: text("purpose", { enum: ["login"] }).notNull(),
    codeHash: text("code_hash").notNull(),
    expiresAt: text("expires_at").notNull(),
    usedAt: text("used_at"),
    attempts: integer("attempts").notNull().default(0),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (t) => ({
    userPurposeIdx: index("two_factor_challenges_user_purpose_idx").on(t.userId, t.purpose, t.expiresAt),
  }),
);

export const customers = sqliteTable("customers", {
  userId: text("user_id").primaryKey().references(() => users.id),
  accountStatus: text("account_status", { enum: ["active", "suspended"] }).notNull().default("active"),
  tags: text("tags", { mode: "json" }).$type<string[]>().notNull().default([]),
  internalNotes: text("internal_notes"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const agents = sqliteTable("agents", {
  userId: text("user_id").primaryKey().references(() => users.id),
  availability: text("availability", { enum: ["available", "away", "offline"] }).notNull().default("available"),
  skills: text("skills", { mode: "json" }).$type<string[]>().notNull().default([]),
  capacity: integer("capacity").notNull().default(10),
  lastAssignedAt: text("last_assigned_at"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const supportChats = sqliteTable(
  "support_chats",
  {
    id: text("id").primaryKey(),
    customerId: text("customer_id").notNull().references(() => users.id),
    assignedAgentId: text("assigned_agent_id").references(() => users.id),
    status: text("status", { enum: ["open", "waiting", "resolved", "closed"] }).notNull().default("open"),
    priority: text("priority", { enum: ["normal", "high", "urgent"] }).notNull().default("normal"),
    category: text("category", {
      enum: ["account", "billing", "technical_support", "general_support", "complaint", "other"],
    }).notNull().default("general_support"),
    tags: text("tags", { mode: "json" }).$type<string[]>().notNull().default([]),
    supportCycle: integer("support_cycle").notNull().default(1),
    lastMessageId: text("last_message_id"),
    lastActivityAt: text("last_activity_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    closedAt: text("closed_at"),
    ...timestamps,
  },
  (t) => ({
    customerUnique: uniqueIndex("support_chats_customer_unique").on(t.customerId),
    queueIdx: index("support_chats_queue_idx").on(t.status, t.assignedAgentId, t.lastActivityAt),
    assignedIdx: index("support_chats_assigned_idx").on(t.assignedAgentId, t.status),
  }),
);

export const chatAssignments = sqliteTable(
  "chat_assignments",
  {
    id: text("id").primaryKey(),
    chatId: text("chat_id").notNull().references(() => supportChats.id),
    agentId: text("agent_id").notNull().references(() => users.id),
    assignedBy: text("assigned_by").notNull().references(() => users.id),
    reason: text("reason", { enum: ["claim", "admin_assign", "transfer", "admin_takeover", "suspended_agent"] }).notNull(),
    startedAt: text("started_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    endedAt: text("ended_at"),
  },
  (t) => ({
    chatIdx: index("chat_assignments_chat_idx").on(t.chatId, t.startedAt),
    agentIdx: index("chat_assignments_agent_idx").on(t.agentId, t.endedAt),
  }),
);

export const chatAdminParticipants = sqliteTable("chat_admin_participants", {
  id: text("id").primaryKey(),
  chatId: text("chat_id").notNull().references(() => supportChats.id),
  adminId: text("admin_id").notNull().references(() => users.id),
  mode: text("mode", { enum: ["join", "takeover"] }).notNull(),
  joinedAt: text("joined_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  leftAt: text("left_at"),
});

export const messages = sqliteTable(
  "messages",
  {
    id: text("id").primaryKey(),
    chatId: text("chat_id").notNull().references(() => supportChats.id),
    senderId: text("sender_id").references(() => users.id),
    kind: text("kind", { enum: ["text", "system"] }).notNull().default("text"),
    body: text("body"),
    visibleToCustomer: integer("visible_to_customer", { mode: "boolean" }).notNull().default(true),
    idempotencyKey: text("idempotency_key"),
    deletedAt: text("deleted_at"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (t) => ({
    chatCreatedIdx: index("messages_chat_created_idx").on(t.chatId, t.createdAt),
    idemUnique: uniqueIndex("messages_sender_idem_unique").on(t.senderId, t.idempotencyKey),
  }),
);

export const internalNotes = sqliteTable("internal_notes", {
  id: text("id").primaryKey(),
  chatId: text("chat_id").notNull().references(() => supportChats.id),
  authorId: text("author_id").notNull().references(() => users.id),
  body: text("body").notNull(),
  deletedAt: text("deleted_at"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const messageFiles = sqliteTable(
  "message_files",
  {
    messageId: text("message_id").notNull().references(() => messages.id),
    fileId: text("file_id").notNull().references(() => files.id),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.messageId, t.fileId] }),
  }),
);

export const messageReads = sqliteTable(
  "message_reads",
  {
    messageId: text("message_id").notNull().references(() => messages.id),
    userId: text("user_id").notNull().references(() => users.id),
    readAt: text("read_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (t) => ({
    pk: uniqueIndex("message_reads_unique").on(t.messageId, t.userId),
    userIdx: index("message_reads_user_idx").on(t.userId, t.readAt),
  }),
);

export const files = sqliteTable(
  "files",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id").notNull().references(() => users.id),
    resourceType: text("resource_type", { enum: ["chat", "report", "announcement", "team"] }),
    resourceId: text("resource_id"),
    storageKey: text("storage_key").notNull(),
    name: text("name").notNull(),
    mimeType: text("mime_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    status: text("status", { enum: ["pending", "ready", "failed", "expired"] }).notNull().default("pending"),
    checksum: text("checksum"),
    expiresAt: text("expires_at"),
    completedAt: text("completed_at"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (t) => ({
    resourceIdx: index("files_resource_idx").on(t.resourceType, t.resourceId),
    ownerIdx: index("files_owner_idx").on(t.ownerId),
  }),
);

export const announcements = sqliteTable(
  "announcements",
  {
    id: text("id").primaryKey(),
    authorId: text("author_id").notNull().references(() => users.id),
    title: text("title").notNull(),
    body: text("body").notNull(),
    status: text("status", { enum: ["draft", "scheduled", "published", "deleted"] }).notNull().default("draft"),
    targetType: text("target_type", { enum: ["all_customers", "customer_tag", "category"] }).notNull().default("all_customers"),
    scheduledFor: text("scheduled_for"),
    publishedAt: text("published_at"),
    deletedAt: text("deleted_at"),
    ...timestamps,
  },
  (t) => ({
    statusIdx: index("announcements_status_idx").on(t.status, t.publishedAt),
    scheduleIdx: index("announcements_schedule_idx").on(t.status, t.scheduledFor),
  }),
);

export const announcementTargets = sqliteTable(
  "announcement_targets",
  {
    announcementId: text("announcement_id").notNull().references(() => announcements.id),
    targetValue: text("target_value").notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.announcementId, t.targetValue] }),
  }),
);

export const announcementComments = sqliteTable("announcement_comments", {
  id: text("id").primaryKey(),
  announcementId: text("announcement_id").notNull().references(() => announcements.id),
  authorId: text("author_id").notNull().references(() => users.id),
  body: text("body").notNull(),
  deletedAt: text("deleted_at"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const announcementFiles = sqliteTable(
  "announcement_files",
  {
    announcementId: text("announcement_id").notNull().references(() => announcements.id),
    fileId: text("file_id").notNull().references(() => files.id),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.announcementId, t.fileId] }),
  }),
);

export const announcementReactions = sqliteTable(
  "announcement_reactions",
  {
    announcementId: text("announcement_id").notNull().references(() => announcements.id),
    userId: text("user_id").notNull().references(() => users.id),
    emoji: text("emoji").notNull(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (t) => ({
    uniqueReaction: uniqueIndex("announcement_reactions_unique").on(t.announcementId, t.userId, t.emoji),
  }),
);

export const reports = sqliteTable(
  "reports",
  {
    id: text("id").primaryKey(),
    customerId: text("customer_id").notNull().references(() => users.id),
    title: text("title").notNull(),
    category: text("category", { enum: ["bug", "complaint", "account_issue", "support_issue", "general_feedback", "other"] }).notNull(),
    description: text("description").notNull(),
    status: text("status", { enum: ["pending", "reviewed", "resolved", "dismissed"] }).notNull().default("pending"),
    adminNotes: text("admin_notes"),
    evidenceSnapshot: text("evidence_snapshot", { mode: "json" }).$type<unknown[]>(),
    idempotencyKey: text("idempotency_key"),
    ...timestamps,
  },
  (t) => ({
    customerIdemUnique: uniqueIndex("reports_customer_idem_unique").on(t.customerId, t.idempotencyKey),
    statusIdx: index("reports_status_idx").on(t.status, t.createdAt),
  }),
);

export const reportFiles = sqliteTable(
  "report_files",
  {
    reportId: text("report_id").notNull().references(() => reports.id),
    fileId: text("file_id").notNull().references(() => files.id),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.reportId, t.fileId] }),
  }),
);

export const reportInternalComments = sqliteTable("report_internal_comments", {
  id: text("id").primaryKey(),
  reportId: text("report_id").notNull().references(() => reports.id),
  authorId: text("author_id").notNull().references(() => users.id),
  body: text("body").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const ratings = sqliteTable(
  "ratings",
  {
    id: text("id").primaryKey(),
    chatId: text("chat_id").notNull().references(() => supportChats.id),
    supportCycle: integer("support_cycle").notNull(),
    customerId: text("customer_id").notNull().references(() => users.id),
    agentId: text("agent_id").references(() => users.id),
    stars: integer("stars").notNull(),
    comment: text("comment"),
    idempotencyKey: text("idempotency_key"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (t) => ({
    uniqueCycle: uniqueIndex("ratings_chat_cycle_customer_unique").on(t.chatId, t.supportCycle, t.customerId),
    starsCheck: check("ratings_stars_check", sql`${t.stars} >= 1 AND ${t.stars} <= 5`),
  }),
);

export const notifications = sqliteTable(
  "notifications",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id),
    type: text("type").notNull(),
    resourceType: text("resource_type").notNull(),
    resourceId: text("resource_id").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    dedupeKey: text("dedupe_key"),
    emailStatus: text("email_status", { enum: ["none", "pending", "sent", "failed", "throttled"] }).notNull().default("none"),
    readAt: text("read_at"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (t) => ({
    userUnreadIdx: index("notifications_user_unread_idx").on(t.userId, t.readAt, t.createdAt),
    dedupeUnique: uniqueIndex("notifications_dedupe_unique").on(t.userId, t.dedupeKey),
  }),
);

export const teamMessages = sqliteTable(
  "team_messages",
  {
    id: text("id").primaryKey(),
    senderId: text("sender_id").notNull().references(() => users.id),
    body: text("body").notNull(),
    idempotencyKey: text("idempotency_key"),
    deletedAt: text("deleted_at"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (t) => ({
    createdIdx: index("team_messages_created_idx").on(t.createdAt),
    idemUnique: uniqueIndex("team_messages_sender_idem_unique").on(t.senderId, t.idempotencyKey),
  }),
);

export const teamMessageFiles = sqliteTable(
  "team_message_files",
  {
    messageId: text("message_id").notNull().references(() => teamMessages.id),
    fileId: text("file_id").notNull().references(() => files.id),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.messageId, t.fileId] }),
  }),
);

export const teamMessageReads = sqliteTable(
  "team_message_reads",
  {
    messageId: text("message_id").notNull().references(() => teamMessages.id),
    userId: text("user_id").notNull().references(() => users.id),
    readAt: text("read_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.messageId, t.userId] }),
  }),
);

export const auditLogs = sqliteTable(
  "audit_logs",
  {
    id: text("id").primaryKey(),
    actorId: text("actor_id").references(() => users.id),
    action: text("action").notNull(),
    resourceType: text("resource_type").notNull(),
    resourceId: text("resource_id").notNull(),
    metadata: text("metadata", { mode: "json" }).$type<Record<string, unknown>>().notNull().default({}),
    ipHash: text("ip_hash"),
    requestId: text("request_id"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (t) => ({
    resourceIdx: index("audit_logs_resource_idx").on(t.resourceType, t.resourceId),
    actionIdx: index("audit_logs_action_idx").on(t.action, t.createdAt),
  }),
);

export const systemSettings = sqliteTable("system_settings", {
  key: text("key").primaryKey(),
  value: text("value", { mode: "json" }).$type<unknown>().notNull(),
  updatedBy: text("updated_by").references(() => users.id),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const idempotencyKeys = sqliteTable(
  "idempotency_keys",
  {
    scope: text("scope").notNull(),
    key: text("key").notNull(),
    actorId: text("actor_id").notNull().references(() => users.id),
    requestHash: text("request_hash").notNull(),
    responseJson: text("response_json", { mode: "json" }).$type<unknown>(),
    status: text("status", { enum: ["in_progress", "completed", "failed"] }).notNull(),
    expiresAt: text("expires_at").notNull(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.scope, t.key, t.actorId] }),
    expiresIdx: index("idempotency_keys_expires_idx").on(t.expiresAt),
  }),
);

export const rateLimitCounters = sqliteTable(
  "rate_limit_counters",
  {
    scope: text("scope").notNull(),
    key: text("key").notNull(),
    windowStart: text("window_start").notNull(),
    count: integer("count").notNull().default(0),
    expiresAt: text("expires_at").notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.scope, t.key, t.windowStart] }),
    expiresIdx: index("rate_limit_counters_expires_idx").on(t.expiresAt),
  }),
);

export const outboxEvents = sqliteTable(
  "outbox_events",
  {
    id: text("id").primaryKey(),
    event: text("event").notNull(),
    channels: text("channels").notNull(),
    payload: text("payload").notNull(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (t) => ({
    createdIdx: index("outbox_events_created_idx").on(t.createdAt),
  }),
);

export const usersRelations = relations(users, ({ one }) => ({
  customer: one(customers, { fields: [users.id], references: [customers.userId] }),
  agent: one(agents, { fields: [users.id], references: [agents.userId] }),
}));

export const supportChatsRelations = relations(supportChats, ({ one, many }) => ({
  customer: one(users, { fields: [supportChats.customerId], references: [users.id] }),
  assignedAgent: one(users, { fields: [supportChats.assignedAgentId], references: [users.id] }),
  messages: many(messages),
  assignments: many(chatAssignments),
}));
