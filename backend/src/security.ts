import { createHash, randomUUID } from "node:crypto";
import type { Context, MiddlewareHandler, Next } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { HTTPException } from "hono/http-exception";
import { jwtVerify, SignJWT } from "jose";
import { and, eq, isNull, sql } from "drizzle-orm";
import { ZodError } from "zod";
import { db } from "./db.js";
import { auditLogs, idempotencyKeys, rateLimitCounters, userSessions, users } from "./schema.js";
import { config, isProduction } from "./config.js";

export type Role = "admin" | "agent" | "customer";

export type Actor = {
  id: string;
  role: Role;
  email: string;
  displayName: string;
  status: "pending_approval" | "active" | "suspended" | "anonymized";
  sessionId?: string;
};

type Env = {
  Variables: {
    actor: Actor;
    requestId: string;
  };
};

export type AppContext = Context<Env>;

const accessSecret = new TextEncoder().encode(config.JWT_ACCESS_SECRET);
const refreshSecret = new TextEncoder().encode(config.JWT_REFRESH_SECRET);

export class ApiError extends Error {
  constructor(
    public readonly error: string,
    message: string,
    public readonly status = 400,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export function fail(error: string, message: string, status = 400, details: Record<string, unknown> = neverDetails()): never {
  throw new ApiError(error, message, status, details);
}

function neverDetails() {
  return {};
}

export const requestContext: MiddlewareHandler<Env> = async (c, next) => {
  const started = Date.now();
  const requestId = c.req.header("x-request-id") ?? randomUUID();
  c.set("requestId", requestId);
  await next();
  c.header("x-request-id", requestId);
  const actor = c.get("actor");
  console.log(
    JSON.stringify({
      requestId,
      method: c.req.method,
      path: new URL(c.req.url).pathname,
      status: c.res.status,
      durationMs: Date.now() - started,
      actorId: actor?.id,
    }),
  );
};

export function errorResponse(error: unknown) {
  if (error instanceof ApiError) {
    return Response.json({ error: error.error, message: error.message, details: error.details }, { status: error.status });
  }
  if (error instanceof HTTPException) {
    return Response.json({ error: "BAD_REQUEST", message: error.message, details: {} }, { status: error.status });
  }
  if (error instanceof ZodError) {
    return Response.json({ error: "VALIDATION_ERROR", message: "Request validation failed.", details: { issues: error.issues } }, { status: 400 });
  }
  const message = isProduction ? "Unexpected server error" : error instanceof Error ? error.message : "Unexpected server error";
  return Response.json({ error: "INTERNAL_SERVER_ERROR", message, details: {} }, { status: 500 });
}

export async function signAccessToken(actor: Pick<Actor, "id" | "role">, sessionId: string) {
  return new SignJWT({ role: actor.role, sessionId })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(actor.id)
    .setIssuedAt()
    .setExpirationTime("15m")
    .sign(accessSecret);
}

export async function signRefreshToken(userId: string, sessionId: string) {
  return new SignJWT({ sessionId })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime("30d")
    .sign(refreshSecret);
}

export function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export async function readActor(c: AppContext): Promise<Actor | null> {
  const header = c.req.header("authorization");
  const bearer = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
  const token = bearer ?? getCookie(c, "access_token");
  if (!token) return null;

  try {
    const verified = await jwtVerify(token, accessSecret);
    const userId = verified.payload.sub;
    const sessionId = String(verified.payload.sessionId ?? "");
    if (!userId || !sessionId) return null;

    const [row] = await db
      .select({
        id: users.id,
        role: users.role,
        email: users.email,
        displayName: users.displayName,
        status: users.status,
        revokedAt: userSessions.revokedAt,
      })
      .from(users)
      .innerJoin(userSessions, eq(userSessions.id, sessionId))
      .where(and(eq(users.id, userId), eq(userSessions.userId, userId), isNull(userSessions.revokedAt)))
      .limit(1);

    if (!row || row.status !== "active") return null;
    touchUserActivity(userId).catch(() => undefined);
    return { ...row, sessionId };
  } catch {
    return null;
  }
}

const ACTIVITY_TOUCH_INTERVAL_MS = 60_000;
const lastTouchByUser = new Map<string, number>();

async function touchUserActivity(userId: string) {
  const now = Date.now();
  const last = lastTouchByUser.get(userId) ?? 0;
  if (now - last < ACTIVITY_TOUCH_INTERVAL_MS) return;
  lastTouchByUser.set(userId, now);
  await db.update(users).set({ lastActiveAt: new Date(now).toISOString() }).where(eq(users.id, userId));
}

export const requireAuth: MiddlewareHandler<Env> = async (c, next: Next) => {
  const actor = await readActor(c);
  if (!actor) fail("UNAUTHORIZED", "Authentication is required.", 401);
  c.set("actor", actor);
  await next();
};

export function requireRole(...roles: Role[]): MiddlewareHandler<Env> {
  return async (c, next) => {
    const actor = c.get("actor");
    if (!roles.includes(actor.role)) fail("FORBIDDEN", "You do not have permission to perform this action.", 403);
    await next();
  };
}

export function setAuthCookies(c: AppContext, accessToken: string, refreshToken: string) {
  const base = {
    httpOnly: true,
    secure: isProduction,
    sameSite: "Lax" as const,
    path: "/",
  };
  setCookie(c, "access_token", accessToken, { ...base, maxAge: 15 * 60 });
  setCookie(c, "refresh_token", refreshToken, { ...base, maxAge: 30 * 24 * 60 * 60 });
}

export async function audit(actor: Actor | null, action: string, resourceType: string, resourceId: string, metadata: Record<string, unknown> = {}, requestId?: string) {
  await db.insert(auditLogs).values({
    id: randomUUID(),
    actorId: actor?.id,
    action,
    resourceType,
    resourceId,
    metadata,
    requestId,
  });
}

export function userSummary(user: Pick<Actor, "id" | "role" | "displayName" | "status">) {
  return {
    id: user.id,
    role: user.role,
    displayName: user.displayName,
    status: user.status,
  };
}

export function canAccessInternal(actor: Actor) {
  return actor.role === "admin" || actor.role === "agent";
}

export type RateLimitPolicy = {
  scope: string;
  limit: number;
  windowSeconds: number;
  key?: (c: AppContext) => string | Promise<string>;
};

function remoteAddress(c: AppContext) {
  return c.req.header("cf-connecting-ip") ?? c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown-ip";
}

function windowStart(windowSeconds: number) {
  const bucket = Math.floor(Date.now() / (windowSeconds * 1000)) * windowSeconds * 1000;
  return new Date(bucket).toISOString();
}

export function ipKey(c: AppContext) {
  return remoteAddress(c);
}

export function actorKey(c: AppContext) {
  const actor = c.get("actor");
  return actor?.id ?? remoteAddress(c);
}

export function actorResourceKey(paramName = "id") {
  return (c: AppContext) => `${actorKey(c)}:${c.req.param(paramName) ?? "resource"}`;
}

export function rateLimit(policy: RateLimitPolicy): MiddlewareHandler {
  return async (c: AppContext, next) => {
    const key = await (policy.key ? policy.key(c) : ipKey(c));
    const start = windowStart(policy.windowSeconds);
    const expiresAt = new Date(new Date(start).getTime() + policy.windowSeconds * 1000).toISOString();

    const [row] = await db
      .insert(rateLimitCounters)
      .values({ scope: policy.scope, key, windowStart: start, count: 1, expiresAt })
      .onConflictDoUpdate({
        target: [rateLimitCounters.scope, rateLimitCounters.key, rateLimitCounters.windowStart],
        set: { count: sql`${rateLimitCounters.count} + 1` },
      })
      .returning({ count: rateLimitCounters.count, expiresAt: rateLimitCounters.expiresAt });

    if (row && row.count > policy.limit) {
      fail("RATE_LIMITED", "Too many requests. Please try again later.", 429, {
        scope: policy.scope,
        retryAfterSeconds: Math.max(1, Math.ceil((new Date(row.expiresAt).getTime() - Date.now()) / 1000)),
      });
    }

    await next();
  };
}

export function requestHash(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export async function withIdempotency<T>(
  actor: Actor,
  scope: string,
  key: string | undefined,
  requestBody: unknown,
  work: () => Promise<T>,
): Promise<{ value: T; replayed: boolean }> {
  if (!key) return { value: await work(), replayed: false };
  const hash = requestHash(requestBody);
  const [existing] = await db
    .select()
    .from(idempotencyKeys)
    .where(and(eq(idempotencyKeys.scope, scope), eq(idempotencyKeys.key, key), eq(idempotencyKeys.actorId, actor.id)))
    .limit(1);

  if (existing) {
    if (existing.requestHash !== hash) fail("CONFLICT", "Idempotency key was already used with a different request.", 409);
    if (existing.status === "completed") return { value: existing.responseJson as T, replayed: true };
    fail("CONFLICT", "A request with this idempotency key is already in progress.", 409);
  }

  await db.insert(idempotencyKeys).values({
    scope,
    key,
    actorId: actor.id,
    requestHash: hash,
    status: "in_progress",
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
  });

  try {
    const value = await work();
    await db
      .update(idempotencyKeys)
      .set({ status: "completed", responseJson: value })
      .where(and(eq(idempotencyKeys.scope, scope), eq(idempotencyKeys.key, key), eq(idempotencyKeys.actorId, actor.id)));
    return { value, replayed: false };
  } catch (error) {
    await db
      .update(idempotencyKeys)
      .set({ status: "failed" })
      .where(and(eq(idempotencyKeys.scope, scope), eq(idempotencyKeys.key, key), eq(idempotencyKeys.actorId, actor.id)));
    throw error;
  }
}
