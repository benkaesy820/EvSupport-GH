import { randomUUID } from "node:crypto";
import { and, eq, lte } from "drizzle-orm";
import { db } from "./db.js";
import { announcements, files, idempotencyKeys, notifications, passwordResetTokens, rateLimitCounters, twoFactorChallenges } from "./schema.js";
import { adminChannel, publishEvent, userChannel } from "./events.js";
import { targetedCustomerIds } from "./content.js";

let timer: NodeJS.Timeout | null = null;

export async function runDueJobs() {
  const now = new Date().toISOString();

  const dueAnnouncements = await db
    .update(announcements)
    .set({ status: "published", publishedAt: now, updatedAt: now })
    .where(and(eq(announcements.status, "scheduled"), lte(announcements.scheduledFor, now)))
    .returning();

  for (const announcement of dueAnnouncements) {
    const customerIds = await targetedCustomerIds(announcement);
    for (const customerId of customerIds) {
      const notificationId = randomUUID();
      await db
        .insert(notifications)
        .values({
          id: notificationId,
          userId: customerId,
          type: "announcement_published",
          resourceType: "announcement",
          resourceId: announcement.id,
          title: "New announcement",
          body: announcement.title,
          dedupeKey: `announcement:${announcement.id}:${customerId}`,
        })
        .onConflictDoNothing();
      await publishEvent([userChannel(customerId)], "notification:new", {
        resourceId: notificationId,
        notificationId,
        resourceType: "announcement",
      });
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
