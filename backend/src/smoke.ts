const baseUrl = process.env.SMOKE_BASE_URL ?? "http://127.0.0.1:4000";
const adminEmail = process.env.SMOKE_ADMIN_EMAIL ?? "admin@evcomm.local";
const adminPassword = process.env.SMOKE_ADMIN_PASSWORD;
let ipCounter = 10;

if (!adminPassword) {
  throw new Error("SMOKE_ADMIN_PASSWORD is required.");
}

type Client = {
  cookies: string[];
  request: <T>(method: string, path: string, body?: unknown) => Promise<T>;
};

function createClient(): Client {
  const smokeIp = `127.10.${Math.floor(Math.random() * 200)}.${ipCounter++}`;
  const client: Client = {
    cookies: [],
    async request<T>(method: string, path: string, body?: unknown) {
      const response = await fetch(`${baseUrl}${path}`, {
        method,
        headers: {
          "content-type": "application/json",
          "x-forwarded-for": smokeIp,
          cookie: client.cookies.join("; "),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });

      const setCookie = response.headers.getSetCookie?.() ?? [];
      for (const cookie of setCookie) {
        const pair = cookie.split(";")[0];
        client.cookies = client.cookies.filter((stored) => stored.split("=")[0] !== pair.split("=")[0]);
        client.cookies.push(pair);
      }

      const text = await response.text();
      const data = text ? JSON.parse(text) : {};
      if (!response.ok) {
        throw new Error(`${method} ${path} failed ${response.status}: ${text}`);
      }
      return data as T;
    },
  };
  return client;
}

async function login(email: string, password: string) {
  const client = createClient();
  const loginResult = await client.request<{ requiresTwoFactor?: boolean; challengeId?: string; debugCode?: string; user?: { role: string } }>("POST", "/auth/login", {
    email,
    password,
  });

  if (loginResult.requiresTwoFactor) {
    if (!loginResult.challengeId || !loginResult.debugCode) throw new Error("2FA challenge did not include dev debug code.");
    await client.request("POST", "/auth/2fa/verify", { challengeId: loginResult.challengeId, code: loginResult.debugCode });
  }
  return client;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const runId = Date.now().toString(36);
const agentPassword = `Agent-${runId}-Password-123!`;
const secondAgentPassword = `Agent2-${runId}-Password-123!`;
const customerPassword = `Customer-${runId}-Password-123!`;
const resetPassword = `CustomerReset-${runId}-Password-123!`;
const agentEmail = `agent-${runId}@evcomm.local`;
const secondAgentEmail = `agent2-${runId}@evcomm.local`;
const customerEmail = `customer-${runId}@evcomm.local`;

const admin = await login(adminEmail, adminPassword);

const agent = await admin.request<{ user: { id: string } }>("POST", "/admin/users", {
  role: "agent",
  email: agentEmail,
  password: agentPassword,
  displayName: "Smoke Agent",
  skills: ["general_support"],
});
const secondAgent = await admin.request<{ user: { id: string } }>("POST", "/admin/users", {
  role: "agent",
  email: secondAgentEmail,
  password: secondAgentPassword,
  displayName: "Smoke Agent 2",
});
const registeredCustomer = await createClient().request<{ user: { id: string; status: string } }>("POST", "/auth/register", {
  email: customerEmail,
  password: customerPassword,
  displayName: "Smoke Customer",
});
assert(registeredCustomer.user.status === "pending_approval", "registered customer should require approval");
await admin.request("POST", `/admin/users/${registeredCustomer.user.id}/approve`);

const customer = await login(customerEmail, customerPassword);
const current = await customer.request<{ chat: { id: string; status: string } }>("POST", "/chats/current");
assert(current.chat.status === "open", "customer current chat should be open");

const firstMessage = await customer.request<{ message: { id: string } }>("POST", `/chats/${current.chat.id}/messages`, { body: "Smoke support request", idempotencyKey: `msg-${runId}` });
const duplicateMessage = await customer.request<{ message: { id: string } }>("POST", `/chats/${current.chat.id}/messages`, { body: "Smoke support request", idempotencyKey: `msg-${runId}` });
assert(firstMessage.message.id === duplicateMessage.message.id, "duplicate chat message should return existing message");

const agentClient = await login(agentEmail, agentPassword);
const claimed = await agentClient.request<{ chat: { assignedAgent: { id: string } } }>("POST", `/chats/${current.chat.id}/claim`);
assert(claimed.chat.assignedAgent.id === agent.user.id, "agent should claim chat");

const secondAgentClient = await login(secondAgentEmail, secondAgentPassword);
let secondClaimConflict = false;
try {
  await secondAgentClient.request("POST", `/chats/${current.chat.id}/claim`);
} catch (error) {
  secondClaimConflict = String(error).includes("409");
}
assert(secondClaimConflict, "second claim should conflict");

await agentClient.request("POST", `/chats/${current.chat.id}/messages`, { body: "Smoke agent reply", idempotencyKey: `agent-msg-${runId}` });
await agentClient.request("POST", `/chats/${current.chat.id}/status`, { status: "resolved" });
const reopened = await customer.request<{ chat: { status: string } }>("POST", `/chats/${current.chat.id}/messages`, {
  body: "Smoke reopen",
  idempotencyKey: `reopen-${runId}`,
});
assert(reopened.chat.status === "open", "customer message should reopen resolved chat");

await admin.request("POST", `/chats/${current.chat.id}/transfer`, { agentId: secondAgent.user.id });
await admin.request("POST", `/chats/${current.chat.id}/takeover`, { mode: "join" });

const upload = await customer.request<{ fileId: string; uploadUrl: string }>("POST", "/files/upload-intents", {
  resourceType: "chat",
  resourceId: current.chat.id,
  name: "smoke.png",
  mimeType: "image/png",
  sizeBytes: 128,
});
assert(upload.fileId && upload.uploadUrl.startsWith("http"), "upload intent should return signed URL");
await customer.request("POST", `/files/${upload.fileId}/complete`, { checksum: `smoke-${runId}` });
const fileMessage = await customer.request<{ message: { id: string } }>("POST", `/chats/${current.chat.id}/messages`, {
  body: "Smoke attachment",
  fileIds: [upload.fileId],
  idempotencyKey: `file-msg-${runId}`,
});
assert(fileMessage.message.id, "chat message should accept completed fileIds");
const chatDetail = await customer.request<{ messages: unknown[]; nextMessageCursor: string | null; chat: { availableActions: { delete_message: boolean } } }>("GET", `/chats/${current.chat.id}?limit=2`);
assert(chatDetail.messages.length <= 2 && "nextMessageCursor" in chatDetail, "chat detail should support message pagination");
assert(chatDetail.chat.availableActions.delete_message, "chat actions should include delete_message");

const report = await customer.request<{ report: { id: string } }>("POST", "/reports", {
  title: "Smoke report",
  category: "bug",
  description: "Smoke report body",
  evidenceMessageIds: [firstMessage.message.id],
  idempotencyKey: `report-${runId}`,
});
const duplicateReport = await customer.request<{ report: { id: string } }>("POST", "/reports", {
  title: "Smoke report",
  category: "bug",
  description: "Smoke report body",
  evidenceMessageIds: [firstMessage.message.id],
  idempotencyKey: `report-${runId}`,
});
assert(report.report.id === duplicateReport.report.id, "duplicate report should return existing report");
await admin.request("PATCH", `/reports/${report.report.id}/status`, { status: "reviewed", adminNotes: "Smoke reviewed" });
await admin.request("POST", `/reports/${report.report.id}/internal-comments`, { body: "Smoke internal comment" });
const reportList = await customer.request<{ items: Array<{ id: string; availableActions: { view_files: boolean } }> }>("GET", "/reports");
assert(reportList.items.some((item) => item.id === report.report.id && item.availableActions.view_files), "report list should include available actions");

const announcement = await admin.request<{ announcement: { id: string } }>("POST", "/announcements", {
  title: `Smoke announcement ${runId}`,
  body: "Smoke announcement body",
  targetType: "all_customers",
});
await admin.request("POST", `/announcements/${announcement.announcement.id}/publish`, {});
const announcements = await customer.request<{ items: Array<{ id: string }> }>("GET", "/announcements");
assert(announcements.items.some((item) => item.id === announcement.announcement.id), "customer should see published announcement");
await customer.request("POST", `/announcements/${announcement.announcement.id}/reactions`, { emoji: "ok" });
await customer.request("POST", `/announcements/${announcement.announcement.id}/comments`, { body: "Smoke comment" });

const teamMessage = await agentClient.request<{ message: { id: string } }>("POST", "/team/messages", {
  body: "Smoke team message",
  mentionUserIds: [secondAgent.user.id],
  idempotencyKey: `team-${runId}`,
});
const teamList = await secondAgentClient.request<{ items: Array<{ id: string }>; unreadCount: number }>("GET", "/team/messages");
assert(teamList.items.some((item) => item.id === teamMessage.message.id) && teamList.unreadCount >= 1, "team messages should list unread messages");
await secondAgentClient.request("POST", "/team/messages/read", { messageId: teamMessage.message.id });
await admin.request("DELETE", `/team/messages/${teamMessage.message.id}`);
const deletedTeamList = await admin.request<{ items: Array<{ id: string }> }>("GET", "/team/messages");
assert(!deletedTeamList.items.some((item) => item.id === teamMessage.message.id), "deleted team message should be hidden");

const search = await admin.request<{ groups: Record<string, unknown[]> }>("GET", `/search?q=${encodeURIComponent("Smoke")}`);
assert(Array.isArray(search.groups.announcements), "admin search should return grouped announcements");

const notifications = await customer.request<{ unreadCount: number }>("GET", "/notifications");
assert(typeof notifications.unreadCount === "number", "notifications should include unread count");
await customer.request("POST", "/notifications/read-all");

const reset = await customer.request<{ debugToken?: string }>("POST", "/auth/password-reset/request", { email: customerEmail });
assert(reset.debugToken, "dev password reset should return debug token");
await customer.request("POST", "/auth/password-reset/confirm", { token: reset.debugToken, password: resetPassword });
await login(customerEmail, resetPassword);

const sessions = await admin.request<{ items: unknown[] }>("GET", "/sessions");
assert(sessions.items.length > 0, "sessions should list current admin session");
const dashboard = await admin.request<{ counts: { openChats: number; pendingCustomers: number; resolvedToday: number } }>("GET", "/admin/dashboard");
assert(typeof dashboard.counts.openChats === "number", "admin dashboard should return counts");
assert(typeof dashboard.counts.pendingCustomers === "number", "admin dashboard should include pending customer count");
assert(typeof dashboard.counts.resolvedToday === "number", "admin dashboard should include resolved today count");
const agents = await admin.request<{ items: Array<{ availableActions: { suspend: boolean } }> }>("GET", "/admin/agents");
assert(agents.items.length > 0, "admin agents should list agents");
assert(typeof agents.items[0].availableActions.suspend === "boolean", "agent rows should include available actions");
const customers = await admin.request<{ items: Array<{ availableActions: { approve: boolean } }> }>("GET", "/admin/customers");
assert(customers.items.length > 0, "admin customers should list customers");
assert(typeof customers.items[0].availableActions.approve === "boolean", "customer rows should include available actions");
const settings = await admin.request<{ settings: { autoAssignmentEnabled: boolean } }>("GET", "/settings");
assert(typeof settings.settings.autoAssignmentEnabled === "boolean", "settings should return defaults");
await admin.request("PATCH", "/admin/settings", { defaultTimezone: "UTC", autoAssignmentEnabled: false });
const eventState = await admin.request<{ reconnect: { unreadNotifications: number } }>("GET", "/events/state");
assert(typeof eventState.reconnect.unreadNotifications === "number", "events state should return reconnect data");
const auditLogs = await admin.request<{ items: Array<{ action: string }> }>("GET", "/admin/audit-logs?action=team_message_deleted");
assert(auditLogs.items.some((item) => item.action === "team_message_deleted"), "audit log filters should return matching actions");

await admin.request("PATCH", `/admin/users/${secondAgent.user.id}`, { status: "suspended" });
let suspendedLoginForbidden = false;
try {
  await login(secondAgentEmail, secondAgentPassword);
} catch (error) {
  suspendedLoginForbidden = String(error).includes("403");
}
assert(suspendedLoginForbidden, "suspended agent should not be able to log in");
await admin.request("DELETE", `/admin/users/${secondAgent.user.id}/anonymize`);

console.log(
  JSON.stringify(
    {
      ok: true,
      created: { agent: agentEmail, secondAgent: secondAgentEmail, customer: customerEmail },
      checks: [
        "2fa",
        "password_reset",
        "sessions",
        "support_claim_reopen_transfer_takeover",
        "atomic_claim_conflict",
        "file_upload_intent_and_linking",
        "idempotency",
        "reports",
        "announcements",
        "notifications",
        "team_chat_read_delete_mentions",
        "audit_filters",
        "search",
        "suspension",
        "admin_dashboard",
        "settings",
        "sse_reconnect_state",
        "anonymization",
      ],
    },
    null,
    2,
  ),
);
