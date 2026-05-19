import { randomUUID } from "node:crypto";
import { DeleteObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { and, eq, inArray, isNotNull, isNull, lte, or } from "drizzle-orm";
import { db } from "./db.js";
import { announcements, files, idempotencyKeys, notifications, passwordResetTokens, rateLimitCounters, twoFactorChallenges } from "./schema.js";
import { adminChannel, publishEvent, userChannel } from "./events.js";
import { targetedCustomerIds } from "./content.js";
import { config, isProduction } from "./config.js";

let timer: NodeJS.Timeout | null = null;
let running = false;

function bucket() {
  return config.R2_BUCKET_NAME || config.R2_BUCKET;
}

function storageClient() {
  return new S3Client({
    region: "auto",
    endpoint: `https://${config.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: config.R2_ACCESS_KEY_ID!,
      secretAccessKey: config.R2_SECRET_ACCESS_KEY!,
    },
  });
}

async function deleteStorageObjects(rows: Array<{ id: string; storageKey: string }>) {
  if (!rows.length) return [];
  if (!isProduction) return rows.map((row) => row.id);
  const bucketName = bucket();
  if (!config.R2_ACCOUNT_ID || !config.R2_ACCESS_KEY_ID || !config.R2_SECRET_ACCESS_KEY || !bucketName) return [];

  const client = storageClient();
  const deletedIds: string[] = [];
  try {
    for (const row of rows) {
      try {
        await client.send(new DeleteObjectCommand({ Bucket: bucketName, Key: row.storageKey }));
        deletedIds.push(row.id);
      } catch (error) {
        console.error("file cleanup delete failed", { fileId: row.id, error });
      }
    }
  } finally {
    client.destroy();
  }
  return deletedIds;
}

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
      const inserted = await db
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
        .onConflictDoNothing()
        .returning({ id: notifications.id });
      if (inserted.length) {
        await publishEvent([userChannel(customerId)], "notification:new", {
          resourceId: notificationId,
          notificationId,
          resourceType: "announcement",
        });
      }
      await publishEvent([userChannel(customerId)], "announcement:published", {
        resourceId: announcement.id,
        announcementId: announcement.id,
        title: announcement.title,
      });
    }
    await publishEvent([adminChannel], "announcement:published", {
      resourceId: announcement.id,
      announcementId: announcement.id,
      title: announcement.title,
    });
  }

  const orphanReadyCutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const staleFiles = await db
    .select({ id: files.id, storageKey: files.storageKey })
    .from(files)
    .where(
      or(
        and(eq(files.status, "pending"), lte(files.expiresAt, now)),
        and(eq(files.status, "ready"), isNull(files.resourceType), lte(files.completedAt, orphanReadyCutoff)),
      ),
    );
  const deletedFileIds = await deleteStorageObjects(staleFiles);
  if (deletedFileIds.length) {
    await db.update(files).set({ status: "expired" }).where(inArray(files.id, deletedFileIds));
  }
  await db.delete(rateLimitCounters).where(lte(rateLimitCounters.expiresAt, now));
  await db.delete(idempotencyKeys).where(lte(idempotencyKeys.expiresAt, now));
  await db.delete(twoFactorChallenges).where(lte(twoFactorChallenges.expiresAt, now));
  await db.delete(passwordResetTokens).where(lte(passwordResetTokens.expiresAt, now));
  const notificationRetentionCutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
  await db.delete(notifications).where(and(isNotNull(notifications.readAt), lte(notifications.readAt, notificationRetentionCutoff)));
}

export function startJobs() {
  timer = setInterval(() => {
    if (running) return;
    running = true;
    runDueJobs()
      .catch((error) => console.error("job failure", error))
      .finally(() => {
        running = false;
      });
  }, 60_000);
}

export function stopJobs() {
  if (timer) clearInterval(timer);
}
