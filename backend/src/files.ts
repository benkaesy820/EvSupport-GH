import { randomUUID } from "node:crypto";
import { PutObjectCommand, GetObjectCommand, HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { Hono } from "hono";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { config, fileConfig, isProduction } from "./config.js";
import { db } from "./db.js";
import { announcementTargets, customers, files, supportChats, reports, announcements, systemSettings } from "./schema.js";
import { actorKey, audit, fail, rateLimit, requireAuth, type Actor, type AppContext } from "./security.js";

const uploadIntentSchema = z.object({
  resourceType: z.enum(["chat", "report", "announcement", "team"]).optional(),
  resourceId: z.string().optional(),
  name: z.string().min(1).max(240),
  mimeType: z.string().min(1).max(160),
  sizeBytes: z.number().int().positive(),
});

const completeSchema = z.object({ checksum: z.string().max(160).optional() });

function bucket() {
  return config.R2_BUCKET_NAME || config.R2_BUCKET;
}

function s3Client() {
  if (!config.R2_ACCOUNT_ID || !config.R2_ACCESS_KEY_ID || !config.R2_SECRET_ACCESS_KEY || !bucket()) {
    fail("INTERNAL_SERVER_ERROR", "Object storage is not configured.", 500);
  }
  return new S3Client({
    region: "auto",
    endpoint: `https://${config.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: config.R2_ACCESS_KEY_ID!,
      secretAccessKey: config.R2_SECRET_ACCESS_KEY!,
    },
  });
}

async function canAccessResource(actor: Actor, resourceType?: string | null, resourceId?: string | null) {
  if (!resourceType && !resourceId) return true;
  if (!resourceType || !resourceId) return false;
  if (actor.role === "admin") return true;

  if (resourceType === "team") return actor.role === "agent";

  if (resourceType === "chat") {
    const [chat] = await db.select().from(supportChats).where(eq(supportChats.id, resourceId)).limit(1);
    if (!chat) return false;
    if (actor.role === "customer") return chat.customerId === actor.id;
    return chat.assignedAgentId === actor.id || !chat.assignedAgentId;
  }

  if (resourceType === "report") {
    const [report] = await db.select().from(reports).where(eq(reports.id, resourceId)).limit(1);
    return Boolean(report && actor.role === "customer" && report.customerId === actor.id);
  }

  if (resourceType === "announcement") {
    const [announcement] = await db.select().from(announcements).where(eq(announcements.id, resourceId)).limit(1);
    if (!announcement || announcement.status !== "published") return false;
    if (actor.role !== "customer") return true;
    if (announcement.targetType === "all_customers") return true;
    const targets = await db.select().from(announcementTargets).where(eq(announcementTargets.announcementId, announcement.id));
    const values = new Set(targets.map((target) => target.targetValue));
    if (!values.size) return false;
    if (announcement.targetType === "customer_tag") {
      const [profile] = await db.select().from(customers).where(eq(customers.userId, actor.id)).limit(1);
      return Boolean(profile?.tags.some((tag) => values.has(tag)));
    }
    const chats = await db.select({ category: supportChats.category }).from(supportChats).where(eq(supportChats.customerId, actor.id)).limit(1);
    return Boolean(chats[0] && values.has(chats[0].category));
  }

  return false;
}

async function currentFilePolicy() {
  const rows = await db
    .select()
    .from(systemSettings)
    .where(inArray(systemSettings.key, ["maxFileSize", "allowedFileTypes"]));
  const settings = Object.fromEntries(rows.map((row) => [row.key, row.value]));
  return {
    maxBytes: typeof settings.maxFileSize === "number" ? settings.maxFileSize : fileConfig.maxBytes,
    allowedTypes: Array.isArray(settings.allowedFileTypes) && settings.allowedFileTypes.every((value) => typeof value === "string")
      ? settings.allowedFileTypes
      : fileConfig.allowedTypes,
  };
}

export function registerFileRoutes(app: Hono) {
  app.post("/files/upload-intents", requireAuth, rateLimit({ scope: "files.upload_intent", limit: 30, windowSeconds: 60 * 60, key: actorKey }), async (c: AppContext) => {
    const actor = c.get("actor");
    const body = uploadIntentSchema.parse(await c.req.json());
    if ((body.resourceType && !body.resourceId) || (!body.resourceType && body.resourceId)) fail("VALIDATION_ERROR", "resourceType and resourceId must be provided together.", 400);
    const policy = await currentFilePolicy();
    if (!policy.allowedTypes.includes(body.mimeType)) fail("VALIDATION_ERROR", "File type is not allowed.", 400);
    if (body.sizeBytes > policy.maxBytes) fail("VALIDATION_ERROR", "File exceeds the maximum allowed size.", 400);
    if (!(await canAccessResource(actor, body.resourceType, body.resourceId))) fail("FORBIDDEN", "You cannot attach files to this resource.", 403);

    const id = randomUUID();
    const storageKey = `${actor.id}/${id}/${body.name.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
    await db.insert(files).values({
      id,
      ownerId: actor.id,
      resourceType: body.resourceType,
      resourceId: body.resourceId,
      storageKey,
      name: body.name,
      mimeType: body.mimeType,
      sizeBytes: body.sizeBytes,
      expiresAt,
    });

    const uploadUrl = await getSignedUrl(
      s3Client(),
      new PutObjectCommand({ Bucket: bucket(), Key: storageKey, ContentType: body.mimeType, ContentLength: body.sizeBytes }),
      { expiresIn: 15 * 60 },
    );

    return c.json({ fileId: id, uploadUrl, expiresAt });
  });

  app.post("/files/:id/complete", requireAuth, rateLimit({ scope: "files.upload_complete", limit: 60, windowSeconds: 60 * 60, key: actorKey }), async (c: AppContext) => {
    const actor = c.get("actor");
    const id = z.string().min(1).parse(c.req.param("id"));
    const body = completeSchema.parse(await c.req.json().catch(() => ({})));
    const [file] = await db.select().from(files).where(eq(files.id, id)).limit(1);
    if (!file) fail("NOT_FOUND", "File was not found.", 404);
    if (file.ownerId !== actor.id) fail("FORBIDDEN", "Only the upload owner can complete this file.", 403);
    if (!(await canAccessResource(actor, file.resourceType, file.resourceId))) fail("FORBIDDEN", "You cannot attach files to this resource.", 403);
    if (isProduction) {
      const head = await s3Client().send(new HeadObjectCommand({ Bucket: bucket(), Key: file.storageKey })).catch(() => null);
      if (!head) fail("CONFLICT", "Uploaded object was not found in storage.", 409);
      if (head.ContentLength !== undefined && head.ContentLength !== file.sizeBytes) fail("CONFLICT", "Uploaded object size does not match the upload intent.", 409);
      if (head.ContentType && head.ContentType !== file.mimeType) fail("CONFLICT", "Uploaded object type does not match the upload intent.", 409);
    }

    const updatedRows = await db
      .update(files)
      .set({ status: "ready", checksum: body.checksum, completedAt: new Date().toISOString() })
      .where(and(eq(files.id, id), eq(files.status, "pending")))
      .returning({ id: files.id });
    if (!updatedRows.length) fail("CONFLICT", "File upload is not pending.", 409);
    await audit(actor, "file_uploaded", "file", id, { resourceType: file.resourceType, resourceId: file.resourceId }, c.get("requestId"));
    const [updated] = await db.select().from(files).where(eq(files.id, id)).limit(1);
    return c.json({ file: updated });
  });

  app.get("/files/:id/download", requireAuth, async (c: AppContext) => {
    const actor = c.get("actor");
    const id = z.string().min(1).parse(c.req.param("id"));
    const [file] = await db.select().from(files).where(eq(files.id, id)).limit(1);
    if (!file || file.status !== "ready") fail("NOT_FOUND", "File was not found.", 404);
    if (!file.resourceType && !file.resourceId && file.ownerId !== actor.id) fail("FORBIDDEN", "You cannot access this file.", 403);
    if (!(await canAccessResource(actor, file.resourceType, file.resourceId))) fail("FORBIDDEN", "You cannot access this file.", 403);
    const downloadUrl = await getSignedUrl(s3Client(), new GetObjectCommand({ Bucket: bucket(), Key: file.storageKey }), { expiresIn: 10 * 60 });
    return c.json({ downloadUrl });
  });
}
