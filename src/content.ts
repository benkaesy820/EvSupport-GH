import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { and, count, desc, eq, inArray, isNull, like, lt, or, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "./db.js";
import {
  announcementComments,
  announcementFiles,
  announcementReactions,
  announcementTargets,
  announcements,
  auditLogs,
  customers,
  files,
  messages,
  notifications,
  reportFiles,
  reportInternalComments,
  reports,
  supportChats,
  systemSettings,
  teamMessageFiles,
  teamMessageReads,
  teamMessages,
  users,
} from "./schema.js";
import { actorKey, audit, fail, rateLimit, requireAuth, requireRole, withIdempotency, type AppContext } from "./security.js";
import { adminChannel, publishEvent, teamChannel, userChannel } from "./events.js";

const cursorSchema = z.object({ cursor: z.string().optional(), limit: z.coerce.number().int().min(1).max(100).default(30) });
const announcementSchema = z.object({
  title: z.string().trim().min(1).max(160),
  body: z.string().trim().min(1).max(10000),
  targetType: z.enum(["all_customers", "customer_tag", "category"]).default("all_customers"),
  targetValues: z.array(z.string().min(1).max(80)).max(50).optional(),
  fileIds: z.array(z.string().min(1)).max(10).optional(),
});
const publishSchema = z.object({ scheduledFor: z.string().datetime().optional() });
const announcementPatchSchema = announcementSchema.partial();
const reactionSchema = z.object({ emoji: z.string().min(1).max(16) });
const commentSchema = z.object({ body: z.string().trim().min(1).max(2000) });
const reportSchema = z.object({
  title: z.string().trim().min(1).max(160),
  category: z.enum(["bug", "complaint", "account_issue", "support_issue", "general_feedback", "other"]),
  description: z.string().trim().min(1).max(10000),
  fileIds: z.array(z.string().min(1)).max(10).optional(),
  evidenceMessageIds: z.array(z.string().min(1)).max(20).optional(),
  idempotencyKey: z.string().min(8).max(120).optional(),
});
const reportStatusSchema = z.object({
  status: z.enum(["pending", "reviewed", "resolved", "dismissed"]),
  adminNotes: z.string().max(5000).optional(),
});
const teamMessageSchema = z.object({
  body: z.string().trim().min(1).max(5000),
  fileIds: z.array(z.string().min(1)).max(10).optional(),
  mentionUserIds: z.array(z.string().min(1)).max(20).optional(),
  idempotencyKey: z.string().min(8).max(120).optional(),
});
const teamReadSchema = z.object({ messageId: z.string().optional() });
const searchSchema = z.object({ q: z.string().trim().min(2).max(120), limit: z.coerce.number().int().min(1).max(25).default(10) });
const internalCommentSchema = z.object({ body: z.string().trim().min(1).max(5000) });
const settingsSchema = z.record(z.union([z.string(), z.number(), z.boolean(), z.array(z.string()), z.record(z.unknown())]));

function announcementActions(role: string, status: string) {
  return {
    edit: role === "admin" && ["draft", "scheduled"].includes(status),
    publish: role === "admin" && ["draft", "scheduled"].includes(status),
    schedule: role === "admin" && status === "draft",
    delete: role === "admin" && status !== "deleted",
    react: role === "customer" && status === "published",
    comment: role === "customer" && status === "published",
  };
}

async function unreadNotifications(userId: string) {
  const [row] = await db.select({ value: count() }).from(notifications).where(and(eq(notifications.userId, userId), isNull(notifications.readAt)));
  return row.value;
}

async function assertAttachableFiles(actorId: string, fileIds: string[] | undefined, resourceType: "announcement" | "report" | "team", resourceId: string) {
  if (!fileIds?.length) return;
  const rows = await db.select().from(files).where(inArray(files.id, fileIds));
  if (rows.length !== fileIds.length) fail("VALIDATION_ERROR", "One or more files were not found.", 400);
  for (const file of rows) {
    if (file.ownerId !== actorId) fail("FORBIDDEN", "You can only attach files you uploaded.", 403);
    if (file.status !== "ready") fail("CONFLICT", "Only completed files can be attached.", 409);
    if (file.resourceType && (file.resourceType !== resourceType || file.resourceId !== resourceId)) fail("CONFLICT", "File is already attached to another resource.", 409);
  }
}

async function customerAnnouncementVisible(userId: string, announcement: typeof announcements.$inferSelect) {
  if (announcement.status !== "published") return false;
  if (announcement.targetType === "all_customers") return true;
  const targets = await db.select().from(announcementTargets).where(eq(announcementTargets.announcementId, announcement.id));
  const values = new Set(targets.map((target) => target.targetValue));
  if (!values.size) return false;
  if (announcement.targetType === "customer_tag") {
    const [profile] = await db.select().from(customers).where(eq(customers.userId, userId)).limit(1);
    return Boolean(profile?.tags.some((tag) => values.has(tag)));
  }
  const chats = await db.select({ category: supportChats.category }).from(supportChats).where(eq(supportChats.customerId, userId)).limit(1);
  return Boolean(chats[0] && values.has(chats[0].category));
}

async function targetedCustomerIds(announcement: typeof announcements.$inferSelect) {
  const customerRows = await db.select({ userId: customers.userId, tags: customers.tags }).from(customers);
  const targets = await db.select().from(announcementTargets).where(eq(announcementTargets.announcementId, announcement.id));
  const values = new Set(targets.map((target) => target.targetValue));
  const ids: string[] = [];
  for (const customer of customerRows) {
    if (announcement.targetType === "all_customers" || (await customerAnnouncementVisible(customer.userId, announcement))) ids.push(customer.userId);
  }
  return ids;
}

async function notification(userId: string, type: string, resourceType: string, resourceId: string, title: string, body: string, dedupeKey?: string) {
  const id = randomUUID();
  await db.insert(notifications).values({ id, userId, type, resourceType, resourceId, title, body, dedupeKey }).onConflictDoNothing();
  await publishEvent([userChannel(userId)], "notification:new", { resourceId: id, notificationId: id, resourceType });
}

async function announcementFileRows(announcementId: string) {
  const links = await db.select().from(announcementFiles).where(eq(announcementFiles.announcementId, announcementId));
  return links.length ? await db.select().from(files).where(inArray(files.id, links.map((link) => link.fileId))) : [];
}

async function teamMessageFileRows(messageId: string) {
  const links = await db.select().from(teamMessageFiles).where(eq(teamMessageFiles.messageId, messageId));
  return links.length ? await db.select().from(files).where(inArray(files.id, links.map((link) => link.fileId))) : [];
}

function reportActions(role: string) {
  return {
    update_status: role === "admin",
    view_files: role === "admin" || role === "customer",
    comment_internal: role === "admin",
  };
}

async function reportFileRows(reportId: string) {
  const links = await db.select().from(reportFiles).where(eq(reportFiles.reportId, reportId));
  return links.length ? await db.select().from(files).where(inArray(files.id, links.map((link) => link.fileId))) : [];
}

async function teamUnreadCount(userId: string) {
  const [row] = await db
    .select({ value: count() })
    .from(teamMessages)
    .where(
      and(
        isNull(teamMessages.deletedAt),
        sql`${teamMessages.senderId} is not ${userId}`,
        sql`not exists (select 1 from team_message_reads tmr where tmr.message_id = ${teamMessages.id} and tmr.user_id = ${userId})`,
      ),
    );
  return row.value;
}

export function registerContentRoutes(app: Hono) {
  app.get("/settings", requireAuth, async (c: AppContext) => {
    const rows = await db.select().from(systemSettings);
    const settings = Object.fromEntries(rows.map((row) => [row.key, row.value]));
    return c.json({
      settings: {
        maxFileSize: settings.maxFileSize ?? 10 * 1024 * 1024,
        allowedFileTypes: settings.allowedFileTypes ?? [
          "image/jpeg",
          "image/png",
          "image/gif",
          "application/pdf",
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        ],
        emailNotificationsEnabled: settings.emailNotificationsEnabled ?? true,
        supportAvailability: settings.supportAvailability ?? {},
        defaultTimezone: settings.defaultTimezone ?? "UTC",
        queueBehavior: settings.queueBehavior ?? "manual",
        autoAssignmentEnabled: settings.autoAssignmentEnabled ?? false,
        quickReplies: settings.quickReplies ?? [
          "Thanks for reaching out. I am checking this now.",
          "Could you share a screenshot or file that shows the issue?",
          "This is resolved on our side. Please confirm when you have a moment.",
        ],
      },
    });
  });

  app.patch("/admin/settings", requireAuth, requireRole("admin"), async (c: AppContext) => {
    const actor = c.get("actor");
    const body = settingsSchema.parse(await c.req.json());
    for (const [key, value] of Object.entries(body)) {
      await db.insert(systemSettings).values({ key, value, updatedBy: actor.id, updatedAt: new Date().toISOString() }).onConflictDoUpdate({
        target: systemSettings.key,
        set: { value, updatedBy: actor.id, updatedAt: new Date().toISOString() },
      });
    }
    await audit(actor, "settings_changed", "system_settings", "global", { keys: Object.keys(body) }, c.get("requestId"));
    return c.json({ ok: true });
  });

  app.get("/announcements", requireAuth, async (c: AppContext) => {
    const actor = c.get("actor");
    const query = cursorSchema.parse({ cursor: c.req.query("cursor"), limit: c.req.query("limit") ?? 30 });
    const filters = [];
    if (actor.role === "customer") filters.push(eq(announcements.status, "published"));
    if (actor.role !== "admin") filters.push(sql`${announcements.status} != 'deleted'`);
    if (query.cursor) filters.push(lt(announcements.createdAt, query.cursor));

    const rows = await db.select().from(announcements).where(filters.length ? and(...filters) : undefined).orderBy(desc(announcements.createdAt)).limit(query.limit + 1);
    const visibleRows = [];
    for (const row of rows) {
      if (actor.role !== "customer" || (await customerAnnouncementVisible(actor.id, row))) visibleRows.push(row);
      if (visibleRows.length >= query.limit) break;
    }
    const items = await Promise.all(
      visibleRows.map(async (item) => {
        const reactionRows = await db
          .select({ emoji: announcementReactions.emoji, total: count() })
          .from(announcementReactions)
          .where(eq(announcementReactions.announcementId, item.id))
          .groupBy(announcementReactions.emoji);
        const [commentCount] = await db.select({ value: count() }).from(announcementComments).where(and(eq(announcementComments.announcementId, item.id), isNull(announcementComments.deletedAt)));
        return {
          ...item,
          files: await announcementFileRows(item.id),
          commentCount: commentCount.value,
          reactionCounts: Object.fromEntries(reactionRows.map((r) => [r.emoji, r.total])),
          availableActions: announcementActions(actor.role, item.status),
        };
      }),
    );
    return c.json({ items, nextCursor: rows.length > query.limit ? rows[query.limit - 1]?.createdAt : null });
  });

  app.post("/announcements", requireAuth, requireRole("admin"), rateLimit({ scope: "announcements.create", limit: 30, windowSeconds: 60 * 60, key: actorKey }), async (c: AppContext) => {
    const actor = c.get("actor");
    const body = announcementSchema.parse(await c.req.json());
    const id = randomUUID();
    await assertAttachableFiles(actor.id, body.fileIds, "announcement", id);
    await db.transaction(async (tx) => {
      await tx.insert(announcements).values({ id, authorId: actor.id, title: body.title, body: body.body, targetType: body.targetType });
      for (const targetValue of body.targetValues ?? []) await tx.insert(announcementTargets).values({ announcementId: id, targetValue }).onConflictDoNothing();
      for (const fileId of body.fileIds ?? []) {
        await tx.update(files).set({ resourceType: "announcement", resourceId: id }).where(eq(files.id, fileId));
        await tx.insert(announcementFiles).values({ announcementId: id, fileId }).onConflictDoNothing();
      }
    });
    await audit(actor, "announcement_created", "announcement", id, {}, c.get("requestId"));
    const [announcement] = await db.select().from(announcements).where(eq(announcements.id, id)).limit(1);
    return c.json({ announcement: { ...announcement, availableActions: announcementActions(actor.role, announcement.status) } }, 201);
  });

  app.post("/announcements/:id/publish", requireAuth, requireRole("admin"), rateLimit({ scope: "announcements.publish", limit: 30, windowSeconds: 60 * 60, key: actorKey }), async (c: AppContext) => {
    const actor = c.get("actor");
    const id = z.string().min(1).parse(c.req.param("id"));
    const body = publishSchema.parse(await c.req.json().catch(() => ({})));
    const [announcement] = await db.select().from(announcements).where(eq(announcements.id, id)).limit(1);
    if (!announcement || announcement.status === "deleted") fail("NOT_FOUND", "Announcement was not found.", 404);

    const now = new Date();
    if (body.scheduledFor) {
      const scheduled = new Date(body.scheduledFor);
      if (scheduled.getTime() <= now.getTime()) fail("VALIDATION_ERROR", "Scheduled publish time must be in the future.", 400);
      await db.update(announcements).set({ status: "scheduled", scheduledFor: scheduled.toISOString(), updatedAt: now.toISOString() }).where(eq(announcements.id, id));
      await audit(actor, "announcement_scheduled", "announcement", id, { scheduledFor: scheduled.toISOString() }, c.get("requestId"));
      return c.json({ announcement: { ...(await db.select().from(announcements).where(eq(announcements.id, id)).limit(1))[0], availableActions: announcementActions(actor.role, "scheduled") } });
    }

    await db.update(announcements).set({ status: "published", publishedAt: now.toISOString(), updatedAt: now.toISOString() }).where(eq(announcements.id, id));
    await audit(actor, "announcement_published", "announcement", id, {}, c.get("requestId"));
    for (const userId of await targetedCustomerIds({ ...announcement, status: "published" })) {
      await notification(userId, "announcement_published", "announcement", id, "New announcement", announcement.title, `announcement:${id}:${userId}`);
    }
    await publishEvent([adminChannel], "announcement:published", { resourceId: id, announcementId: id, title: announcement.title, actor });
    const [published] = await db.select().from(announcements).where(eq(announcements.id, id)).limit(1);
    return c.json({ announcement: { ...published, availableActions: announcementActions(actor.role, published.status) } });
  });

  app.patch("/announcements/:id", requireAuth, requireRole("admin"), async (c: AppContext) => {
    const actor = c.get("actor");
    const id = z.string().min(1).parse(c.req.param("id"));
    const body = announcementPatchSchema.parse(await c.req.json());
    const [announcement] = await db.select().from(announcements).where(eq(announcements.id, id)).limit(1);
    if (!announcement || announcement.status === "deleted") fail("NOT_FOUND", "Announcement was not found.", 404);
    if (announcement.status === "published") fail("CONFLICT", "Published announcements cannot be edited.", 409);

    await assertAttachableFiles(actor.id, body.fileIds, "announcement", id);
    await db.transaction(async (tx) => {
      await tx
        .update(announcements)
        .set({
          title: body.title ?? announcement.title,
          body: body.body ?? announcement.body,
          targetType: body.targetType ?? announcement.targetType,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(announcements.id, id));
      if (body.targetValues) {
        await tx.delete(announcementTargets).where(eq(announcementTargets.announcementId, id));
        for (const targetValue of body.targetValues) await tx.insert(announcementTargets).values({ announcementId: id, targetValue }).onConflictDoNothing();
      }
      for (const fileId of body.fileIds ?? []) {
        await tx.update(files).set({ resourceType: "announcement", resourceId: id }).where(eq(files.id, fileId));
        await tx.insert(announcementFiles).values({ announcementId: id, fileId }).onConflictDoNothing();
      }
    });
    await audit(actor, "announcement_updated", "announcement", id, {}, c.get("requestId"));
    const [updated] = await db.select().from(announcements).where(eq(announcements.id, id)).limit(1);
    return c.json({ announcement: { ...updated, availableActions: announcementActions(actor.role, updated.status) } });
  });

  app.delete("/announcements/:id", requireAuth, requireRole("admin"), async (c: AppContext) => {
    const actor = c.get("actor");
    const id = z.string().min(1).parse(c.req.param("id"));
    await db.update(announcements).set({ status: "deleted", deletedAt: new Date().toISOString(), updatedAt: new Date().toISOString() }).where(eq(announcements.id, id));
    await audit(actor, "announcement_deleted", "announcement", id, {}, c.get("requestId"));
    return c.json({ ok: true });
  });

  app.post("/announcements/:id/reactions", requireAuth, requireRole("customer"), rateLimit({ scope: "announcements.react", limit: 30, windowSeconds: 60, key: actorKey }), async (c: AppContext) => {
    const actor = c.get("actor");
    const id = z.string().min(1).parse(c.req.param("id"));
    const body = reactionSchema.parse(await c.req.json());
    const [announcement] = await db.select().from(announcements).where(and(eq(announcements.id, id), eq(announcements.status, "published"))).limit(1);
    if (!announcement) fail("FORBIDDEN", "Announcement is not available.", 403);
    if (!(await customerAnnouncementVisible(actor.id, announcement))) fail("FORBIDDEN", "Announcement is not available.", 403);
    await db.insert(announcementReactions).values({ announcementId: id, userId: actor.id, emoji: body.emoji }).onConflictDoNothing();
    return c.json({ ok: true });
  });

  app.post("/announcements/:id/comments", requireAuth, requireRole("customer"), async (c: AppContext) => {
    const actor = c.get("actor");
    const id = z.string().min(1).parse(c.req.param("id"));
    const body = commentSchema.parse(await c.req.json());
    const [announcement] = await db.select().from(announcements).where(and(eq(announcements.id, id), eq(announcements.status, "published"))).limit(1);
    if (!announcement) fail("FORBIDDEN", "Announcement is not available.", 403);
    if (!(await customerAnnouncementVisible(actor.id, announcement))) fail("FORBIDDEN", "Announcement is not available.", 403);
    const commentId = randomUUID();
    await db.insert(announcementComments).values({ id: commentId, announcementId: id, authorId: actor.id, body: body.body });
    const [comment] = await db.select().from(announcementComments).where(eq(announcementComments.id, commentId)).limit(1);
    return c.json({ comment }, 201);
  });

  app.delete("/announcement-comments/:id", requireAuth, async (c: AppContext) => {
    const actor = c.get("actor");
    const id = z.string().min(1).parse(c.req.param("id"));
    const [comment] = await db.select().from(announcementComments).where(eq(announcementComments.id, id)).limit(1);
    if (!comment) fail("NOT_FOUND", "Comment was not found.", 404);
    if (actor.role !== "admin" && comment.authorId !== actor.id) fail("FORBIDDEN", "You cannot delete this comment.", 403);
    await db.update(announcementComments).set({ deletedAt: new Date().toISOString() }).where(eq(announcementComments.id, id));
    return c.json({ ok: true });
  });

  app.get("/reports", requireAuth, async (c: AppContext) => {
    const actor = c.get("actor");
    if (actor.role === "agent") fail("FORBIDDEN", "Agents cannot view reports.", 403);
    const query = cursorSchema.parse({ cursor: c.req.query("cursor"), limit: c.req.query("limit") ?? 30 });
    const filters = [];
    if (actor.role === "customer") filters.push(eq(reports.customerId, actor.id));
    if (query.cursor) filters.push(lt(reports.createdAt, query.cursor));
    const rows = await db.select().from(reports).where(filters.length ? and(...filters) : undefined).orderBy(desc(reports.createdAt)).limit(query.limit + 1);
    const items = await Promise.all(
      rows.slice(0, query.limit).map(async (report) => ({
        ...report,
        files: await reportFileRows(report.id),
        availableActions: reportActions(actor.role),
      })),
    );
    return c.json({ items, nextCursor: rows.length > query.limit ? rows[query.limit - 1]?.createdAt : null });
  });

  app.get("/reports/:id", requireAuth, async (c: AppContext) => {
    const actor = c.get("actor");
    const id = z.string().min(1).parse(c.req.param("id"));
    const [report] = await db.select().from(reports).where(eq(reports.id, id)).limit(1);
    if (!report) fail("NOT_FOUND", "Report was not found.", 404);
    if (actor.role === "customer" && report.customerId !== actor.id) fail("FORBIDDEN", "You cannot view this report.", 403);
    if (actor.role === "agent") fail("FORBIDDEN", "Agents cannot view reports.", 403);
    const links = await db.select().from(reportFiles).where(eq(reportFiles.reportId, id));
    const attached = links.length ? await db.select().from(files).where(inArray(files.id, links.map((link) => link.fileId))) : [];
    const comments =
      actor.role === "admin" ? await db.select().from(reportInternalComments).where(eq(reportInternalComments.reportId, id)).orderBy(desc(reportInternalComments.createdAt)).limit(50) : [];
    return c.json({
      report: {
        ...report,
        files: attached,
        internalComments: comments,
        availableActions: reportActions(actor.role),
      },
    });
  });

  app.post("/reports", requireAuth, requireRole("customer"), rateLimit({ scope: "reports.create", limit: 10, windowSeconds: 24 * 60 * 60, key: actorKey }), async (c: AppContext) => {
    const actor = c.get("actor");
    const body = reportSchema.parse(await c.req.json());
    const { value, replayed } = await withIdempotency(actor, "reports.create", body.idempotencyKey, body, async () => {
      const id = randomUUID();
      await assertAttachableFiles(actor.id, body.fileIds, "report", id);
      const evidenceSnapshot = body.evidenceMessageIds?.length
        ? await db.select({ id: messages.id, body: messages.body, createdAt: messages.createdAt }).from(messages).where(inArray(messages.id, body.evidenceMessageIds))
        : [];
      await db.transaction(async (tx) => {
        await tx.insert(reports).values({
          id,
          customerId: actor.id,
          title: body.title,
          category: body.category,
          description: body.description,
          evidenceSnapshot,
          idempotencyKey: body.idempotencyKey,
        });
        for (const fileId of body.fileIds ?? []) {
          await tx.update(files).set({ resourceType: "report", resourceId: id }).where(eq(files.id, fileId));
          await tx.insert(reportFiles).values({ reportId: id, fileId }).onConflictDoNothing();
        }
      });
      await publishEvent([adminChannel], "notification:new", { resourceId: id, resourceType: "report" });
      const [report] = await db.select().from(reports).where(eq(reports.id, id)).limit(1);
      return { report };
    });
    return c.json(value, replayed ? 200 : 201);
  });

  app.patch("/reports/:id/status", requireAuth, requireRole("admin"), async (c: AppContext) => {
    const actor = c.get("actor");
    const id = z.string().min(1).parse(c.req.param("id"));
    const body = reportStatusSchema.parse(await c.req.json());
    const [report] = await db.select().from(reports).where(eq(reports.id, id)).limit(1);
    if (!report) fail("NOT_FOUND", "Report was not found.", 404);
    await db.update(reports).set({ status: body.status, adminNotes: body.adminNotes, updatedAt: new Date().toISOString() }).where(eq(reports.id, id));
    await audit(actor, "report_status_changed", "report", id, { from: report.status, to: body.status }, c.get("requestId"));
    await db.insert(notifications).values({ id: randomUUID(), userId: report.customerId, type: "report_status_changed", resourceType: "report", resourceId: id, title: "Report updated", body: `Your report is now ${body.status}.` });
    await publishEvent([userChannel(report.customerId), adminChannel], "report:status_updated", { resourceId: id, reportId: id, status: body.status, actor });
    const [updated] = await db.select().from(reports).where(eq(reports.id, id)).limit(1);
    return c.json({ report: updated });
  });

  app.post("/reports/:id/internal-comments", requireAuth, requireRole("admin"), async (c: AppContext) => {
    const actor = c.get("actor");
    const id = z.string().min(1).parse(c.req.param("id"));
    const body = internalCommentSchema.parse(await c.req.json());
    const [report] = await db.select().from(reports).where(eq(reports.id, id)).limit(1);
    if (!report) fail("NOT_FOUND", "Report was not found.", 404);
    const commentId = randomUUID();
    await db.insert(reportInternalComments).values({ id: commentId, reportId: id, authorId: actor.id, body: body.body });
    const [comment] = await db.select().from(reportInternalComments).where(eq(reportInternalComments.id, commentId)).limit(1);
    return c.json({ comment }, 201);
  });

  app.get("/notifications", requireAuth, async (c: AppContext) => {
    const actor = c.get("actor");
    const query = cursorSchema.parse({ cursor: c.req.query("cursor"), limit: c.req.query("limit") ?? 30 });
    const rows = await db
      .select()
      .from(notifications)
      .where(and(eq(notifications.userId, actor.id), query.cursor ? lt(notifications.createdAt, query.cursor) : undefined))
      .orderBy(desc(notifications.createdAt))
      .limit(query.limit + 1);
    return c.json({ items: rows.slice(0, query.limit), nextCursor: rows.length > query.limit ? rows[query.limit - 1]?.createdAt : null, unreadCount: await unreadNotifications(actor.id) });
  });

  app.post("/notifications/:id/read", requireAuth, async (c: AppContext) => {
    const actor = c.get("actor");
    const id = z.string().min(1).parse(c.req.param("id"));
    await db.update(notifications).set({ readAt: new Date().toISOString() }).where(and(eq(notifications.id, id), eq(notifications.userId, actor.id)));
    return c.json({ ok: true, unreadCount: await unreadNotifications(actor.id) });
  });

  app.post("/notifications/read-all", requireAuth, async (c: AppContext) => {
    const actor = c.get("actor");
    await db.update(notifications).set({ readAt: new Date().toISOString() }).where(and(eq(notifications.userId, actor.id), isNull(notifications.readAt)));
    return c.json({ ok: true, unreadCount: 0 });
  });

  app.get("/team/messages", requireAuth, requireRole("admin", "agent"), async (c: AppContext) => {
    const actor = c.get("actor");
    const query = cursorSchema.parse({ cursor: c.req.query("cursor"), limit: c.req.query("limit") ?? 50 });
    const rows = await db
      .select()
      .from(teamMessages)
      .where(and(isNull(teamMessages.deletedAt), query.cursor ? lt(teamMessages.createdAt, query.cursor) : undefined))
      .orderBy(desc(teamMessages.createdAt))
      .limit(query.limit + 1);
    const items = await Promise.all(rows.slice(0, query.limit).map(async (message) => ({ ...message, files: await teamMessageFileRows(message.id) })));
    return c.json({ items, nextCursor: rows.length > query.limit ? rows[query.limit - 1]?.createdAt : null, unreadCount: await teamUnreadCount(actor.id) });
  });

  app.post("/team/messages", requireAuth, requireRole("admin", "agent"), rateLimit({ scope: "team.message", limit: 60, windowSeconds: 60, key: actorKey }), async (c: AppContext) => {
    const actor = c.get("actor");
    const body = teamMessageSchema.parse(await c.req.json());
    const { value, replayed } = await withIdempotency(actor, "team.message", body.idempotencyKey, body, async () => {
      const id = randomUUID();
      await assertAttachableFiles(actor.id, body.fileIds, "team", id);
      await db.transaction(async (tx) => {
        await tx.insert(teamMessages).values({ id, senderId: actor.id, body: body.body, idempotencyKey: body.idempotencyKey });
        for (const fileId of body.fileIds ?? []) {
          await tx.update(files).set({ resourceType: "team", resourceId: id }).where(eq(files.id, fileId));
          await tx.insert(teamMessageFiles).values({ messageId: id, fileId }).onConflictDoNothing();
        }
      });
      if (body.mentionUserIds?.length) {
        const mentionable = await db
          .select({ id: users.id })
          .from(users)
          .where(and(inArray(users.id, body.mentionUserIds), inArray(users.role, ["admin", "agent"]), eq(users.status, "active")));
        for (const user of mentionable.filter((user) => user.id !== actor.id)) {
          await notification(user.id, "team_mention", "team_message", id, "Mentioned in Team Chat", body.body.slice(0, 140), `team-mention:${id}:${user.id}`);
        }
      }
      await publishEvent([teamChannel], "team:message:new", { resourceId: id, messageId: id, actor });
      const [message] = await db.select().from(teamMessages).where(eq(teamMessages.id, id)).limit(1);
      return { message: { ...message, files: await teamMessageFileRows(id) } };
    });
    return c.json(value, replayed ? 200 : 201);
  });

  app.post("/team/messages/read", requireAuth, requireRole("admin", "agent"), async (c: AppContext) => {
    const actor = c.get("actor");
    const body = teamReadSchema.parse(await c.req.json().catch(() => ({})));
    const [latest] = body.messageId
      ? await db.select().from(teamMessages).where(eq(teamMessages.id, body.messageId)).limit(1)
      : await db.select().from(teamMessages).where(isNull(teamMessages.deletedAt)).orderBy(desc(teamMessages.createdAt)).limit(1);
    if (!latest) return c.json({ ok: true, unreadCount: 0 });
    await db.insert(teamMessageReads).values({ messageId: latest.id, userId: actor.id }).onConflictDoUpdate({
      target: [teamMessageReads.messageId, teamMessageReads.userId],
      set: { readAt: new Date().toISOString() },
    });
    return c.json({ ok: true, unreadCount: await teamUnreadCount(actor.id) });
  });

  app.delete("/team/messages/:id", requireAuth, requireRole("admin", "agent"), async (c: AppContext) => {
    const actor = c.get("actor");
    const id = z.string().min(1).parse(c.req.param("id"));
    const [message] = await db.select().from(teamMessages).where(eq(teamMessages.id, id)).limit(1);
    if (!message || message.deletedAt) fail("NOT_FOUND", "Team message was not found.", 404);
    if (actor.role !== "admin" && message.senderId !== actor.id) fail("FORBIDDEN", "You cannot delete this team message.", 403);
    await db.update(teamMessages).set({ deletedAt: new Date().toISOString() }).where(eq(teamMessages.id, id));
    await audit(actor, "team_message_deleted", "team_message", id, {}, c.get("requestId"));
    await publishEvent([teamChannel], "team:message:deleted", { resourceId: id, messageId: id, actor });
    return c.json({ ok: true });
  });

  app.get("/admin/audit-logs", requireAuth, requireRole("admin"), async (c: AppContext) => {
    const query = cursorSchema.parse({ cursor: c.req.query("cursor"), limit: c.req.query("limit") ?? 50 });
    const action = c.req.query("action");
    const resourceType = c.req.query("resourceType");
    const actorId = c.req.query("actorId");
    const filters = [
      query.cursor ? lt(auditLogs.createdAt, query.cursor) : undefined,
      action ? eq(auditLogs.action, action) : undefined,
      resourceType ? eq(auditLogs.resourceType, resourceType) : undefined,
      actorId ? eq(auditLogs.actorId, actorId) : undefined,
    ];
    const rows = await db
      .select()
      .from(auditLogs)
      .where(and(...filters))
      .orderBy(desc(auditLogs.createdAt))
      .limit(query.limit + 1);
    return c.json({ items: rows.slice(0, query.limit), nextCursor: rows.length > query.limit ? rows[query.limit - 1]?.createdAt : null });
  });

  app.get("/search", requireAuth, async (c: AppContext) => {
    const actor = c.get("actor");
    const query = searchSchema.parse({ q: c.req.query("q"), limit: c.req.query("limit") ?? 10 });
    const term = `%${query.q.replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
    const groups: Record<string, unknown[]> = {};

    if (actor.role === "admin") {
      groups.users = await db.select({ id: users.id, role: users.role, displayName: users.displayName, email: users.email }).from(users).where(or(like(users.email, term), like(users.displayName, term))).limit(query.limit);
      groups.reports = await db.select().from(reports).where(or(like(reports.title, term), like(reports.description, term))).limit(query.limit);
      groups.announcements = await db.select().from(announcements).where(or(like(announcements.title, term), like(announcements.body, term))).limit(query.limit);
    } else if (actor.role === "agent") {
      groups.chats = await db
        .select()
        .from(supportChats)
        .where(or(eq(supportChats.assignedAgentId, actor.id), isNull(supportChats.assignedAgentId)))
        .limit(query.limit);
      groups.teamMessages = await db.select().from(teamMessages).where(like(teamMessages.body, term)).limit(query.limit);
    } else {
      groups.messages = await db
        .select()
        .from(messages)
        .innerJoin(supportChats, eq(messages.chatId, supportChats.id))
        .where(and(eq(supportChats.customerId, actor.id), eq(messages.visibleToCustomer, true), like(messages.body, term)))
        .limit(query.limit);
      groups.reports = await db.select().from(reports).where(and(eq(reports.customerId, actor.id), or(like(reports.title, term), like(reports.description, term)))).limit(query.limit);
    }

    return c.json({ groups });
  });
}
