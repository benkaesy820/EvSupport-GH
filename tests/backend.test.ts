import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { createClient } from "@libsql/client";

const testDbPath = resolve("test.sqlite");
if (existsSync(testDbPath)) rmSync(testDbPath);

process.env.NODE_ENV = "test";
process.env.DATABASE_URL = `file:${testDbPath}`;
process.env.JWT_ACCESS_SECRET = "test-access-secret-test-access-secret";
process.env.JWT_REFRESH_SECRET = "test-refresh-secret-test-refresh-secret";
process.env.R2_ACCOUNT_ID = "test";
process.env.R2_ACCESS_KEY_ID = "test";
process.env.R2_SECRET_ACCESS_KEY = "test";
process.env.R2_BUCKET = "test";

const client = createClient({ url: process.env.DATABASE_URL });
const migrations = readdirSync(resolve("drizzle"))
  .filter((file) => file.endsWith(".sql"))
  .sort();

for (const file of migrations) {
  const sql = readFileSync(resolve("drizzle", file), "utf8");
  for (const statement of sql.split("--> statement-breakpoint").map((part) => part.trim()).filter(Boolean)) {
    await client.execute(statement);
  }
}

const { hash } = await import("@node-rs/argon2");
const { and, eq, isNull } = await import("drizzle-orm");
const { createApp } = await import("../src/app.js");
const { db } = await import("../src/db.js");
const schema = await import("../src/schema.js");

const app = createApp();
let ipCounter = 1;

type ApiClient = {
  token?: string;
  request: <T>(method: string, path: string, body?: unknown, expected?: number) => Promise<T>;
};

async function apiRequest<T>(method: string, path: string, body?: unknown, expected = 200, token?: string) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-forwarded-for": `127.20.0.${ipCounter++}`,
  };
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await app.request(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  assert.equal(response.status, expected, `${method} ${path} expected ${expected}, got ${response.status}: ${text}`);
  return data as T;
}

function createApiClient(token?: string): ApiClient {
  return {
    token,
    request<T>(method: string, path: string, body?: unknown, expected = 200) {
      return apiRequest<T>(method, path, body, expected, token);
    },
  };
}

async function createSeedUser(role: "admin" | "agent" | "customer", suffix: string, password = `Password-${suffix}-123!`) {
  const id = randomUUID();
  await db.insert(schema.users).values({
    id,
    role,
    email: `${role}-${suffix}@evcomm.test`,
    passwordHash: await hash(password),
    displayName: `${role} ${suffix}`,
    twoFactorEnabled: role === "admin",
  });
  if (role === "customer") await db.insert(schema.customers).values({ userId: id, tags: suffix.includes("vip") ? ["vip"] : [] });
  if (role === "agent") await db.insert(schema.agents).values({ userId: id, skills: ["general_support"] });
  return { id, role, email: `${role}-${suffix}@evcomm.test`, password };
}

async function login(email: string, password: string) {
  const loginResult = await apiRequest<{ requiresTwoFactor?: boolean; challengeId?: string; debugCode?: string; session?: { accessToken: string } }>("POST", "/auth/login", { email, password });
  if (loginResult.requiresTwoFactor) {
    assert.ok(loginResult.challengeId);
    assert.ok(loginResult.debugCode);
    const verified = await apiRequest<{ session: { accessToken: string } }>("POST", "/auth/2fa/verify", { challengeId: loginResult.challengeId, code: loginResult.debugCode });
    return createApiClient(verified.session.accessToken);
  }
  assert.ok(loginResult.session?.accessToken);
  return createApiClient(loginResult.session.accessToken);
}

async function createUser(admin: ApiClient, role: "agent" | "customer", suffix: string) {
  const password = `Created-${suffix}-Password-123!`;
  const result = await admin.request<{ user: { id: string; email: string } }>("POST", "/admin/users", {
    role,
    email: `${role}-${suffix}@evcomm.test`,
    password,
    displayName: `${role} ${suffix}`,
    skills: role === "agent" ? ["general_support"] : undefined,
  }, 201);
  return { id: result.user.id, email: result.user.email, password };
}

async function createReadyFile(ownerId: string, resourceType?: "chat" | "report" | "announcement" | "team", resourceId?: string) {
  const id = randomUUID();
  await db.insert(schema.files).values({
    id,
    ownerId,
    resourceType,
    resourceId,
    storageKey: `${ownerId}/${id}/test.png`,
    name: "test.png",
    mimeType: "image/png",
    sizeBytes: 128,
    status: "ready",
    completedAt: new Date().toISOString(),
  });
  return id;
}

const adminSeed = await createSeedUser("admin", "root");
const admin = await login(adminSeed.email, adminSeed.password);

test("health and error shape are stable", async () => {
  assert.deepEqual(await apiRequest("GET", "/health"), { ok: true });
  const response = await app.request("/me");
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), {
    error: "UNAUTHORIZED",
    message: "Authentication is required.",
    details: {},
  });
});

test("auth sessions, suspension, reset, and force logout are enforced", async () => {
  const customer = await createUser(admin, "customer", "auth");
  const customerClient = await login(customer.email, customer.password);
  const me = await customerClient.request<{ user: { email: string }; counts: { notificationsUnread: number; teamUnread: number } }>("GET", "/me");
  assert.equal(me.user.email, customer.email);
  assert.equal(me.counts.teamUnread, 0);

  const sessions = await customerClient.request<{ items: Array<{ id: string; current: boolean }> }>("GET", "/sessions");
  assert.ok(sessions.items.some((session) => session.current));
  await customerClient.request("DELETE", `/sessions/${sessions.items[0].id}`);

  const reset = await apiRequest<{ debugToken?: string }>("POST", "/auth/password-reset/request", { email: customer.email });
  assert.ok(reset.debugToken);
  const resetPassword = `Reset-${randomUUID()}-123!`;
  await apiRequest("POST", "/auth/password-reset/confirm", { token: reset.debugToken, password: resetPassword });

  const forceLogoutEvents = await db.select().from(schema.outboxEvents).where(eq(schema.outboxEvents.event, "force:logout"));
  assert.ok(forceLogoutEvents.length >= 1);

  await admin.request("PATCH", `/admin/users/${customer.id}`, { status: "suspended" });
  await apiRequest("POST", "/auth/login", { email: customer.email, password: resetPassword }, 403);
});

test("chat permissions, state transitions, unread counts, notes, and idempotency work", async () => {
  const agent = await createUser(admin, "agent", "chat");
  const customer = await createUser(admin, "customer", "chat");
  const agentClient = await login(agent.email, agent.password);
  const customerClient = await login(customer.email, customer.password);

  const current = await customerClient.request<{ chat: { id: string; status: string; availableActions: Record<string, boolean> } }>("POST", "/chats/current");
  assert.equal(current.chat.status, "open");
  assert.equal(current.chat.availableActions.send_message, true);

  const first = await customerClient.request<{ message: { id: string } }>("POST", `/chats/${current.chat.id}/messages`, {
    body: "Need support",
    idempotencyKey: "chat-message-idem-1",
  }, 201);
  const replay = await customerClient.request<{ message: { id: string } }>("POST", `/chats/${current.chat.id}/messages`, {
    body: "Need support",
    idempotencyKey: "chat-message-idem-1",
  });
  assert.equal(first.message.id, replay.message.id);
  await customerClient.request("POST", `/chats/${current.chat.id}/messages`, { body: "Different", idempotencyKey: "chat-message-idem-1" }, 409);

  const claimed = await agentClient.request<{ chat: { assignedAgent: { id: string } } }>("POST", `/chats/${current.chat.id}/claim`);
  assert.equal(claimed.chat.assignedAgent.id, agent.id);
  await agentClient.request("POST", `/chats/${current.chat.id}/internal-notes`, { body: "Support-only note" }, 201);
  const customerDetail = await customerClient.request<{ internalNotes: unknown[]; messages: unknown[]; nextMessageCursor: string | null }>("GET", `/chats/${current.chat.id}?limit=1`);
  assert.equal(customerDetail.internalNotes.length, 0);
  assert.equal(customerDetail.messages.length, 1);
  assert.ok("nextMessageCursor" in customerDetail);

  await agentClient.request("POST", `/chats/${current.chat.id}/status`, { status: "resolved" });
  const reopened = await customerClient.request<{ chat: { status: string; supportCycle: number } }>("POST", `/chats/${current.chat.id}/messages`, { body: "Still broken", idempotencyKey: "chat-reopen-idem" }, 201);
  assert.equal(reopened.chat.status, "open");
  assert.equal(reopened.chat.supportCycle, 2);

  await admin.request("POST", `/chats/${current.chat.id}/status`, { status: "closed" });
  await customerClient.request("POST", `/chats/${current.chat.id}/messages`, { body: "closed denial" }, 409);
});

test("assignment, atomic claim conflict, admin transfer, takeover, and suspended-agent unassignment work", async () => {
  const agentA = await createUser(admin, "agent", "assign-a");
  const agentB = await createUser(admin, "agent", "assign-b");
  const customer = await createUser(admin, "customer", "assign");
  const agentAClient = await login(agentA.email, agentA.password);
  const agentBClient = await login(agentB.email, agentB.password);
  const customerClient = await login(customer.email, customer.password);
  const { chat } = await customerClient.request<{ chat: { id: string } }>("POST", "/chats/current");

  await agentAClient.request("POST", `/chats/${chat.id}/claim`);
  await agentBClient.request("POST", `/chats/${chat.id}/claim`, undefined, 409);
  await admin.request("POST", `/chats/${chat.id}/transfer`, { agentId: agentB.id });
  await admin.request("POST", `/chats/${chat.id}/takeover`, { mode: "takeover" });

  await admin.request("PATCH", `/admin/users/${agentB.id}`, { status: "suspended" });
  const [updated] = await db.select().from(schema.supportChats).where(eq(schema.supportChats.id, chat.id));
  assert.equal(updated.assignedAgentId, null);

  const assignments = await db.select().from(schema.chatAssignments).where(eq(schema.chatAssignments.chatId, chat.id));
  assert.ok(assignments.length >= 2);
});

test("file access follows parent resources and owner attachment rules", async () => {
  const agent = await createUser(admin, "agent", "file-agent");
  const customerA = await createUser(admin, "customer", "file-a");
  const customerB = await createUser(admin, "customer", "file-b");
  const agentClient = await login(agent.email, agent.password);
  const customerAClient = await login(customerA.email, customerA.password);
  const customerBClient = await login(customerB.email, customerB.password);
  const { chat } = await customerAClient.request<{ chat: { id: string } }>("POST", "/chats/current");
  await agentClient.request("POST", `/chats/${chat.id}/claim`);

  const fileId = await createReadyFile(customerA.id);
  await customerAClient.request("POST", `/chats/${chat.id}/messages`, { body: "file", fileIds: [fileId], idempotencyKey: "file-chat-idem" }, 201);
  await customerBClient.request("GET", `/files/${fileId}/download`, undefined, 403);

  const otherFile = await createReadyFile(customerB.id);
  await customerAClient.request("POST", `/chats/${chat.id}/messages`, { body: "bad file", fileIds: [otherFile] }, 403);
});

test("announcements enforce schedule, targeting, reactions, comments, and counts", async () => {
  const vip = await createUser(admin, "customer", "vip-target");
  const regular = await createUser(admin, "customer", "regular-target");
  await db.update(schema.customers).set({ tags: ["vip"] }).where(eq(schema.customers.userId, vip.id));
  const vipClient = await login(vip.email, vip.password);
  const regularClient = await login(regular.email, regular.password);

  const announcement = await admin.request<{ announcement: { id: string } }>("POST", "/announcements", {
    title: "VIP only",
    body: "targeted",
    targetType: "customer_tag",
    targetValues: ["vip"],
  }, 201);
  await admin.request("POST", `/announcements/${announcement.announcement.id}/publish`, { scheduledFor: "2000-01-01T00:00:00.000Z" }, 400);
  await admin.request("POST", `/announcements/${announcement.announcement.id}/publish`, {});

  const vipList = await vipClient.request<{ items: Array<{ id: string; reactionCounts: Record<string, number>; commentCount: number }> }>("GET", "/announcements");
  assert.ok(vipList.items.some((item) => item.id === announcement.announcement.id));
  const regularList = await regularClient.request<{ items: Array<{ id: string }> }>("GET", "/announcements");
  assert.ok(!regularList.items.some((item) => item.id === announcement.announcement.id));

  await regularClient.request("POST", `/announcements/${announcement.announcement.id}/reactions`, { emoji: "ok" }, 403);
  await vipClient.request("POST", `/announcements/${announcement.announcement.id}/reactions`, { emoji: "ok" });
  await vipClient.request("POST", `/announcements/${announcement.announcement.id}/reactions`, { emoji: "ok" });
  const comment = await vipClient.request<{ comment: { id: string } }>("POST", `/announcements/${announcement.announcement.id}/comments`, { body: "great" }, 201);
  await vipClient.request("DELETE", `/announcement-comments/${comment.comment.id}`);

  const after = await vipClient.request<{ items: Array<{ id: string; reactionCounts: Record<string, number>; commentCount: number }> }>("GET", "/announcements");
  const item = after.items.find((row) => row.id === announcement.announcement.id);
  assert.equal(item?.reactionCounts.ok, 1);
  assert.equal(item?.commentCount, 0);
});

test("reports preserve evidence, enforce visibility, and notify on status updates", async () => {
  const customer = await createUser(admin, "customer", "report");
  const other = await createUser(admin, "customer", "report-other");
  const customerClient = await login(customer.email, customer.password);
  const otherClient = await login(other.email, other.password);
  const { chat } = await customerClient.request<{ chat: { id: string } }>("POST", "/chats/current");
  const message = await customerClient.request<{ message: { id: string } }>("POST", `/chats/${chat.id}/messages`, { body: "Evidence", idempotencyKey: "report-evidence-idem" }, 201);
  const reportFile = await createReadyFile(customer.id);
  const report = await customerClient.request<{ report: { id: string } }>("POST", "/reports", {
    title: "Bug",
    category: "bug",
    description: "Bug details",
    evidenceMessageIds: [message.message.id],
    fileIds: [reportFile],
    idempotencyKey: "report-idem-1",
  }, 201);

  await otherClient.request("GET", `/reports/${report.report.id}`, undefined, 403);
  const detail = await admin.request<{ report: { evidenceSnapshot: Array<{ body: string }>; files: unknown[]; availableActions: { update_status: boolean } } }>("GET", `/reports/${report.report.id}`);
  assert.equal(detail.report.evidenceSnapshot[0].body, "Evidence");
  assert.equal(detail.report.files.length, 1);
  assert.equal(detail.report.availableActions.update_status, true);

  await customerClient.request("DELETE", `/messages/${message.message.id}`);
  const afterDelete = await admin.request<{ report: { evidenceSnapshot: Array<{ body: string }> } }>("GET", `/reports/${report.report.id}`);
  assert.equal(afterDelete.report.evidenceSnapshot[0].body, "Evidence");

  await admin.request("PATCH", `/reports/${report.report.id}/status`, { status: "reviewed" });
  const notifications = await customerClient.request<{ unreadCount: number; items: Array<{ type: string }> }>("GET", "/notifications");
  assert.ok(notifications.items.some((item) => item.type === "report_status_changed"));
});

test("ratings are resolved-only and unique per support cycle", async () => {
  const agent = await createUser(admin, "agent", "rating-agent");
  const customer = await createUser(admin, "customer", "rating");
  const agentClient = await login(agent.email, agent.password);
  const customerClient = await login(customer.email, customer.password);
  const { chat } = await customerClient.request<{ chat: { id: string } }>("POST", "/chats/current");
  await customerClient.request("POST", `/chats/${chat.id}/ratings`, { stars: 5 }, 409);
  await agentClient.request("POST", `/chats/${chat.id}/claim`);
  await agentClient.request("POST", `/chats/${chat.id}/status`, { status: "resolved" });
  await customerClient.request("POST", `/chats/${chat.id}/ratings`, { stars: 5, idempotencyKey: "rating-one" }, 201);
  await customerClient.request("POST", `/chats/${chat.id}/ratings`, { stars: 4, idempotencyKey: "rating-two" }, 409);
  await customerClient.request("POST", `/chats/${chat.id}/messages`, { body: "reopen", idempotencyKey: "rating-reopen" }, 201);
  await agentClient.request("POST", `/chats/${chat.id}/status`, { status: "resolved" });
  await customerClient.request("POST", `/chats/${chat.id}/ratings`, { stars: 4, idempotencyKey: "rating-cycle-two" }, 201);
});

test("team chat supports mentions, unread counts, read receipts, delete rules, and events", async () => {
  const agentA = await createUser(admin, "agent", "team-a");
  const agentB = await createUser(admin, "agent", "team-b");
  const agentAClient = await login(agentA.email, agentA.password);
  const agentBClient = await login(agentB.email, agentB.password);
  const message = await agentAClient.request<{ message: { id: string } }>("POST", "/team/messages", {
    body: "hello team",
    mentionUserIds: [agentB.id],
    idempotencyKey: "team-idem-1",
  }, 201);
  const list = await agentBClient.request<{ items: Array<{ id: string }>; unreadCount: number }>("GET", "/team/messages");
  assert.ok(list.items.some((item) => item.id === message.message.id));
  assert.ok(list.unreadCount >= 1);
  await agentBClient.request("POST", "/team/messages/read", { messageId: message.message.id });
  await agentBClient.request("DELETE", `/team/messages/${message.message.id}`, undefined, 403);
  await admin.request("DELETE", `/team/messages/${message.message.id}`);
  const event = await db.select().from(schema.outboxEvents).where(eq(schema.outboxEvents.event, "team:message:deleted"));
  assert.ok(event.length >= 1);
});

test("search, audit filters, notifications, and SSE reconnect state are role-aware", async () => {
  const customer = await createUser(admin, "customer", "search");
  const customerClient = await login(customer.email, customer.password);
  const announcement = await admin.request<{ announcement: { id: string } }>("POST", "/announcements", {
    title: "Searchable announcement",
    body: "visible body",
    targetType: "all_customers",
  }, 201);
  await admin.request("POST", `/announcements/${announcement.announcement.id}/publish`, {});

  const customerSearch = await customerClient.request<{ groups: Record<string, unknown[]> }>("GET", "/search?q=Searchable");
  assert.ok(!("users" in customerSearch.groups));
  const adminSearch = await admin.request<{ groups: Record<string, unknown[]> }>("GET", "/search?q=Searchable");
  assert.ok(Array.isArray(adminSearch.groups.announcements));

  const audit = await admin.request<{ items: Array<{ action: string }> }>("GET", "/admin/audit-logs?action=announcement_published");
  assert.ok(audit.items.some((item) => item.action === "announcement_published"));

  const state = await customerClient.request<{ reconnect: { refetch: string[]; unreadNotifications: number } }>("GET", "/events/state");
  assert.ok(state.reconnect.refetch.includes("notifications"));
  assert.equal(typeof state.reconnect.unreadNotifications, "number");
});

test("database invariants and migration-created tables exist", async () => {
  const tables = await client.execute("select name from sqlite_master where type='table'");
  const tableNames = new Set(tables.rows.map((row) => row.name));
  for (const table of ["users", "support_chats", "outbox_events", "idempotency_keys", "team_message_reads"]) {
    assert.ok(tableNames.has(table), `${table} should exist`);
  }

  const customer = await createUser(admin, "customer", "invariant");
  await db.insert(schema.supportChats).values({ id: randomUUID(), customerId: customer.id });
  await assert.rejects(() => db.insert(schema.supportChats).values({ id: randomUUID(), customerId: customer.id }));

  const reaction = { announcementId: randomUUID(), userId: customer.id, emoji: "ok" };
  await db.insert(schema.announcements).values({ id: reaction.announcementId, authorId: adminSeed.id, title: "Invariant", body: "Body", status: "published" });
  await db.insert(schema.announcementReactions).values(reaction);
  await db.insert(schema.announcementReactions).values(reaction).onConflictDoNothing();
  const reactions = await db.select().from(schema.announcementReactions).where(and(eq(schema.announcementReactions.announcementId, reaction.announcementId), eq(schema.announcementReactions.userId, customer.id)));
  assert.equal(reactions.length, 1);

  const activeAssignments = await db.select().from(schema.chatAssignments).where(isNull(schema.chatAssignments.endedAt));
  assert.ok(Array.isArray(activeAssignments));
});
