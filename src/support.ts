import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { and, count, desc, eq, inArray, isNull, lt, ne, or, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "./db.js";
import { actorKey, actorResourceKey, audit, fail, rateLimit, requireAuth, requireRole, withIdempotency, type Actor, type AppContext } from "./security.js";
import { chatAdminParticipants, chatAssignments, files, internalNotes, messageFiles, messageReads, messages, notifications, ratings, supportChats, users } from "./schema.js";
import { adminChannel, chatChannel, publishEvent, userChannel } from "./events.js";

const chatIdParam = z.object({ id: z.string().min(1) });
const messageSchema = z.object({
  body: z.string().trim().min(1).max(5000),
  fileIds: z.array(z.string().min(1)).max(10).optional(),
  idempotencyKey: z.string().min(8).max(120).optional(),
});
const noteSchema = z.object({ body: z.string().trim().min(1).max(5000), fileIds: z.array(z.string().min(1)).max(10).optional() });
const assignSchema = z.object({ agentId: z.string().min(1) });
const takeoverSchema = z.object({ mode: z.enum(["join", "takeover"]).default("join"), reassignToSelf: z.boolean().default(false) });
const readSchema = z.object({ messageId: z.string().optional() });
const chatDetailQuerySchema = z.object({ cursor: z.string().optional(), limit: z.coerce.number().int().min(1).max(100).default(50) });
const statusSchema = z.object({ status: z.enum(["open", "waiting", "resolved", "closed"]) });
const metaSchema = z.object({
  priority: z.enum(["normal", "high", "urgent"]).optional(),
  category: z.enum(["account", "billing", "technical_support", "general_support", "complaint", "other"]).optional(),
  tags: z.array(z.string().min(1).max(40)).max(20).optional(),
});
const ratingSchema = z.object({
  stars: z.number().int().min(1).max(5),
  comment: z.string().max(2000).optional(),
  idempotencyKey: z.string().min(8).max(120).optional(),
});

type ChatRow = typeof supportChats.$inferSelect;

function actorChannels(actor: Actor, chat: ChatRow) {
  const channels = [chatChannel(chat.id), userChannel(chat.customerId), adminChannel];
  if (chat.assignedAgentId) channels.push(userChannel(chat.assignedAgentId));
  if (actor.id !== chat.customerId) channels.push(userChannel(actor.id));
  return channels;
}

function availableChatActions(actor: Actor, chat: ChatRow) {
  const isAdmin = actor.role === "admin";
  const isAgentAssigned = actor.role === "agent" && chat.assignedAgentId === actor.id;
  const isCustomer = actor.role === "customer" && chat.customerId === actor.id;
  const openForMessages = chat.status !== "closed";

  return {
    send_message: openForMessages && (isAdmin || isAgentAssigned || isCustomer),
    send_internal_note: isAdmin || isAgentAssigned,
    claim: actor.role === "agent" && !chat.assignedAgentId && chat.status !== "closed",
    assign: isAdmin,
    reassign: isAdmin && Boolean(chat.assignedAgentId),
    transfer: isAgentAssigned,
    mark_waiting: (isAdmin || isAgentAssigned) && chat.status !== "closed",
    resolve: (isAdmin || isAgentAssigned) && chat.status !== "closed",
    close: isAdmin && chat.status !== "closed",
    reopen: isCustomer && chat.status === "resolved",
    delete_message: isAdmin || isAgentAssigned || isCustomer,
    upload_file: openForMessages && (isAdmin || isAgentAssigned || isCustomer),
    rate: isCustomer && chat.status === "resolved",
  };
}

async function getChatOrFail(id: string) {
  const [chat] = await db.select().from(supportChats).where(eq(supportChats.id, id)).limit(1);
  if (!chat) fail("NOT_FOUND", "Chat was not found.", 404);
  return chat;
}

function canViewChat(actor: Actor, chat: ChatRow) {
  if (actor.role === "admin") return true;
  if (actor.role === "customer") return chat.customerId === actor.id;
  return chat.assignedAgentId === actor.id || !chat.assignedAgentId;
}

function requireChatView(actor: Actor, chat: ChatRow) {
  if (!canViewChat(actor, chat)) fail("FORBIDDEN", "You do not have access to this chat.", 403);
}

function requireSupportWrite(actor: Actor, chat: ChatRow) {
  if (chat.status === "closed") fail("CONFLICT", "Closed chats cannot receive messages.", 409);
  if (actor.role === "admin") return;
  if (actor.role === "agent" && chat.assignedAgentId === actor.id) return;
  if (actor.role === "customer" && chat.customerId === actor.id) return;
  fail("FORBIDDEN", "You cannot write to this chat.", 403);
}

async function insertNotification(userId: string, type: string, resourceType: string, resourceId: string, title: string, body: string, dedupeKey?: string) {
  const id = randomUUID();
  await db
    .insert(notifications)
    .values({ id, userId, type, resourceType, resourceId, title, body, dedupeKey })
    .onConflictDoNothing();
  await publishEvent([userChannel(userId)], "notification:new", { resourceId: id, notificationId: id, resourceType });
}

async function buildChatResponse(actor: Actor, chat: ChatRow) {
  const [customer] = await db
    .select({ id: users.id, displayName: users.displayName, role: users.role, status: users.status })
    .from(users)
    .where(eq(users.id, chat.customerId))
    .limit(1);
  const [agent] = chat.assignedAgentId
    ? await db
        .select({ id: users.id, displayName: users.displayName, role: users.role, status: users.status })
        .from(users)
        .where(eq(users.id, chat.assignedAgentId))
        .limit(1)
    : [null];

  const [lastMessage] = chat.lastMessageId
    ? await db.select().from(messages).where(eq(messages.id, chat.lastMessageId)).limit(1)
    : [null];
  const [unread] = await db
    .select({ value: count() })
    .from(messages)
    .where(
      and(
        eq(messages.chatId, chat.id),
        actor.role === "customer" ? eq(messages.visibleToCustomer, true) : undefined,
        sql`${messages.senderId} is not ${actor.id}`,
        sql`not exists (select 1 from message_reads mr where mr.message_id = ${messages.id} and mr.user_id = ${actor.id})`,
      ),
    );

  return {
    id: chat.id,
    customer,
    status: chat.status,
    priority: chat.priority,
    category: chat.category,
    tags: chat.tags,
    assignedAgent: agent,
    supportCycle: chat.supportCycle,
    unreadCount: unread.value,
    lastMessagePreview: lastMessage?.deletedAt ? null : lastMessage?.body?.slice(0, 160) ?? null,
    lastActivityAt: chat.lastActivityAt,
    availableActions: availableChatActions(actor, chat),
  };
}

async function attachMessageFiles(messageRows: Array<typeof messages.$inferSelect>) {
  if (!messageRows.length) return [];
  const links = await db.select().from(messageFiles).where(inArray(messageFiles.messageId, messageRows.map((message) => message.id)));
  const fileRows = links.length ? await db.select().from(files).where(inArray(files.id, links.map((link) => link.fileId))) : [];
  return messageRows.map((message) => ({
    ...message,
    files: links.filter((link) => link.messageId === message.id).map((link) => fileRows.find((file) => file.id === link.fileId)).filter(Boolean),
  }));
}

async function assertAttachableFiles(actor: Actor, fileIds: string[] | undefined, resourceType: "chat" | "team" | "report" | "announcement", resourceId: string) {
  if (!fileIds?.length) return [];
  const rows = await db.select().from(files).where(inArray(files.id, fileIds));
  if (rows.length !== fileIds.length) fail("VALIDATION_ERROR", "One or more files were not found.", 400);
  for (const file of rows) {
    if (file.ownerId !== actor.id && actor.role !== "admin") fail("FORBIDDEN", "You can only attach files you uploaded.", 403);
    if (file.status !== "ready") fail("CONFLICT", "Only completed files can be attached.", 409);
    if (file.resourceType && (file.resourceType !== resourceType || file.resourceId !== resourceId)) {
      fail("CONFLICT", "File is already attached to another resource.", 409);
    }
  }
  return rows;
}

async function assignChat(actor: Actor, chat: ChatRow, agentId: string, requestId: string | undefined, reason: "admin_assign" | "transfer") {
  if (chat.status === "closed") fail("CONFLICT", "Closed chats cannot be assigned.", 409);

  const [agent] = await db.select().from(users).where(and(eq(users.id, agentId), eq(users.role, "agent"), eq(users.status, "active"))).limit(1);
  if (!agent) fail("VALIDATION_ERROR", "Target agent is not active.", 400);

  await db.transaction(async (tx) => {
    await tx.update(chatAssignments).set({ endedAt: new Date().toISOString() }).where(and(eq(chatAssignments.chatId, chat.id), isNull(chatAssignments.endedAt)));
    await tx.update(supportChats).set({ assignedAgentId: agentId, updatedAt: new Date().toISOString() }).where(eq(supportChats.id, chat.id));
    await tx.insert(chatAssignments).values({ id: randomUUID(), chatId: chat.id, agentId, assignedBy: actor.id, reason });
  });

  if (chat.assignedAgentId && chat.assignedAgentId !== agentId) {
    await insertNotification(chat.assignedAgentId, "chat_reassigned", "chat", chat.id, "Chat reassigned", "A chat was reassigned away from you.");
  }
  await insertNotification(agentId, "chat_assigned", "chat", chat.id, "Chat assigned", "A support chat was assigned to you.");
  await audit(actor, chat.assignedAgentId ? "chat_reassigned" : "chat_assigned", "chat", chat.id, { from: chat.assignedAgentId, to: agentId, reason }, requestId);

  const updated = await getChatOrFail(chat.id);
  await publishEvent(actorChannels(actor, updated), chat.assignedAgentId ? "chat:reassigned" : "chat:assigned", {
    resourceId: chat.id,
    chatId: chat.id,
    oldAgentId: chat.assignedAgentId,
    agentId,
    actor,
  });
  return updated;
}

export function registerSupportRoutes(app: Hono) {
  app.get("/chats", requireAuth, async (c: AppContext) => {
    const actor = c.get("actor");
    const status = c.req.query("status");
    const cursor = c.req.query("cursor");
    const limit = Math.min(Number(c.req.query("limit") ?? 30), 100);

    const filters = [];
    if (actor.role === "customer") filters.push(eq(supportChats.customerId, actor.id));
    if (actor.role === "agent") {
      filters.push(or(eq(supportChats.assignedAgentId, actor.id), isNull(supportChats.assignedAgentId))!);
    }
    if (status) filters.push(eq(supportChats.status, status as ChatRow["status"]));
    if (cursor) filters.push(lt(supportChats.lastActivityAt, cursor));

    const rows = await db
      .select()
      .from(supportChats)
      .where(filters.length ? and(...filters) : undefined)
      .orderBy(desc(supportChats.lastActivityAt))
      .limit(limit + 1);

    const items = await Promise.all(rows.slice(0, limit).map((chat) => buildChatResponse(actor, chat)));
    return c.json({ items, nextCursor: rows.length > limit ? rows[limit - 1]?.lastActivityAt : null });
  });

  app.post("/chats/current", requireAuth, requireRole("customer"), async (c: AppContext) => {
    const actor = c.get("actor");
    const id = randomUUID();
    await db.insert(supportChats).values({ id, customerId: actor.id }).onConflictDoNothing();
    const [chat] = await db.select().from(supportChats).where(eq(supportChats.customerId, actor.id)).limit(1);
    return c.json({ chat: await buildChatResponse(actor, chat) });
  });

  app.get("/chats/:id", requireAuth, async (c: AppContext) => {
    const actor = c.get("actor");
    const { id } = chatIdParam.parse(c.req.param());
    const query = chatDetailQuerySchema.parse({ cursor: c.req.query("cursor"), limit: c.req.query("limit") ?? 50 });
    const chat = await getChatOrFail(id);
    requireChatView(actor, chat);

    const messageRows = await db
      .select()
      .from(messages)
      .where(and(eq(messages.chatId, id), actor.role === "customer" ? eq(messages.visibleToCustomer, true) : undefined, query.cursor ? lt(messages.createdAt, query.cursor) : undefined))
      .orderBy(desc(messages.createdAt))
      .limit(query.limit + 1);

    const notes =
      actor.role === "customer"
        ? []
        : await db.select().from(internalNotes).where(eq(internalNotes.chatId, id)).orderBy(desc(internalNotes.createdAt)).limit(50);

    return c.json({
      chat: await buildChatResponse(actor, chat),
      messages: await attachMessageFiles(messageRows.slice(0, query.limit)),
      nextMessageCursor: messageRows.length > query.limit ? messageRows[query.limit - 1]?.createdAt : null,
      internalNotes: notes,
    });
  });

  app.post("/chats/:id/messages", requireAuth, rateLimit({ scope: "chat.message", limit: 60, windowSeconds: 60, key: actorResourceKey() }), async (c: AppContext) => {
    const actor = c.get("actor");
    const { id } = chatIdParam.parse(c.req.param());
    const body = messageSchema.parse(await c.req.json());
    const chat = await getChatOrFail(id);
    requireSupportWrite(actor, chat);

    const { value, replayed } = await withIdempotency(actor, "chat.message", body.idempotencyKey, { chatId: id, ...body }, async () => {
      await assertAttachableFiles(actor, body.fileIds, "chat", id);

      let updatedChat = chat;
      const messageId = randomUUID();
      const now = new Date().toISOString();
      const reopened = actor.role === "customer" && chat.status === "resolved";

      await db.transaction(async (tx) => {
        await tx.insert(messages).values({
          id: messageId,
          chatId: id,
          senderId: actor.id,
          body: body.body,
          visibleToCustomer: true,
          idempotencyKey: body.idempotencyKey,
        });

        for (const fileId of body.fileIds ?? []) {
          await tx.update(files).set({ resourceType: "chat", resourceId: id }).where(eq(files.id, fileId));
          await tx.insert(messageFiles).values({ messageId, fileId }).onConflictDoNothing();
        }

        const patch: Partial<typeof supportChats.$inferInsert> = {
          lastMessageId: messageId,
          lastActivityAt: now,
          updatedAt: now,
        };
        if (reopened) {
          patch.status = "open";
          patch.supportCycle = chat.supportCycle + 1;
        }

        await tx.update(supportChats).set(patch).where(eq(supportChats.id, id));
      });

      updatedChat = await getChatOrFail(id);

      if (reopened) {
        await audit(actor, "chat_reopened", "chat", id, {}, c.get("requestId"));
        await publishEvent(actorChannels(actor, updatedChat), "chat:reopened", { resourceId: id, chatId: id, supportCycle: updatedChat.supportCycle });
      }

      if (actor.role === "customer" && updatedChat.assignedAgentId) {
        await insertNotification(updatedChat.assignedAgentId, "new_customer_message", "chat", id, "New customer message", body.body.slice(0, 140));
      }
      if (actor.role !== "customer") {
        await insertNotification(updatedChat.customerId, "new_agent_reply", "chat", id, "Support replied", body.body.slice(0, 140));
      }

      await publishEvent(actorChannels(actor, updatedChat), "message:new", { resourceId: messageId, chatId: id, messageId, actor });
      const [message] = await db.select().from(messages).where(eq(messages.id, messageId)).limit(1);
      return { message, chat: await buildChatResponse(actor, updatedChat) };
    });
    return c.json(value, replayed ? 200 : 201);
  });

  app.post("/chats/:id/internal-notes", requireAuth, requireRole("admin", "agent"), async (c: AppContext) => {
    const actor = c.get("actor");
    const { id } = chatIdParam.parse(c.req.param());
    const body = noteSchema.parse(await c.req.json());
    const chat = await getChatOrFail(id);
    if (!(actor.role === "admin" || chat.assignedAgentId === actor.id)) fail("FORBIDDEN", "You cannot add internal notes to this chat.", 403);
    await assertAttachableFiles(actor, body.fileIds, "chat", id);

    const noteId = randomUUID();
    await db.transaction(async (tx) => {
      await tx.insert(internalNotes).values({ id: noteId, chatId: id, authorId: actor.id, body: body.body });
      for (const fileId of body.fileIds ?? []) {
        await tx.update(files).set({ resourceType: "chat", resourceId: id }).where(eq(files.id, fileId));
      }
    });
    await audit(actor, "internal_note_added", "chat", id, {}, c.get("requestId"));
    await publishEvent(actorChannels(actor, chat), "message:new", { resourceId: noteId, chatId: id, messageId: noteId, internal: true, actor });
    const [note] = await db.select().from(internalNotes).where(eq(internalNotes.id, noteId)).limit(1);
    return c.json({ note }, 201);
  });

  app.delete("/messages/:id", requireAuth, async (c: AppContext) => {
    const actor = c.get("actor");
    const messageId = z.string().min(1).parse(c.req.param("id"));
    const [message] = await db.select().from(messages).where(eq(messages.id, messageId)).limit(1);
    if (!message) fail("NOT_FOUND", "Message was not found.", 404);
    const chat = await getChatOrFail(message.chatId);
    requireChatView(actor, chat);
    const canDelete = actor.role === "admin" || message.senderId === actor.id || (actor.role === "agent" && chat.assignedAgentId === actor.id);
    if (!canDelete) fail("FORBIDDEN", "You cannot delete this message.", 403);

    await db.update(messages).set({ deletedAt: new Date().toISOString() }).where(eq(messages.id, messageId));
    await audit(actor, "message_deleted", "message", messageId, { chatId: chat.id }, c.get("requestId"));
    await publishEvent(actorChannels(actor, chat), "message:deleted", { resourceId: messageId, chatId: chat.id, messageId, actor });
    const [updated] = await db.select().from(messages).where(eq(messages.id, messageId)).limit(1);
    return c.json({ message: updated });
  });

  app.post("/chats/:id/read", requireAuth, async (c: AppContext) => {
    const actor = c.get("actor");
    const { id } = chatIdParam.parse(c.req.param());
    const body = readSchema.parse(await c.req.json().catch(() => ({})));
    const chat = await getChatOrFail(id);
    requireChatView(actor, chat);

    const messageId = body.messageId ?? chat.lastMessageId;
    if (!messageId) return c.json({ ok: true, unreadCount: 0 });
    await db.insert(messageReads).values({ messageId, userId: actor.id }).onConflictDoUpdate({
      target: [messageReads.messageId, messageReads.userId],
      set: { readAt: new Date().toISOString() },
    });
    await publishEvent(actorChannels(actor, chat), "read:receipt", { resourceId: id, chatId: id, messageId, userId: actor.id });
    return c.json({ ok: true, unreadCount: 0 });
  });

  app.post("/chats/:id/typing", requireAuth, rateLimit({ scope: "chat.typing", limit: 30, windowSeconds: 60, key: actorResourceKey() }), async (c: AppContext) => {
    const actor = c.get("actor");
    const { id } = chatIdParam.parse(c.req.param());
    const chat = await getChatOrFail(id);
    requireChatView(actor, chat);
    const body = z.object({ isTyping: z.boolean().default(true) }).parse(await c.req.json().catch(() => ({})));
    await publishEvent(actorChannels(actor, chat), "typing:update", {
      resourceId: id,
      chatId: id,
      userId: actor.id,
      isTyping: body.isTyping,
      expiresAt: new Date(Date.now() + 5000).toISOString(),
    });
    return c.json({ ok: true });
  });

  app.post("/chats/:id/claim", requireAuth, requireRole("agent"), rateLimit({ scope: "chat.claim", limit: 30, windowSeconds: 60, key: actorKey }), async (c: AppContext) => {
    const actor = c.get("actor");
    const { id } = chatIdParam.parse(c.req.param());
    const now = new Date().toISOString();

    const rows = await db
      .update(supportChats)
      .set({ assignedAgentId: actor.id, updatedAt: now })
      .where(and(eq(supportChats.id, id), isNull(supportChats.assignedAgentId), ne(supportChats.status, "closed")))
      .returning();

    if (!rows[0]) fail("CONFLICT", "This chat is no longer available to claim.", 409);
    await db.insert(chatAssignments).values({ id: randomUUID(), chatId: id, agentId: actor.id, assignedBy: actor.id, reason: "claim" });
    await audit(actor, "chat_assigned", "chat", id, { agentId: actor.id, reason: "claim" }, c.get("requestId"));
    await insertNotification(actor.id, "chat_assigned", "chat", id, "Chat assigned", "You claimed a support chat.", `chat-assigned:${id}:${actor.id}`);
    await publishEvent(actorChannels(actor, rows[0]), "chat:assigned", { resourceId: id, chatId: id, agentId: actor.id, actor });
    return c.json({ chat: await buildChatResponse(actor, rows[0]) });
  });

  app.post("/chats/:id/assign", requireAuth, requireRole("admin"), async (c: AppContext) => {
    const actor = c.get("actor");
    const { id } = chatIdParam.parse(c.req.param());
    const body = assignSchema.parse(await c.req.json());
    const chat = await getChatOrFail(id);
    const updated = await assignChat(actor, chat, body.agentId, c.get("requestId"), "admin_assign");
    return c.json({ chat: await buildChatResponse(actor, updated) });
  });

  app.post("/chats/:id/transfer", requireAuth, requireRole("admin", "agent"), async (c: AppContext) => {
    const actor = c.get("actor");
    const { id } = chatIdParam.parse(c.req.param());
    const body = assignSchema.parse(await c.req.json());
    const chat = await getChatOrFail(id);
    if (actor.role === "agent" && chat.assignedAgentId !== actor.id) fail("FORBIDDEN", "Only the assigned agent can transfer this chat.", 403);
    const updated = await assignChat(actor, chat, body.agentId, c.get("requestId"), "transfer");
    return c.json({ chat: await buildChatResponse(actor, updated) });
  });

  app.post("/chats/:id/takeover", requireAuth, requireRole("admin"), async (c: AppContext) => {
    const actor = c.get("actor");
    const { id } = chatIdParam.parse(c.req.param());
    const body = takeoverSchema.parse(await c.req.json().catch(() => ({})));
    const chat = await getChatOrFail(id);
    const takeoverId = randomUUID();

    await db.insert(chatAdminParticipants).values({ id: takeoverId, chatId: id, adminId: actor.id, mode: body.mode });
    let updated = chat;
    if (body.reassignToSelf) {
      await db.update(supportChats).set({ assignedAgentId: null, updatedAt: new Date().toISOString() }).where(eq(supportChats.id, id));
      updated = await getChatOrFail(id);
    }
    if (chat.assignedAgentId) await insertNotification(chat.assignedAgentId, "admin_takeover", "chat", id, "Support lead joined", "An admin joined or took over this chat.");
    await audit(actor, "admin_takeover", "chat", id, { mode: body.mode, reassignToSelf: body.reassignToSelf }, c.get("requestId"));
    await publishEvent(actorChannels(actor, updated), "chat:status_changed", { resourceId: id, chatId: id, takeoverId, mode: body.mode, actor });
    return c.json({ chat: await buildChatResponse(actor, updated) });
  });

  app.post("/chats/:id/status", requireAuth, requireRole("admin", "agent"), async (c: AppContext) => {
    const actor = c.get("actor");
    const { id } = chatIdParam.parse(c.req.param());
    const body = statusSchema.parse(await c.req.json());
    const chat = await getChatOrFail(id);
    if (actor.role === "agent" && chat.assignedAgentId !== actor.id) fail("FORBIDDEN", "Only the assigned agent can update status.", 403);
    if (body.status === "closed" && actor.role !== "admin") fail("FORBIDDEN", "Only admins can close chats.", 403);
    if (chat.status === "closed" && actor.role !== "admin") fail("CONFLICT", "Closed chats cannot be changed by agents.", 409);

    await db.update(supportChats).set({ status: body.status, closedAt: body.status === "closed" ? new Date().toISOString() : null, updatedAt: new Date().toISOString() }).where(eq(supportChats.id, id));
    await audit(actor, body.status === "resolved" ? "chat_resolved" : body.status === "closed" ? "chat_closed" : "chat_status_changed", "chat", id, { from: chat.status, to: body.status }, c.get("requestId"));
    const updated = await getChatOrFail(id);
    if (body.status === "resolved") await insertNotification(chat.customerId, "chat_resolved", "chat", id, "Support chat resolved", "Your support chat was marked resolved.");
    await publishEvent(actorChannels(actor, updated), body.status === "resolved" ? "chat:resolved" : "chat:status_changed", { resourceId: id, chatId: id, status: body.status, actor });
    return c.json({ chat: await buildChatResponse(actor, updated) });
  });

  app.patch("/chats/:id/meta", requireAuth, requireRole("admin", "agent"), async (c: AppContext) => {
    const actor = c.get("actor");
    const { id } = chatIdParam.parse(c.req.param());
    const body = metaSchema.parse(await c.req.json());
    const chat = await getChatOrFail(id);
    if (actor.role === "agent" && chat.assignedAgentId !== actor.id) fail("FORBIDDEN", "Only the assigned agent can update chat metadata.", 403);
    await db.update(supportChats).set({ ...body, updatedAt: new Date().toISOString() }).where(eq(supportChats.id, id));
    await audit(actor, "chat_meta_changed", "chat", id, body, c.get("requestId"));
    const updated = await getChatOrFail(id);
    await publishEvent(actorChannels(actor, updated), "chat:status_changed", { resourceId: id, chatId: id, actor });
    return c.json({ chat: await buildChatResponse(actor, updated) });
  });

  app.post("/chats/:id/ratings", requireAuth, requireRole("customer"), rateLimit({ scope: "chat.rating", limit: 10, windowSeconds: 60 * 60, key: actorKey }), async (c: AppContext) => {
    const actor = c.get("actor");
    const { id } = chatIdParam.parse(c.req.param());
    const body = ratingSchema.parse(await c.req.json());
    const chat = await getChatOrFail(id);
    if (chat.customerId !== actor.id) fail("FORBIDDEN", "You can only rate your own support chat.", 403);
    if (chat.status !== "resolved") fail("CONFLICT", "Support can only be rated after it is resolved.", 409);
    const [existing] = await db
      .select()
      .from(ratings)
      .where(and(eq(ratings.chatId, id), eq(ratings.supportCycle, chat.supportCycle), eq(ratings.customerId, actor.id)))
      .limit(1);
    if (existing) fail("CONFLICT", "This support cycle has already been rated.", 409, { ratingId: existing.id });

    const ratingId = randomUUID();
    await db.insert(ratings).values({
      id: ratingId,
      chatId: id,
      supportCycle: chat.supportCycle,
      customerId: actor.id,
      agentId: chat.assignedAgentId,
      stars: body.stars,
      comment: body.comment,
      idempotencyKey: body.idempotencyKey,
    });
    if (chat.assignedAgentId) await insertNotification(chat.assignedAgentId, "rating_received", "rating", ratingId, "New support rating", `${body.stars} star rating received.`);
    const [rating] = await db.select().from(ratings).where(eq(ratings.id, ratingId)).limit(1);
    return c.json({ rating }, 201);
  });
}
