import { randomUUID } from "node:crypto";
import { and, eq, lte } from "drizzle-orm";
import { db } from "./db.js";
import { announcementTargets, announcements, customers, files, idempotencyKeys, notifications, passwordResetTokens, rateLimitCounters, supportChats, twoFactorChallenges } from "./schema.js";
import { adminChannel, publishEvent, userChannel } from "./events.js";

let timer: NodeJS.Timeout | null = null;

export async function runDueJobs() {
  const now = new Date().toISOString();

  const dueAnnouncements = await db
    .update(announcements)
    .set({ status: "published", publishedAt: now, updatedAt: now })
    .where(and(eq(announcements.status, "scheduled"), lte(announcements.scheduledFor, now)))
    .returning();

  for (const announcement of dueAnnouncements) {
    const customerRows = await db.select().from(customers);
    const targets = await db.select().from(announcementTargets).where(eq(announcementTargets.announcementId, announcement.id));
    const values = new Set(targets.map((target) => target.targetValue));
    for (const customer of customerRows) {
      let visible = announcement.targetType === "all_customers" || customer.tags.some((tag) => values.has(tag));
      if (!visible && announcement.targetType === "category") {
        const chats = await db.select({ category: supportChats.category }).from(supportChats).where(eq(supportChats.customerId, customer.userId)).limit(1);
        visible = Boolean(chats[0] && values.has(chats[0].category));
      }
      if (!visible) continue;
      const notificationId = randomUUID();
      await db
        .insert(notifications)
        .values({
          id: notificationId,
          userId: customer.userId,
          type: "announcement_published",
          resourceType: "announcement",
          resourceId: announcement.id,
          title: "New announcement",
          body: announcement.title,
          dedupeKey: `announcement:${announcement.id}:${customer.userId}`,
        })
        .onConflictDoNothing();
      await publishEvent([userChannel(customer.userId)], "notification:new", { resourceId: notificationId, notificationId, resourceType: "announcement" });
    }
    await publishEvent([adminChannel], "announcement:published", {
      resourceId: announcement.id,
      announcementId: announcement.id,
      title: announcement.title,
    });
  }

  await db.update(files).set({ status: "expired" }).where(and(eq(files.status, "pending"), lte(files.expiresAt, now)));
  await db.delete(rateLimitCounters).where(lte(rateLimitCounters.expiresAt, now));
  await db.delete(idempotencyKeys).where(lte(idempotencyKeys.expiresAt, now));
  await db.delete(twoFactorChallenges).where(lte(twoFactorChallenges.expiresAt, now));
  await db.delete(passwordResetTokens).where(lte(passwordResetTokens.expiresAt, now));
}

export function startJobs() {
  timer = setInterval(() => {
    runDueJobs().catch((error) => console.error("job failure", error));
  }, 60_000);
}

export function stopJobs() {
  if (timer) clearInterval(timer);
}
