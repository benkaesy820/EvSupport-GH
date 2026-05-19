import test, { after } from "node:test";
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
const { and, eq, inArray, isNull } = await import("drizzle-orm");
const { createApp } = await import("../src/app.js");
const { db, libsql } = await import("../src/db.js");
const { runDueJobs } = await import("../src/jobs.js");
const schema = await import("../src/schema.js");

const app = createApp();
let ipCounter = 1;

after(async () => {
  client.close();
  libsql.close();
});

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
  if (role === "customer") {
    const user = await createSeedUser("customer", suffix, password);
    return { id: user.id, email: user.email, password };
  }
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

  const resetAudits = await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.action, "password_reset"));
  assert.ok(resetAudits.length >= 1);

  await admin.request("PATCH", `/admin/users/${customer.id}`, { status: "suspended" });
  await apiRequest("POST", "/auth/login", { email: customer.email, password: resetPassword }, 403);
});

test("customer registration, customer invite, approval, and admin creation restrictions work", async () => {
  const suffix = randomUUID().slice(0, 8);
  const registered = await apiRequest<{ user: { id: string; status: string }; approvalRequired: boolean }>("POST", "/auth/register", {
    email: `registered-${suffix}@evcomm.test`,
    password: `Registered-${suffix}-Password-123!`,
    displayName: "Registered Customer",
  }, 201);
  assert.equal(registered.user.status, "pending_approval");
  assert.equal(registered.approvalRequired, true);
  await apiRequest("POST", "/auth/login", { email: `registered-${suffix}@evcomm.test`, password: `Registered-${suffix}-Password-123!` }, 403);

  const pendingCustomers = await admin.request<{ items: Array<{ id: string; status: string; availableActions: { approve: boolean } }> }>("GET", "/admin/customers");
  assert.ok(pendingCustomers.items.some((customer) => customer.id === registered.user.id && customer.status === "pending_approval" && customer.availableActions.approve));
  await admin.request("POST", `/admin/users/${registered.user.id}/approve`);
  await login(`registered-${suffix}@evcomm.test`, `Registered-${suffix}-Password-123!`);

  const invite = await admin.request<{ user: { id: string; status: string }; debugSetupToken?: string }>("POST", "/admin/customer-invites", {
    email: `invited-${suffix}@evcomm.test`,
    displayName: "Invited Customer",
  }, 201);
  assert.equal(invite.user.status, "pending_approval");
  assert.ok(invite.debugSetupToken);
  const invitedPassword = `Invited-${suffix}-Password-123!`;
  await apiRequest("POST", "/auth/password-reset/confirm", { token: invite.debugSetupToken, password: invitedPassword });
  await apiRequest("POST", "/auth/login", { email: `invited-${suffix}@evcomm.test`, password: invitedPassword }, 403);
  await admin.request("POST", `/admin/users/${invite.user.id}/approve`);
  await login(`invited-${suffix}@evcomm.test`, invitedPassword);

  await admin.request("POST", "/admin/users", {
    role: "customer",
    email: `blocked-customer-${suffix}@evcomm.test`,
    password: `Blocked-${suffix}-Password-123!`,
    displayName: "Blocked Customer",
  }, 400);
  await admin.request("POST", "/admin/users", {
    role: "admin",
    email: `blocked-admin-${suffix}@evcomm.test`,
    password: `Blocked-${suffix}-Password-123!`,
    displayName: "Blocked Admin",
  }, 400);

  const audit = await admin.request<{ items: Array<{ action: string }> }>("GET", "/admin/audit-logs?action=customer_approved");
  assert.ok(audit.items.some((item) => item.action === "customer_approved"));
  const inviteAudits = await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.action, "customer_invited"));
  const registerAudits = await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.action, "customer_registered"));
  assert.ok(inviteAudits.length >= 1);
  assert.ok(registerAudits.length >= 1);
});

test("chat permissions, state transitions, unread counts, notes, and idempotency work", async () => {
  const agent = await createUser(admin, "agent", "chat");
  const customer = await createUser(admin, "customer", "chat");
  const agentClient = await login(agent.email, agent.password);
  const customerClient = await login(customer.email, customer.password);

  const current = await customerClient.request<{ chat: { id: string; status: string; availableActions: Record<string, boolean> } }>("POST", "/chats/current");
  assert.equal(current.chat.status, "open");
  assert.equal(current.chat.availableActions.send_message, true);
  await agentClient.request("POST", `/chats/${current.chat.id}/typing`, { isTyping: true }, 403);

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
  await agentClient.request("POST", `/chats/${current.chat.id}/typing`, { isTyping: true });
  const note = await agentClient.request<{ note: { id: string } }>("POST", `/chats/${current.chat.id}/internal-notes`, { body: "Support-only note" }, 201);
  const customerDetail = await customerClient.request<{ internalNotes: unknown[]; messages: unknown[]; nextMessageCursor: string | null }>("GET", `/chats/${current.chat.id}?limit=1`);
  assert.equal(customerDetail.internalNotes.length, 0);
  assert.equal(customerDetail.messages.length, 1);
  assert.ok("nextMessageCursor" in customerDetail);
  await agentClient.request("DELETE", `/internal-notes/${note.note.id}`);
  const agentDetailAfterDelete = await agentClient.request<{ internalNotes: Array<{ id: string }> }>("GET", `/chats/${current.chat.id}`);
  assert.ok(!agentDetailAfterDelete.internalNotes.some((item) => item.id === note.note.id));

  await agentClient.request("POST", `/chats/${current.chat.id}/status`, { status: "resolved" });
  await agentClient.request("POST", `/chats/${current.chat.id}/typing`, { isTyping: true }, 409);
  await agentClient.request("POST", `/chats/${current.chat.id}/messages`, { body: "Resolved reply", idempotencyKey: "resolved-agent-denial" }, 409);
  const reopened = await customerClient.request<{ chat: { status: string; supportCycle: number } }>("POST", `/chats/${current.chat.id}/messages`, { body: "Still broken", idempotencyKey: "chat-reopen-idem" }, 201);
  assert.equal(reopened.chat.status, "open");
  assert.equal(reopened.chat.supportCycle, 2);

  await admin.request("POST", `/chats/${current.chat.id}/status`, { status: "closed" });
  await customerClient.request("POST", `/chats/${current.chat.id}/messages`, { body: "closed denial", idempotencyKey: "closed-denial-idem" }, 409);
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
  const message = await customerAClient.request<{ message: { id: string } }>("POST", `/chats/${chat.id}/messages`, { body: "file", fileIds: [fileId], idempotencyKey: "file-chat-idem" }, 201);
  await customerBClient.request("GET", `/files/${fileId}/download`, undefined, 403);
  await customerAClient.request("DELETE", `/messages/${message.message.id}`);
  await customerAClient.request("GET", `/files/${fileId}/download`, undefined, 404);
  const detail = await customerAClient.request<{ messages: Array<{ id: string; body: string | null; files: unknown[] }> }>("GET", `/chats/${chat.id}`);
  const deleted = detail.messages.find((row) => row.id === message.message.id);
  assert.equal(deleted?.body, null);
  assert.equal(deleted?.files.length, 0);
  const search = await customerAClient.request<{ groups: { messages: Array<{ messages: { id: string } }> } }>("GET", "/search?q=file");
  assert.ok(!search.groups.messages.some((row) => row.messages.id === message.message.id));

  const otherFile = await createReadyFile(customerB.id);
  await customerAClient.request("POST", `/chats/${chat.id}/messages`, { body: "bad file", fileIds: [otherFile], idempotencyKey: "bad-file-idem" }, 403);
});

test("file intents enforce settings, resource pairing, owner-only unattached downloads, and pending completion", async () => {
  const customerA = await createUser(admin, "customer", "file-policy-a");
  const customerB = await createUser(admin, "customer", "file-policy-b");
  const customerAClient = await login(customerA.email, customerA.password);
  const customerBClient = await login(customerB.email, customerB.password);

  await admin.request("PATCH", "/admin/settings", { maxFileSize: 64, allowedFileTypes: ["image/png"] });
  await customerAClient.request("POST", "/files/upload-intents", {
    resourceType: "chat",
    name: "partial.png",
    mimeType: "image/png",
    sizeBytes: 32,
  }, 400);
  await customerAClient.request("POST", "/files/upload-intents", {
    name: "too-large.png",
    mimeType: "image/png",
    sizeBytes: 128,
  }, 400);
  await customerAClient.request("POST", "/files/upload-intents", {
    name: "bad.pdf",
    mimeType: "application/pdf",
    sizeBytes: 32,
  }, 400);

  const unattached = await createReadyFile(customerA.id);
  await customerBClient.request("GET", `/files/${unattached}/download`, undefined, 403);

  const expired = randomUUID();
  await db.insert(schema.files).values({
    id: expired,
    ownerId: customerA.id,
    storageKey: `${customerA.id}/${expired}/expired.png`,
    name: "expired.png",
    mimeType: "image/png",
    sizeBytes: 32,
    status: "expired",
  });
  await customerAClient.request("POST", `/files/${expired}/complete`, {}, 409);

  const stalePending = randomUUID();
  await db.insert(schema.files).values({
    id: stalePending,
    ownerId: customerA.id,
    storageKey: `${customerA.id}/${stalePending}/stale.png`,
    name: "stale.png",
    mimeType: "image/png",
    sizeBytes: 32,
    status: "pending",
    expiresAt: "2000-01-01T00:00:00.000Z",
  });
  await customerAClient.request("POST", `/files/${stalePending}/complete`, {}, 409);
  const [staleAfter] = await db.select().from(schema.files).where(eq(schema.files.id, stalePending));
  assert.equal(staleAfter.status, "expired");
});

test("job cleanup expires stale pending and orphaned ready files", async () => {
  const customer = await createUser(admin, "customer", "cleanup");
  const pendingId = randomUUID();
  const orphanId = randomUUID();
  const oldNotificationId = randomUUID();
  const recentNotificationId = randomUUID();
  await db.insert(schema.files).values({
    id: pendingId,
    ownerId: customer.id,
    storageKey: `${customer.id}/${pendingId}/pending.png`,
    name: "pending.png",
    mimeType: "image/png",
    sizeBytes: 32,
    status: "pending",
    expiresAt: "2000-01-01T00:00:00.000Z",
  });
  await db.insert(schema.files).values({
    id: orphanId,
    ownerId: customer.id,
    storageKey: `${customer.id}/${orphanId}/orphan.png`,
    name: "orphan.png",
    mimeType: "image/png",
    sizeBytes: 32,
    status: "ready",
    completedAt: "2000-01-01T00:00:00.000Z",
  });
  await db.insert(schema.idempotencyKeys).values({
    scope: "test.cleanup",
    key: "expired-completed-key",
    actorId: customer.id,
    requestHash: "hash",
    responseJson: { ok: true },
    status: "completed",
    expiresAt: "2000-01-01T00:00:00.000Z",
  });
  await db.insert(schema.notifications).values({
    id: oldNotificationId,
    userId: customer.id,
    type: "cleanup_old",
    resourceType: "test",
    resourceId: oldNotificationId,
    title: "old",
    body: "old",
    readAt: "2000-01-01T00:00:00.000Z",
  });
  await db.insert(schema.notifications).values({
    id: recentNotificationId,
    userId: customer.id,
    type: "cleanup_recent",
    resourceType: "test",
    resourceId: recentNotificationId,
    title: "recent",
    body: "recent",
    readAt: new Date().toISOString(),
  });

  await runDueJobs();
  const rows = await db.select().from(schema.files).where(inArray(schema.files.id, [pendingId, orphanId]));
  assert.equal(rows.find((row) => row.id === pendingId)?.status, "expired");
  assert.equal(rows.find((row) => row.id === orphanId)?.status, "expired");
  const idemRows = await db.select().from(schema.idempotencyKeys).where(eq(schema.idempotencyKeys.scope, "test.cleanup"));
  assert.equal(idemRows.length, 0);
  const retainedNotifications = await db
    .select()
    .from(schema.notifications)
    .where(inArray(schema.notifications.id, [oldNotificationId, recentNotificationId]));
  assert.ok(!retainedNotifications.some((row) => row.id === oldNotificationId));
  assert.ok(retainedNotifications.some((row) => row.id === recentNotificationId));
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
  const adminReportNotifications = await db.select().from(schema.notifications).where(and(eq(schema.notifications.userId, adminSeed.id), eq(schema.notifications.type, "report_created")));
  assert.ok(adminReportNotifications.some((item) => item.resourceId === report.report.id));

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

test("report evidence is limited to the reporting customer's visible messages", async () => {
  const customerA = await createUser(admin, "customer", "evidence-a");
  const customerB = await createUser(admin, "customer", "evidence-b");
  const clientA = await login(customerA.email, customerA.password);
  const clientB = await login(customerB.email, customerB.password);
  const chatB = await clientB.request<{ chat: { id: string } }>("POST", "/chats/current");
  const messageB = await clientB.request<{ message: { id: string } }>("POST", `/chats/${chatB.chat.id}/messages`, {
    body: "not your evidence",
    idempotencyKey: "foreign-evidence-message",
  }, 201);

  await clientA.request("POST", "/reports", {
    title: "Bad evidence",
    category: "bug",
    description: "Should be rejected",
    evidenceMessageIds: [messageB.message.id],
    idempotencyKey: "foreign-evidence-report",
  }, 403);
});

test("ratings are resolved-only and unique per support cycle", async () => {
  const agent = await createUser(admin, "agent", "rating-agent");
  const customer = await createUser(admin, "customer", "rating");
  const agentClient = await login(agent.email, agent.password);
  const customerClient = await login(customer.email, customer.password);
  const { chat } = await customerClient.request<{ chat: { id: string } }>("POST", "/chats/current");
  await customerClient.request("POST", `/chats/${chat.id}/ratings`, { stars: 5, idempotencyKey: "rating-before-resolved" }, 409);
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
  const teamDeleteAudits = await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.action, "team_message_deleted"));
  assert.ok(teamDeleteAudits.length >= 1);
});

test("deleted team message attachments are hidden", async () => {
  const agent = await createUser(admin, "agent", "team-file");
  const agentClient = await login(agent.email, agent.password);
  const fileId = await createReadyFile(agent.id);
  const message = await agentClient.request<{ message: { id: string } }>("POST", "/team/messages", {
    body: "file",
    fileIds: [fileId],
    idempotencyKey: "team-file-idem",
  }, 201);
  await agentClient.request("GET", `/files/${fileId}/download`);
  await admin.request("DELETE", `/team/messages/${message.message.id}`);
  await agentClient.request("GET", `/files/${fileId}/download`, undefined, 404);
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
  assert.ok(Array.isArray(customerSearch.groups.announcements));
  assert.ok(customerSearch.groups.announcements.length >= 1);
  const adminSearch = await admin.request<{ groups: Record<string, unknown[]> }>("GET", "/search?q=Searchable");
  assert.ok(Array.isArray(adminSearch.groups.announcements));

  const dashboard = await admin.request<{ counts: { pendingCustomers: number; resolvedToday: number } }>("GET", "/admin/dashboard");
  assert.equal(typeof dashboard.counts.pendingCustomers, "number");
  assert.equal(typeof dashboard.counts.resolvedToday, "number");
  const agents = await admin.request<{ items: Array<{ availableActions: { suspend: boolean; revoke_sessions: boolean } }> }>("GET", "/admin/agents");
  assert.ok(agents.items.every((item) => typeof item.availableActions.suspend === "boolean" && typeof item.availableActions.revoke_sessions === "boolean"));
  const agentForDetail = await createUser(admin, "agent", "detail");
  const detail = await admin.request<{ agent: { id: string; availability: string; activeChats: number; availableActions: { suspend: boolean } } }>("GET", `/admin/agents/${agentForDetail.id}`);
  assert.equal(detail.agent.id, agentForDetail.id);
  assert.equal(typeof detail.agent.activeChats, "number");
  assert.equal(typeof detail.agent.availableActions.suspend, "boolean");
  await admin.request("GET", `/admin/agents/${randomUUID()}`, undefined, 404);
  await admin.request("GET", "/admin/users?role=bogus", undefined, 400);
  const customerForPatch = await createUser(admin, "customer", "customer-patch");
  await admin.request("PATCH", `/admin/customers/${customerForPatch.id}`, { tags: ["vip"], internalNotes: "Important customer" });
  await admin.request("PATCH", `/admin/customers/${customerForPatch.id}`, { accountStatus: "suspended" }, 400);

  const audit = await admin.request<{ items: Array<{ action: string }> }>("GET", "/admin/audit-logs?action=announcement_published");
  assert.ok(audit.items.some((item) => item.action === "announcement_published"));

  const state = await customerClient.request<{ reconnect: { refetch: string[]; unreadNotifications: number } }>("GET", "/events/state");
  assert.ok(state.reconnect.refetch.includes("notifications"));
  assert.equal(typeof state.reconnect.unreadNotifications, "number");
});

test("ratings endpoints, takeover leave, agent settings, and quick replies are covered", async () => {
  const agent = await createUser(admin, "agent", "coverage-agent");
  const customer = await createUser(admin, "customer", "coverage-customer");
  const agentClient = await login(agent.email, agent.password);
  const customerClient = await login(customer.email, customer.password);
  const current = await customerClient.request<{ chat: { id: string } }>("POST", "/chats/current");

  await agentClient.request("POST", `/chats/${current.chat.id}/claim`);
  await admin.request("POST", `/chats/${current.chat.id}/takeover`, { mode: "join" });
  await admin.request("DELETE", `/chats/${current.chat.id}/takeover`);
  const participantRows = await db
    .select()
    .from(schema.chatAdminParticipants)
    .where(and(eq(schema.chatAdminParticipants.chatId, current.chat.id), eq(schema.chatAdminParticipants.adminId, adminSeed.id)));
  assert.ok(participantRows.some((row) => row.leftAt));

  await admin.request("PATCH", `/admin/agents/${agent.id}`, { availability: "away", skills: ["billing"], capacity: 4 });
  const detail = await admin.request<{ agent: { availability: string; skills: string[]; capacity: number } }>("GET", `/admin/agents/${agent.id}`);
  assert.equal(detail.agent.availability, "away");
  assert.deepEqual(detail.agent.skills, ["billing"]);
  assert.equal(detail.agent.capacity, 4);

  await agentClient.request("PATCH", "/me/availability", { availability: "available" });
  await agentClient.request("PATCH", "/me/availability", { skills: ["account"] }, 403);
  await agentClient.request("PATCH", "/me/availability", { capacity: 20 }, 403);

  await admin.request("PATCH", "/admin/quick-replies", { items: ["First reply", "Second reply"] });
  const settings = await admin.request<{ settings: { quickReplies: string[] } }>("GET", "/settings");
  assert.deepEqual(settings.settings.quickReplies, ["First reply", "Second reply"]);

  await agentClient.request("POST", `/chats/${current.chat.id}/status`, { status: "resolved" });
  const rating = await customerClient.request<{ rating: { id: string } }>("POST", `/chats/${current.chat.id}/ratings`, {
    stars: 4,
    comment: "coverage rating",
    idempotencyKey: "coverage-rating",
  }, 201);
  const ownRatings = await agentClient.request<{ items: Array<{ id: string }>; summary: { count: number; averageStars: number } }>("GET", "/me/ratings");
  assert.ok(ownRatings.items.some((row) => row.id === rating.rating.id));
  assert.ok(ownRatings.summary.count >= 1);
  const adminRatings = await admin.request<{ items: Array<{ id: string; agentDisplayName: string | null; customerDisplayName: string | null }>; summary: { count: number } }>("GET", "/admin/ratings");
  assert.ok(adminRatings.items.some((row) => row.id === rating.rating.id && row.agentDisplayName && row.customerDisplayName));
  assert.ok(adminRatings.summary.count >= 1);
});

test("profile avatar files are ready, unattached, immutable, and visible as avatars", async () => {
  const customerA = await createUser(admin, "customer", "avatar-a");
  const customerB = await createUser(admin, "customer", "avatar-b");
  const customerAClient = await login(customerA.email, customerA.password);
  const customerBClient = await login(customerB.email, customerB.password);

  const avatarFileId = await createReadyFile(customerA.id);
  await customerAClient.request("PATCH", "/me", { avatarFileId });
  await customerBClient.request("GET", `/files/${avatarFileId}/download`);
  await customerAClient.request("POST", `/chats/current`);
  await customerAClient.request("POST", `/chats/${(await customerAClient.request<{ chat: { id: string } }>("POST", "/chats/current")).chat.id}/messages`, {
    body: "avatar cannot be reused",
    fileIds: [avatarFileId],
    idempotencyKey: "avatar-reuse",
  }, 409);

  const otherOwnerFileId = await createReadyFile(customerB.id);
  await customerAClient.request("PATCH", "/me", { avatarFileId: otherOwnerFileId }, 403);

  const pendingFileId = randomUUID();
  await db.insert(schema.files).values({
    id: pendingFileId,
    ownerId: customerA.id,
    storageKey: `${customerA.id}/${pendingFileId}/pending.png`,
    name: "pending.png",
    mimeType: "image/png",
    sizeBytes: 32,
    status: "pending",
  });
  await customerAClient.request("PATCH", "/me", { avatarFileId: pendingFileId }, 409);

  const attachedFileId = await createReadyFile(customerA.id, "report", randomUUID());
  await customerAClient.request("PATCH", "/me", { avatarFileId: attachedFileId }, 409);

  await new Promise((resolve) => setTimeout(resolve, 25));
  const [updatedUser] = await db.select().from(schema.users).where(eq(schema.users.id, customerA.id));
  assert.ok(updatedUser.lastActiveAt);
});

test("admin 2FA restrictions and last-admin destructive guards hold", async () => {
  await admin.request("POST", "/me/2fa/enroll", undefined, 409);
  await admin.request("POST", "/me/2fa/disable", { password: adminSeed.password }, 403);
  await admin.request("PATCH", `/admin/users/${adminSeed.id}`, { status: "suspended" }, 409);
  await admin.request("DELETE", `/admin/users/${adminSeed.id}/anonymize`, undefined, 409);
  await admin.request("DELETE", `/admin/users/${adminSeed.id}/sessions`, undefined, 409);
});

test("admin and agent search cover operational resources without leaking internal notes to customers", async () => {
  const agent = await createUser(admin, "agent", "search-agent");
  const customer = await createUser(admin, "customer", "search-customer");
  const agentClient = await login(agent.email, agent.password);
  const customerClient = await login(customer.email, customer.password);
  const current = await customerClient.request<{ chat: { id: string } }>("POST", "/chats/current");
  await customerClient.request("POST", `/chats/${current.chat.id}/messages`, { body: "Findable customer message", idempotencyKey: "findable-message" }, 201);
  await agentClient.request("POST", `/chats/${current.chat.id}/claim`);
  await agentClient.request("POST", `/chats/${current.chat.id}/internal-notes`, { body: "Findable internal note" }, 201);
  await agentClient.request("POST", "/team/messages", { body: "Findable team thread", idempotencyKey: "findable-team" }, 201);
  await agentClient.request("POST", `/chats/${current.chat.id}/status`, { status: "resolved" });
  await customerClient.request("POST", `/chats/${current.chat.id}/ratings`, { stars: 5, comment: "Findable rating", idempotencyKey: "findable-rating" }, 201);

  const adminSearch = await admin.request<{ groups: Record<string, unknown[]> }>("GET", "/search?q=Findable");
  assert.ok(adminSearch.groups.messages.length >= 1);
  assert.ok(adminSearch.groups.internalNotes.length >= 1);
  assert.ok(adminSearch.groups.teamMessages.length >= 1);

  const agentSearch = await agentClient.request<{ groups: Record<string, unknown[]> }>("GET", "/search?q=Findable");
  assert.ok(agentSearch.groups.messages.length >= 1);
  assert.ok(agentSearch.groups.internalNotes.length >= 1);
  assert.ok(agentSearch.groups.teamMessages.length >= 1);
  assert.ok(agentSearch.groups.ratings.length >= 1);

  const customerSearch = await customerClient.request<{ groups: Record<string, unknown[]> }>("GET", "/search?q=Findable");
  assert.ok(!("internalNotes" in customerSearch.groups));
  assert.ok(!("teamMessages" in customerSearch.groups));
});

test("write idempotency keys are required by contract", async () => {
  const customer = await createUser(admin, "customer", "required-idem");
  const agent = await createUser(admin, "agent", "required-idem");
  const customerClient = await login(customer.email, customer.password);
  const agentClient = await login(agent.email, agent.password);
  const current = await customerClient.request<{ chat: { id: string } }>("POST", "/chats/current");
  await customerClient.request("POST", `/chats/${current.chat.id}/messages`, { body: "missing idempotency" }, 400);
  await customerClient.request("POST", "/reports", { title: "Missing", category: "bug", description: "missing idempotency" }, 400);
  await agentClient.request("POST", "/team/messages", { body: "missing idempotency" }, 400);
});

test("database invariants and migration-created tables exist", async () => {
  const tables = await client.execute("select name from sqlite_master where type='table'");
  const tableNames = new Set(tables.rows.map((row) => row.name));
  for (const table of ["users", "support_chats", "idempotency_keys", "team_message_reads", "two_factor_challenges"]) {
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

test("optional 2FA enrollment and disable flow works for agents", async () => {
  const agent = await createUser(admin, "agent", "twofa");
  let agentClient = await login(agent.email, agent.password);

  const enroll = await agentClient.request<{ challengeId: string; debugCode: string }>("POST", "/me/2fa/enroll");
  assert.ok(enroll.challengeId);
  assert.ok(enroll.debugCode);
  await agentClient.request("POST", "/me/2fa/enroll/verify", { challengeId: enroll.challengeId, code: enroll.debugCode });

  const me = await agentClient.request<{ user: { twoFactorEnabled: boolean } }>("GET", "/me");
  assert.equal(me.user.twoFactorEnabled, true);

  agentClient = await login(agent.email, agent.password);
  const meAfter = await agentClient.request<{ user: { twoFactorEnabled: boolean } }>("GET", "/me");
  assert.equal(meAfter.user.twoFactorEnabled, true);

  await agentClient.request("POST", "/me/2fa/disable", { password: agent.password });
  const meDisabled = await agentClient.request<{ user: { twoFactorEnabled: boolean } }>("GET", "/me");
  assert.equal(meDisabled.user.twoFactorEnabled, false);

  await agentClient.request("POST", "/me/2fa/disable", { password: "wrong-password" }, 401);
});

test("/customers/:id scopes agent access via current chat", async () => {
  const agentA = await createUser(admin, "agent", "scopeA");
  const agentB = await createUser(admin, "agent", "scopeB");
  const customer = await createUser(admin, "customer", "scoped");
  const customerClient = await login(customer.email, customer.password);
  const current = await customerClient.request<{ chat: { id: string } }>("POST", "/chats/current", undefined, 200);

  const agentAClient = await login(agentA.email, agentA.password);
  const agentBClient = await login(agentB.email, agentB.password);

  await agentAClient.request("GET", `/customers/${customer.id}`);
  await agentBClient.request("GET", `/customers/${customer.id}`);

  await agentAClient.request("POST", `/chats/${current.chat.id}/claim`);
  await agentAClient.request("GET", `/customers/${customer.id}`);
  await agentBClient.request("GET", `/customers/${customer.id}`, undefined, 403);

  await admin.request("GET", `/customers/${customer.id}`);
});

test("inbox filter aliases respect role visibility", async () => {
  const agent = await createUser(admin, "agent", "inbox");
  const customer = await createUser(admin, "customer", "inbox");
  const customerClient = await login(customer.email, customer.password);
  const current = await customerClient.request<{ chat: { id: string } }>("POST", "/chats/current");
  const agentClient = await login(agent.email, agent.password);

  const unassignedBefore = await agentClient.request<{ items: Array<{ id: string }> }>("GET", "/chats?filter=unassigned");
  assert.ok(unassignedBefore.items.some((row) => row.id === current.chat.id));
  const mineBefore = await agentClient.request<{ items: Array<{ id: string }> }>("GET", "/chats?filter=mine");
  assert.ok(!mineBefore.items.some((row) => row.id === current.chat.id));

  await agentClient.request("POST", `/chats/${current.chat.id}/claim`);
  const unassignedAfter = await agentClient.request<{ items: Array<{ id: string }> }>("GET", "/chats?filter=unassigned");
  assert.ok(!unassignedAfter.items.some((row) => row.id === current.chat.id));
  const mineAfter = await agentClient.request<{ items: Array<{ id: string }> }>("GET", "/chats?filter=mine");
  assert.ok(mineAfter.items.some((row) => row.id === current.chat.id));

  await agentClient.request("GET", "/chats?filter=bogus", undefined, 400);
  await agentClient.request("GET", "/chats?status=bogus", undefined, 400);
  await agentClient.request("GET", "/chats?limit=not-a-number", undefined, 400);
});

test("chat read marks all prior visible unread messages", async () => {
  const agent = await createUser(admin, "agent", "readbulk");
  const customer = await createUser(admin, "customer", "readbulk");
  const agentClient = await login(agent.email, agent.password);
  const customerClient = await login(customer.email, customer.password);
  const current = await customerClient.request<{ chat: { id: string } }>("POST", "/chats/current");
  const first = await customerClient.request<{ message: { id: string } }>("POST", `/chats/${current.chat.id}/messages`, { body: "one", idempotencyKey: "read-one" }, 201);
  await customerClient.request("POST", `/chats/${current.chat.id}/messages`, { body: "two", idempotencyKey: "read-two" }, 201);
  const latest = await customerClient.request<{ message: { id: string } }>("POST", `/chats/${current.chat.id}/messages`, { body: "three", idempotencyKey: "read-three" }, 201);
  await agentClient.request("POST", `/chats/${current.chat.id}/claim`);

  const before = await agentClient.request<{ chat: { unreadCount: number } }>("GET", `/chats/${current.chat.id}`);
  assert.equal(before.chat.unreadCount, 3);
  const partial = await agentClient.request<{ unreadCount: number }>("POST", `/chats/${current.chat.id}/read`, { messageId: first.message.id });
  assert.equal(partial.unreadCount, 2);
  await agentClient.request("POST", `/chats/${current.chat.id}/read`, { messageId: latest.message.id });
  const after = await agentClient.request<{ chat: { unreadCount: number } }>("GET", `/chats/${current.chat.id}`);
  assert.equal(after.chat.unreadCount, 0);
});

test("announcement reactions toggle on and off", async () => {
  const customer = await createUser(admin, "customer", "reactions");
  const customerClient = await login(customer.email, customer.password);
  const announcement = await admin.request<{ announcement: { id: string } }>("POST", "/announcements", {
    title: "React me",
    body: "body",
    targetType: "all_customers",
  }, 201);
  await admin.request("POST", `/announcements/${announcement.announcement.id}/publish`, {});
  await customerClient.request("POST", `/announcements/${announcement.announcement.id}/reactions`, { emoji: "thumbs_up" });
  const detail = await customerClient.request<{ announcement: { reactionCounts: Record<string, number> } }>("GET", `/announcements/${announcement.announcement.id}`);
  assert.equal(detail.announcement.reactionCounts.thumbs_up, 1);
  await customerClient.request("DELETE", `/announcements/${announcement.announcement.id}/reactions`, { emoji: "thumbs_up" });
  const detailAfter = await customerClient.request<{ announcement: { reactionCounts: Record<string, number> } }>("GET", `/announcements/${announcement.announcement.id}`);
  assert.equal(detailAfter.announcement.reactionCounts.thumbs_up ?? 0, 0);
});

test("announcements cannot be published repeatedly", async () => {
  const announcement = await admin.request<{ announcement: { id: string } }>("POST", "/announcements", {
    title: "Publish once",
    body: "body",
    targetType: "all_customers",
  }, 201);
  await admin.request("POST", `/announcements/${announcement.announcement.id}/publish`, {});
  await admin.request("POST", `/announcements/${announcement.announcement.id}/publish`, {}, 409);
});

test("targeted announcements require target values", async () => {
  await admin.request("POST", "/announcements", {
    title: "No targets",
    body: "body",
    targetType: "customer_tag",
  }, 400);
});

test("announcement comments listing returns author summaries", async () => {
  const customer = await createUser(admin, "customer", "comments");
  const customerClient = await login(customer.email, customer.password);
  const announcement = await admin.request<{ announcement: { id: string } }>("POST", "/announcements", {
    title: "Talk to me",
    body: "body",
    targetType: "all_customers",
  }, 201);
  await admin.request("POST", `/announcements/${announcement.announcement.id}/publish`, {});
  await customerClient.request("POST", `/announcements/${announcement.announcement.id}/comments`, { body: "first comment" }, 201);
  const list = await customerClient.request<{ items: Array<{ body: string; author: { displayName: string } | null }> }>("GET", `/announcements/${announcement.announcement.id}/comments`);
  assert.equal(list.items.length, 1);
  assert.equal(list.items[0].body, "first comment");
  assert.ok(list.items[0].author?.displayName);
});

test("customer auto-chat created on approval and sender info enriched", async () => {
  const suffix = randomUUID().slice(0, 8);
  const email = `approved-${suffix}@evcomm.test`;
  const password = `Approved-${suffix}-Password-123!`;
  const registered = await apiRequest<{ user: { id: string } }>("POST", "/auth/register", {
    email,
    password,
    displayName: "Approved Customer",
  }, 201);
  await admin.request("POST", `/admin/users/${registered.user.id}/approve`);

  const chats = await db.select().from(schema.supportChats).where(eq(schema.supportChats.customerId, registered.user.id));
  assert.equal(chats.length, 1);

  const customerClient = await login(email, password);
  await customerClient.request("POST", `/chats/${chats[0].id}/messages`, { body: "auto-chat works", idempotencyKey: `auto-${suffix}` }, 201);
  const detail = await customerClient.request<{ messages: Array<{ sender: { displayName: string; role: string } | null }> }>("GET", `/chats/${chats[0].id}`);
  assert.ok(detail.messages.length >= 1);
  assert.ok(detail.messages[0].sender);
  assert.equal(detail.messages[0].sender?.role, "customer");
});

test("chat resolved is idempotent and closing ends open assignment", async () => {
  const agent = await createUser(admin, "agent", "resolveidem");
  const secondAgent = await createUser(admin, "agent", "resolveidem-second");
  const customer = await createUser(admin, "customer", "resolveidem");
  const customerClient = await login(customer.email, customer.password);
  const current = await customerClient.request<{ chat: { id: string } }>("POST", "/chats/current");
  const agentClient = await login(agent.email, agent.password);
  await agentClient.request("POST", `/chats/${current.chat.id}/claim`);
  await agentClient.request("POST", `/chats/${current.chat.id}/messages`, { body: "ok", idempotencyKey: `res-${randomUUID()}` }, 201);

  const customerNotifsBefore = await db
    .select()
    .from(schema.notifications)
    .where(and(eq(schema.notifications.userId, customer.id), eq(schema.notifications.type, "chat_resolved")));
  await agentClient.request("POST", `/chats/${current.chat.id}/status`, { status: "resolved" });
  await agentClient.request("POST", `/chats/${current.chat.id}/status`, { status: "resolved" });
  await admin.request("POST", `/chats/${current.chat.id}/assign`, { agentId: secondAgent.id }, 409);
  await agentClient.request("POST", `/chats/${current.chat.id}/transfer`, { agentId: secondAgent.id }, 409);
  const rating = await customerClient.request<{ rating: { id: string } }>("POST", `/chats/${current.chat.id}/ratings`, {
    stars: 5,
    idempotencyKey: "resolved-agent-attribution",
  }, 201);
  const [ratingRow] = await db.select().from(schema.ratings).where(eq(schema.ratings.id, rating.rating.id));
  assert.equal(ratingRow.agentId, agent.id);
  const customerNotifsAfter = await db
    .select()
    .from(schema.notifications)
    .where(and(eq(schema.notifications.userId, customer.id), eq(schema.notifications.type, "chat_resolved")));
  assert.equal(customerNotifsAfter.length, customerNotifsBefore.length + 1);

  await admin.request("POST", `/chats/${current.chat.id}/status`, { status: "closed" });
  const openAssignments = await db
    .select()
    .from(schema.chatAssignments)
    .where(and(eq(schema.chatAssignments.chatId, current.chat.id), isNull(schema.chatAssignments.endedAt)));
  assert.equal(openAssignments.length, 0);
});

test("/sessions filters revoked by default", async () => {
  const agent = await createUser(admin, "agent", "sessions");
  const first = await login(agent.email, agent.password);
  const second = await login(agent.email, agent.password);
  const beforeRevoke = await second.request<{ items: Array<{ id: string; current: boolean }> }>("GET", "/sessions");
  assert.ok(beforeRevoke.items.length >= 2);
  const otherSession = beforeRevoke.items.find((row) => !row.current);
  assert.ok(otherSession);
  await second.request("DELETE", `/sessions/${otherSession!.id}`);
  const afterRevoke = await second.request<{ items: Array<{ id: string }> }>("GET", "/sessions");
  assert.ok(!afterRevoke.items.some((row) => row.id === otherSession!.id));
  const withRevoked = await second.request<{ items: Array<{ id: string }> }>("GET", "/sessions?includeRevoked=true");
  assert.ok(withRevoked.items.some((row) => row.id === otherSession!.id));
  assert.ok(first);
});

test("settings drive default chat priority and reject unknown keys", async () => {
  await admin.request("PATCH", "/admin/settings", { defaultChatPriority: "urgent" });
  await admin.request("PATCH", "/admin/settings", { quickReplies: ["not here"] }, 400);
  const customer = await createUser(admin, "customer", "default-priority");
  const customerClient = await login(customer.email, customer.password);
  const current = await customerClient.request<{ chat: { priority: string } }>("POST", "/chats/current");
  assert.equal(current.chat.priority, "urgent");
});

test("team read marks all prior unread messages", async () => {
  const agentA = await createUser(admin, "agent", "team-read-a");
  const agentB = await createUser(admin, "agent", "team-read-b");
  const agentAClient = await login(agentA.email, agentA.password);
  const agentBClient = await login(agentB.email, agentB.password);
  const first = await agentAClient.request<{ message: { id: string } }>("POST", "/team/messages", { body: "one", idempotencyKey: "team-read-one" }, 201);
  await agentAClient.request("POST", "/team/messages", { body: "two", idempotencyKey: "team-read-two" }, 201);
  const latest = await agentAClient.request<{ message: { id: string } }>("POST", "/team/messages", { body: "three", idempotencyKey: "team-read-three" }, 201);
  const before = await agentBClient.request<{ unreadCount: number }>("GET", "/team/messages");
  assert.ok(before.unreadCount >= 3);
  const partial = await agentBClient.request<{ unreadCount: number }>("POST", "/team/messages/read", { messageId: first.message.id });
  assert.equal(partial.unreadCount, 2);
  await agentBClient.request("POST", "/team/messages/read", { messageId: randomUUID() }, 404);
  await agentBClient.request("POST", "/team/messages/read", { messageId: latest.message.id });
  const after = await agentBClient.request<{ unreadCount: number }>("GET", "/team/messages");
  assert.equal(after.unreadCount, 0);
});

test("chat upload intents require write access, not just queue visibility", async () => {
  const agent = await createUser(admin, "agent", "upload-scope");
  const customer = await createUser(admin, "customer", "upload-scope");
  const agentClient = await login(agent.email, agent.password);
  const customerClient = await login(customer.email, customer.password);
  const current = await customerClient.request<{ chat: { id: string } }>("POST", "/chats/current");

  await agentClient.request("POST", "/files/upload-intents", {
    resourceType: "chat",
    resourceId: current.chat.id,
    name: "agent-before-claim.png",
    mimeType: "image/png",
    sizeBytes: 32,
  }, 403);

  await agentClient.request("POST", `/chats/${current.chat.id}/claim`);
  const upload = await agentClient.request<{ fileId: string; uploadUrl: string }>("POST", "/files/upload-intents", {
    resourceType: "chat",
    resourceId: current.chat.id,
    name: "agent-after-claim.png",
    mimeType: "image/png",
    sizeBytes: 32,
  });
  assert.ok(upload.fileId);
  assert.ok(upload.uploadUrl);

  await agentClient.request("POST", `/chats/${current.chat.id}/status`, { status: "resolved" });
  await agentClient.request("POST", "/files/upload-intents", {
    resourceType: "chat",
    resourceId: current.chat.id,
    name: "agent-after-resolved.png",
    mimeType: "image/png",
    sizeBytes: 32,
  }, 403);
});

test("idempotency request hashing is stable across JSON property order", async () => {
  const customer = await createUser(admin, "customer", "stable-idem");
  const customerClient = await login(customer.email, customer.password);
  const current = await customerClient.request<{ chat: { id: string } }>("POST", "/chats/current");

  const first = await customerClient.request<{ message: { id: string } }>("POST", `/chats/${current.chat.id}/messages`, {
    body: "same body",
    idempotencyKey: "stable-json-order",
  }, 201);
  const replay = await customerClient.request<{ message: { id: string } }>("POST", `/chats/${current.chat.id}/messages`, {
    idempotencyKey: "stable-json-order",
    body: "same body",
  });
  assert.equal(replay.message.id, first.message.id);
});

test("announcement patch clears stale targets and delete returns not found", async () => {
  const announcement = await admin.request<{ announcement: { id: string } }>("POST", "/announcements", {
    title: "Target cleanup",
    body: "body",
    targetType: "customer_tag",
    targetValues: ["vip"],
  }, 201);

  await admin.request("PATCH", `/announcements/${announcement.announcement.id}`, { targetType: "all_customers" });
  const targets = await db.select().from(schema.announcementTargets).where(eq(schema.announcementTargets.announcementId, announcement.announcement.id));
  assert.equal(targets.length, 0);

  await admin.request("DELETE", `/announcements/${randomUUID()}`, undefined, 404);
});

test("search treats LIKE wildcards as literal query text", async () => {
  const result = await admin.request<{ groups: Record<string, unknown[]> }>("GET", `/search?q=${encodeURIComponent("%%")}`);
  assert.equal(result.groups.users.length, 0);
  assert.equal(result.groups.reports.length, 0);
  assert.equal(result.groups.announcements.length, 0);
});

test("dashboard unassigned count excludes resolved and closed chats", async () => {
  const customer = await createUser(admin, "customer", "dashboard-unassigned");
  const customerClient = await login(customer.email, customer.password);
  const before = await admin.request<{ counts: { unassignedChats: number } }>("GET", "/admin/dashboard");
  const current = await customerClient.request<{ chat: { id: string } }>("POST", "/chats/current");
  const open = await admin.request<{ counts: { unassignedChats: number } }>("GET", "/admin/dashboard");
  assert.equal(open.counts.unassignedChats, before.counts.unassignedChats + 1);
  await admin.request("POST", `/chats/${current.chat.id}/status`, { status: "closed" });
  const closed = await admin.request<{ counts: { unassignedChats: number } }>("GET", "/admin/dashboard");
  assert.equal(closed.counts.unassignedChats, before.counts.unassignedChats);
});
