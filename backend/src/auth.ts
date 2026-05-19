import { randomBytes, randomInt, randomUUID } from "node:crypto";
import { hash, verify } from "@node-rs/argon2";
import { Hono } from "hono";
import { getCookie, deleteCookie } from "hono/cookie";
import { jwtVerify } from "jose";
import { and, count, desc, eq, gt, gte, inArray, isNull, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "./db.js";
import { agents, auditLogs, chatAssignments, customers, files, notifications, passwordResetTokens, reports, supportChats, systemSettings, teamMessages, twoFactorChallenges, userSessions, users } from "./schema.js";
import { audit, actorKey, fail, hashToken, ipKey, rateLimit, requireAuth, requireRole, setAuthCookies, signAccessToken, signRefreshToken, type Actor, type AppContext } from "./security.js";
import { config, isProduction } from "./config.js";
import { adminChannel, publishEvent, userChannel } from "./events.js";
import { sendCustomerApproved, sendCustomerInvite, sendNewAccountEmail, sendPasswordReset, sendSecurityAlert, sendTwoFactorCode } from "./email.js";

const DUMMY_HASH = "$argon2id$v=19$m=19456,t=2,p=1$YWFhYWFhYWFhYWFhYWFhYQ$WjwH7QmBzdwTjPzwhSk7p8RXLT8c1IhT2/wRBYpyu+E";

const loginSchema = z.object({
  email: z.string().email().transform((v) => v.toLowerCase()),
  password: z.string().min(1),
});

const twoFactorVerifySchema = z.object({
  challengeId: z.string().min(1),
  code: z.string().regex(/^\d{6}$/),
});

const passwordResetRequestSchema = z.object({
  email: z.string().email().transform((v) => v.toLowerCase()),
});

const passwordResetConfirmSchema = z.object({
  token: z.string().min(32),
  password: z.string().min(12),
});

const registerSchema = z.object({
  email: z.string().email().transform((v) => v.toLowerCase()),
  password: z.string().min(12),
  displayName: z.string().min(1).max(120),
  phone: z.string().max(50).optional(),
});
const createUserSchema = z.object({
  role: z.literal("agent"),
  email: z.string().email().transform((v) => v.toLowerCase()),
  password: z.string().min(12),
  displayName: z.string().min(1).max(120),
  phone: z.string().max(50).optional(),
  skills: z.array(z.string()).optional(),
});
const customerInviteSchema = z.object({
  email: z.string().email().transform((v) => v.toLowerCase()),
  displayName: z.string().min(1).max(120),
  phone: z.string().max(50).optional(),
});
const profileSchema = z.object({
  displayName: z.string().min(1).max(120).optional(),
  phone: z.string().max(50).nullable().optional(),
  timezone: z.string().min(1).max(80).optional(),
  notificationPrefs: z.record(z.boolean()).optional(),
  avatarFileId: z.string().min(1).nullable().optional(),
});
const twoFactorDisableSchema = z.object({ password: z.string().min(1) });
const adminUserPatchSchema = z.object({
  status: z.enum(["active", "suspended"]).optional(),
  displayName: z.string().min(1).max(120).optional(),
});

const refreshSecret = new TextEncoder().encode(config.JWT_REFRESH_SECRET);

function actorFromUser(user: typeof users.$inferSelect, sessionId?: string): Actor {
  return {
    id: user.id,
    role: user.role,
    email: user.email,
    displayName: user.displayName,
    status: user.status,
    sessionId,
  };
}

function publicUser(row: typeof users.$inferSelect) {
  return {
    id: row.id,
    role: row.role,
    email: row.email,
    displayName: row.displayName,
    phone: row.phone,
    avatarFileId: row.avatarFileId,
    status: row.status,
    timezone: row.timezone,
    notificationPrefs: row.notificationPrefs,
    twoFactorEnabled: row.twoFactorEnabled,
  };
}

function adminUserActions(row: Pick<typeof users.$inferSelect, "id" | "role" | "status">, actorId: string, activeAdminCount = 2) {
  const lastActiveAdmin = row.role === "admin" && row.status === "active" && activeAdminCount <= 1;
  return {
    approve: row.role === "customer" && row.status === "pending_approval",
    suspend: row.id !== actorId && row.status === "active" && !lastActiveAdmin,
    anonymize: row.id !== actorId && row.status !== "anonymized" && !lastActiveAdmin,
    revoke_sessions: row.id !== actorId && row.status !== "anonymized" && !lastActiveAdmin,
  };
}

async function activeAdminCount() {
  const [row] = await db.select({ value: count() }).from(users).where(and(eq(users.role, "admin"), eq(users.status, "active")));
  return row.value;
}

function requestIpHash(c: AppContext) {
  const ip = c.req.header("cf-connecting-ip") ?? c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
  return ip ? hashToken(ip) : undefined;
}

async function assertNotLastActiveAdmin(target: typeof users.$inferSelect, action: string) {
  if (target.role === "admin" && target.status === "active" && (await activeAdminCount()) <= 1) {
    fail("CONFLICT", `Cannot ${action} the only active admin.`, 409);
  }
}

async function notifyAdmins(type: string, resourceType: string, resourceId: string, title: string, body: string, dedupePrefix: string) {
  const admins = await db.select({ id: users.id }).from(users).where(and(eq(users.role, "admin"), eq(users.status, "active")));
  for (const admin of admins) {
    const notificationId = randomUUID();
    const inserted = await db
      .insert(notifications)
      .values({
        id: notificationId,
        userId: admin.id,
        type,
        resourceType,
        resourceId,
        title,
        body,
        dedupeKey: `${dedupePrefix}:${resourceId}:${admin.id}`,
      })
      .onConflictDoNothing()
      .returning({ id: notifications.id });
    if (inserted.length) await publishEvent([userChannel(admin.id)], "notification:new", { resourceId: notificationId, notificationId, resourceType });
  }
  await publishEvent([adminChannel], "notification:new", { resourceId, resourceType });
}

async function createSetupToken(userId: string) {
  const token = randomBytes(32).toString("base64url");
  await db.insert(passwordResetTokens).values({
    id: randomUUID(),
    userId,
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
  });
  return token;
}

async function createSession(c: AppContext, user: typeof users.$inferSelect) {
  const sessionId = randomUUID();
  const refreshToken = await signRefreshToken(user.id, sessionId);
  const accessToken = await signAccessToken({ id: user.id, role: user.role }, sessionId);
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

  await db.insert(userSessions).values({
    id: sessionId,
    userId: user.id,
    refreshTokenHash: hashToken(refreshToken),
    userAgent: c.req.header("user-agent"),
    ipHash: requestIpHash(c),
    expiresAt,
  });

  setAuthCookies(c, accessToken, refreshToken);
  return { accessToken, refreshToken, sessionId, expiresAt };
}

async function defaultChatPriority() {
  const [setting] = await db.select().from(systemSettings).where(eq(systemSettings.key, "defaultChatPriority")).limit(1);
  return setting?.value === "high" || setting?.value === "urgent" ? setting.value : "normal";
}

async function createTwoFactorChallenge(user: typeof users.$inferSelect) {
  const code = randomInt(100000, 1000000).toString();
  const challengeId = randomUUID();
  await db.insert(twoFactorChallenges).values({
    id: challengeId,
    userId: user.id,
    purpose: "login",
    codeHash: hashToken(code),
    expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
  });

  if (!isProduction) {
    console.log(`2FA code for ${user.email}: ${code}`);
  }
  await sendTwoFactorCode(user.email, code).catch((error) => console.error("2FA email failed", error));

  return {
    challengeId,
    debugCode: isProduction ? undefined : code,
  };
}

export function registerAuthRoutes(app: Hono) {
  app.post("/auth/register", rateLimit({ scope: "auth.register", limit: 5, windowSeconds: 60 * 60, key: ipKey }), async (c: AppContext) => {
    const body = registerSchema.parse(await c.req.json());
    const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, body.email)).limit(1);
    if (existing) fail("CONFLICT", "An account with this email already exists.", 409);
    const id = randomUUID();
    await db.transaction(async (tx) => {
      await tx.insert(users).values({
        id,
        role: "customer",
        email: body.email,
        passwordHash: await hash(body.password),
        displayName: body.displayName,
        phone: body.phone,
        status: "pending_approval",
      });
      await tx.insert(customers).values({ userId: id });
    });
    const [created] = await db.select().from(users).where(eq(users.id, id)).limit(1);
    await audit(actorFromUser(created), "customer_registered", "user", id, {}, c.get("requestId"));
    await notifyAdmins("customer_pending_approval", "user", id, "Customer awaiting approval", `${created.displayName} registered and is waiting for approval.`, "customer-pending");
    await publishEvent([adminChannel], "customer:pending_approval", { resourceId: id, userId: id, actor: actorFromUser(created) });
    return c.json({ user: publicUser(created), approvalRequired: true }, 201);
  });

  app.post("/auth/login", rateLimit({ scope: "auth.login", limit: 5, windowSeconds: 10 * 60, key: ipKey }), async (c: AppContext) => {
    const body = loginSchema.parse(await c.req.json());
    const [user] = await db.select().from(users).where(eq(users.email, body.email)).limit(1);

    const passwordOk = await verify(user?.passwordHash ?? DUMMY_HASH, body.password).catch(() => false);
    if (!user || !passwordOk) {
      fail("UNAUTHORIZED", "Invalid email or password.", 401);
    }
    if (user.status === "pending_approval") fail("FORBIDDEN", "Your account is waiting for approval.", 403);
    if (user.status !== "active") fail("FORBIDDEN", "This account is not active.", 403);
    if (user.role === "admin" && !user.twoFactorEnabled) {
      fail("FORBIDDEN", "Admin accounts require two-factor authentication before production use.", 403);
    }
    if (user.twoFactorEnabled || user.role === "admin") {
      const challenge = await createTwoFactorChallenge(user);
      return c.json({
        requiresTwoFactor: true,
        challengeId: challenge.challengeId,
        debugCode: challenge.debugCode,
      });
    }

    const session = await createSession(c, user);
    await audit(actorFromUser(user, session.sessionId), "login", "user", user.id, {}, c.get("requestId"));
    return c.json({ user: publicUser(user), session: { accessToken: session.accessToken, expiresAt: session.expiresAt } });
  });

  app.post("/auth/2fa/verify", rateLimit({ scope: "auth.2fa", limit: 5, windowSeconds: 10 * 60, key: ipKey }), async (c: AppContext) => {
    const body = twoFactorVerifySchema.parse(await c.req.json());
    const [challenge] = await db
      .select()
      .from(twoFactorChallenges)
      .where(and(eq(twoFactorChallenges.id, body.challengeId), isNull(twoFactorChallenges.usedAt), gt(twoFactorChallenges.expiresAt, new Date().toISOString())))
      .limit(1);

    if (!challenge) fail("UNAUTHORIZED", "Invalid or expired verification code.", 401);
    if (challenge.attempts >= 5) fail("RATE_LIMITED", "Too many verification attempts.", 429);

    if (challenge.codeHash !== hashToken(body.code)) {
      await db.update(twoFactorChallenges).set({ attempts: challenge.attempts + 1 }).where(eq(twoFactorChallenges.id, challenge.id));
      fail("UNAUTHORIZED", "Invalid or expired verification code.", 401);
    }

    const [user] = await db.select().from(users).where(eq(users.id, challenge.userId)).limit(1);
    if (!user || user.status !== "active") fail("UNAUTHORIZED", "Invalid verification challenge.", 401);

    const session = await createSession(c, user);
    await db.update(twoFactorChallenges).set({ usedAt: new Date().toISOString() }).where(eq(twoFactorChallenges.id, challenge.id));
    await audit(actorFromUser(user, session.sessionId), "login", "user", user.id, { twoFactor: true }, c.get("requestId"));
    return c.json({ user: publicUser(user), session: { accessToken: session.accessToken, expiresAt: session.expiresAt } });
  });

  app.post("/auth/logout", requireAuth, async (c: AppContext) => {
    const actor = c.get("actor");
    if (actor.sessionId) {
      await db.update(userSessions).set({ revokedAt: new Date().toISOString() }).where(eq(userSessions.id, actor.sessionId));
    }
    deleteCookie(c, "access_token", { path: "/" });
    deleteCookie(c, "refresh_token", { path: "/" });
    await audit(actor, "logout", "user", actor.id, {}, c.get("requestId"));
    return c.json({ ok: true });
  });

  app.post("/auth/refresh", async (c: AppContext) => {
    const refreshToken = getCookie(c, "refresh_token");
    if (!refreshToken) fail("UNAUTHORIZED", "Refresh token is required.", 401);

    const verified = await jwtVerify(refreshToken, refreshSecret).catch(() => null);
    const userId = verified?.payload.sub;
    const sessionId = String(verified?.payload.sessionId ?? "");
    if (!userId || !sessionId) fail("UNAUTHORIZED", "Invalid refresh token.", 401);

    const nowIso = new Date().toISOString();
    const [row] = await db
      .select({ user: users, session: userSessions })
      .from(users)
      .innerJoin(userSessions, eq(userSessions.id, sessionId))
      .where(
        and(
          eq(users.id, userId),
          eq(userSessions.refreshTokenHash, hashToken(refreshToken)),
          isNull(userSessions.revokedAt),
          gt(userSessions.expiresAt, nowIso),
        ),
      )
      .limit(1);

    if (!row || row.user.status !== "active") fail("UNAUTHORIZED", "Invalid refresh token.", 401);

    const nextRefresh = await signRefreshToken(row.user.id, sessionId);
    const accessToken = await signAccessToken({ id: row.user.id, role: row.user.role }, sessionId);
    await db
      .update(userSessions)
      .set({ refreshTokenHash: hashToken(nextRefresh) })
      .where(eq(userSessions.id, sessionId));
    setAuthCookies(c, accessToken, nextRefresh);
    return c.json({ user: publicUser(row.user), session: { accessToken } });
  });

  app.post("/auth/password-reset/request", rateLimit({ scope: "auth.password_reset_request", limit: 3, windowSeconds: 60 * 60, key: ipKey }), async (c: AppContext) => {
    const body = passwordResetRequestSchema.parse(await c.req.json());
    const [user] = await db.select().from(users).where(eq(users.email, body.email)).limit(1);
    if (!user || user.status !== "active") return c.json({ ok: true });

    const token = randomBytes(32).toString("base64url");
    await db.insert(passwordResetTokens).values({
      id: randomUUID(),
      userId: user.id,
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    });

    if (!isProduction) {
      console.log(`Password reset token for ${user.email}: ${token}`);
    }
    await sendPasswordReset(user.email, token).catch((error) => console.error("password reset email failed", error));

    return c.json({ ok: true, debugToken: isProduction ? undefined : token });
  });

  app.post("/auth/password-reset/confirm", rateLimit({ scope: "auth.password_reset_confirm", limit: 5, windowSeconds: 60 * 60, key: ipKey }), async (c: AppContext) => {
    const body = passwordResetConfirmSchema.parse(await c.req.json());
    const tokenHash = hashToken(body.token);
    const [token] = await db
      .select()
      .from(passwordResetTokens)
      .where(and(eq(passwordResetTokens.tokenHash, tokenHash), isNull(passwordResetTokens.usedAt), gt(passwordResetTokens.expiresAt, new Date().toISOString())))
      .limit(1);

    if (!token) fail("UNAUTHORIZED", "Invalid or expired reset token.", 401);
    const [user] = await db.select().from(users).where(eq(users.id, token.userId)).limit(1);
    if (!user || !["active", "pending_approval"].includes(user.status)) fail("UNAUTHORIZED", "Invalid or expired reset token.", 401);

    await db.transaction(async (tx) => {
      await tx.update(users).set({ passwordHash: await hash(body.password), updatedAt: new Date().toISOString() }).where(eq(users.id, user.id));
      await tx.update(passwordResetTokens).set({ usedAt: new Date().toISOString() }).where(eq(passwordResetTokens.id, token.id));
      await tx.update(userSessions).set({ revokedAt: new Date().toISOString() }).where(and(eq(userSessions.userId, user.id), isNull(userSessions.revokedAt)));
    });

    await audit(actorFromUser(user), user.status === "pending_approval" ? "customer_invite_accepted" : "password_reset", "user", user.id, {}, c.get("requestId"));
    if (user.status === "active") {
      await publishEvent([userChannel(user.id)], "force:logout", { resourceId: user.id, reason: "password_reset" });
      await sendSecurityAlert(user.email, "Your evComm password was reset. If this was not you, contact support immediately.").catch((error) => console.error("security email failed", error));
    }
    return c.json({ ok: true });
  });

  app.get("/me", requireAuth, async (c: AppContext) => {
    const actor = c.get("actor");
    const [user] = await db.select().from(users).where(eq(users.id, actor.id)).limit(1);
    if (!user) fail("UNAUTHORIZED", "User not found.", 401);
    const [unread] = await db.select({ value: count() }).from(notifications).where(and(eq(notifications.userId, actor.id), isNull(notifications.readAt)));
    const [teamUnread] =
      actor.role === "admin" || actor.role === "agent"
        ? await db
            .select({ value: count() })
            .from(teamMessages)
            .where(
              and(
                isNull(teamMessages.deletedAt),
                ne(teamMessages.senderId, actor.id),
                sql`not exists (select 1 from team_message_reads tmr where tmr.message_id = ${teamMessages.id} and tmr.user_id = ${actor.id})`,
              ),
            )
        : [{ value: 0 }];

    const agentProfile =
      actor.role === "agent"
        ? (await db.select().from(agents).where(eq(agents.userId, actor.id)).limit(1))[0] ?? null
        : null;

    return c.json({
      user: { ...publicUser(user), avatarFileId: user.avatarFileId, lastActiveAt: user.lastActiveAt, agent: agentProfile },
      counts: { notificationsUnread: unread.value, teamUnread: teamUnread.value },
    });
  });

  app.patch("/me", requireAuth, rateLimit({ scope: "me.patch", limit: 30, windowSeconds: 60, key: actorKey }), async (c: AppContext) => {
    const actor = c.get("actor");
    const body = profileSchema.parse(await c.req.json());
    if (body.avatarFileId) {
      const [file] = await db.select().from(files).where(eq(files.id, body.avatarFileId)).limit(1);
      if (!file || file.ownerId !== actor.id) fail("FORBIDDEN", "You can only use your own files as an avatar.", 403);
      if (file.status !== "ready") fail("CONFLICT", "Avatar file is not ready.", 409);
      if (file.resourceType || file.resourceId) fail("CONFLICT", "Avatar files must be unattached uploads.", 409);
    }
    await db.update(users).set({ ...body, updatedAt: new Date().toISOString() }).where(eq(users.id, actor.id));
    const [user] = await db.select().from(users).where(eq(users.id, actor.id)).limit(1);
    return c.json({ user: publicUser(user) });
  });

  app.post("/me/2fa/enroll", requireAuth, rateLimit({ scope: "auth.2fa_enroll", limit: 5, windowSeconds: 60 * 60, key: actorKey }), async (c: AppContext) => {
    const actor = c.get("actor");
    if (actor.role === "admin") fail("CONFLICT", "Admin accounts already require two-factor authentication.", 409);
    const [user] = await db.select().from(users).where(eq(users.id, actor.id)).limit(1);
    if (!user) fail("UNAUTHORIZED", "User not found.", 401);
    if (user.twoFactorEnabled) fail("CONFLICT", "Two-factor authentication is already enabled.", 409);
    const challenge = await createTwoFactorChallenge(user);
    return c.json({ challengeId: challenge.challengeId, debugCode: challenge.debugCode });
  });

  app.post("/me/2fa/enroll/verify", requireAuth, rateLimit({ scope: "auth.2fa_enroll_verify", limit: 10, windowSeconds: 60 * 60, key: actorKey }), async (c: AppContext) => {
    const actor = c.get("actor");
    const body = twoFactorVerifySchema.parse(await c.req.json());
    const [challenge] = await db
      .select()
      .from(twoFactorChallenges)
      .where(and(eq(twoFactorChallenges.id, body.challengeId), eq(twoFactorChallenges.userId, actor.id), isNull(twoFactorChallenges.usedAt), gt(twoFactorChallenges.expiresAt, new Date().toISOString())))
      .limit(1);
    if (!challenge) fail("UNAUTHORIZED", "Invalid or expired verification code.", 401);
    if (challenge.attempts >= 5) fail("RATE_LIMITED", "Too many verification attempts.", 429);
    if (challenge.codeHash !== hashToken(body.code)) {
      await db.update(twoFactorChallenges).set({ attempts: challenge.attempts + 1 }).where(eq(twoFactorChallenges.id, challenge.id));
      fail("UNAUTHORIZED", "Invalid or expired verification code.", 401);
    }
    await db.transaction(async (tx) => {
      await tx.update(users).set({ twoFactorEnabled: true, updatedAt: new Date().toISOString() }).where(eq(users.id, actor.id));
      await tx.update(twoFactorChallenges).set({ usedAt: new Date().toISOString() }).where(eq(twoFactorChallenges.id, challenge.id));
    });
    await audit(actor, "two_factor_enabled", "user", actor.id, {}, c.get("requestId"));
    return c.json({ ok: true, twoFactorEnabled: true });
  });

  app.post("/me/2fa/disable", requireAuth, rateLimit({ scope: "auth.2fa_disable", limit: 5, windowSeconds: 60 * 60, key: actorKey }), async (c: AppContext) => {
    const actor = c.get("actor");
    if (actor.role === "admin") fail("FORBIDDEN", "Admin accounts cannot disable two-factor authentication.", 403);
    const body = twoFactorDisableSchema.parse(await c.req.json());
    const [user] = await db.select().from(users).where(eq(users.id, actor.id)).limit(1);
    if (!user) fail("UNAUTHORIZED", "User not found.", 401);
    const passwordOk = await verify(user.passwordHash, body.password).catch(() => false);
    if (!passwordOk) fail("UNAUTHORIZED", "Incorrect password.", 401);
    await db.update(users).set({ twoFactorEnabled: false, updatedAt: new Date().toISOString() }).where(eq(users.id, actor.id));
    await audit(actor, "two_factor_disabled", "user", actor.id, {}, c.get("requestId"));
    return c.json({ ok: true, twoFactorEnabled: false });
  });

  app.get("/sessions", requireAuth, async (c: AppContext) => {
    const actor = c.get("actor");
    const includeRevoked = c.req.query("includeRevoked") === "true";
    const nowIso = new Date().toISOString();
    const filters = [eq(userSessions.userId, actor.id)];
    if (!includeRevoked) {
      filters.push(isNull(userSessions.revokedAt));
      filters.push(gt(userSessions.expiresAt, nowIso));
    }
    const rows = await db
      .select({
        id: userSessions.id,
        userAgent: userSessions.userAgent,
        expiresAt: userSessions.expiresAt,
        revokedAt: userSessions.revokedAt,
        createdAt: userSessions.createdAt,
      })
      .from(userSessions)
      .where(and(...filters))
      .orderBy(desc(userSessions.createdAt))
      .limit(100);

    return c.json({ items: rows.map((row) => ({ ...row, current: row.id === actor.sessionId })) });
  });

  app.delete("/sessions/:id", requireAuth, rateLimit({ scope: "sessions.revoke", limit: 20, windowSeconds: 60, key: actorKey }), async (c: AppContext) => {
    const actor = c.get("actor");
    const sessionId = z.string().min(1).parse(c.req.param("id"));
    await db
      .update(userSessions)
      .set({ revokedAt: new Date().toISOString() })
      .where(and(eq(userSessions.id, sessionId), eq(userSessions.userId, actor.id), isNull(userSessions.revokedAt)));

    await audit(actor, "session_revoked", "session", sessionId, {}, c.get("requestId"));
    if (sessionId === actor.sessionId) {
      deleteCookie(c, "access_token", { path: "/" });
      deleteCookie(c, "refresh_token", { path: "/" });
    } else {
      await publishEvent([userChannel(actor.id)], "force:logout", { resourceId: sessionId, sessionId, reason: "session_revoked" });
    }
    return c.json({ ok: true });
  });

  app.post("/admin/users", requireAuth, requireRole("admin"), rateLimit({ scope: "admin.users.create", limit: 30, windowSeconds: 60 * 60, key: actorKey }), async (c: AppContext) => {
    const actor = c.get("actor");
    const body = createUserSchema.parse(await c.req.json());
    const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, body.email)).limit(1);
    if (existing) fail("CONFLICT", "An account with this email already exists.", 409);
    const id = randomUUID();
    const passwordHash = await hash(body.password);

    await db.transaction(async (tx) => {
      await tx.insert(users).values({
        id,
        role: "agent",
        email: body.email,
        passwordHash,
        displayName: body.displayName,
        phone: body.phone,
      });
      await tx.insert(agents).values({ userId: id, skills: body.skills ?? [] });
    });

    await audit(actor, "user_created", "user", id, { role: "agent" }, c.get("requestId"));
    await sendNewAccountEmail(body.email).catch((error) => console.error("new account email failed", error));
    const [created] = await db.select().from(users).where(eq(users.id, id)).limit(1);
    return c.json({ user: publicUser(created) }, 201);
  });

  app.post("/admin/customer-invites", requireAuth, requireRole("admin"), rateLimit({ scope: "admin.customer_invites", limit: 30, windowSeconds: 60 * 60, key: actorKey }), async (c: AppContext) => {
    const actor = c.get("actor");
    const body = customerInviteSchema.parse(await c.req.json());
    const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, body.email)).limit(1);
    if (existing) fail("CONFLICT", "An account with this email already exists.", 409);
    const id = randomUUID();
    const passwordHash = await hash(randomBytes(32).toString("base64url"));

    await db.transaction(async (tx) => {
      await tx.insert(users).values({
        id,
        role: "customer",
        email: body.email,
        passwordHash,
        displayName: body.displayName,
        phone: body.phone,
        status: "pending_approval",
      });
      await tx.insert(customers).values({ userId: id });
    });

    const token = await createSetupToken(id);
    await audit(actor, "customer_invited", "user", id, {}, c.get("requestId"));
    await notifyAdmins("customer_pending_approval", "user", id, "Customer awaiting approval", `${body.displayName} was invited and is waiting for approval.`, "customer-pending");
    await sendCustomerInvite(body.email, token).catch((error) => console.error("customer invite email failed", error));
    const [created] = await db.select().from(users).where(eq(users.id, id)).limit(1);
    await publishEvent([adminChannel], "customer:pending_approval", { resourceId: id, userId: id, actor });
    return c.json({ user: publicUser(created), debugSetupToken: isProduction ? undefined : token }, 201);
  });

  app.get("/admin/users", requireAuth, requireRole("admin"), async (c: AppContext) => {
    const actor = c.get("actor");
    const role = z.enum(["admin", "agent", "customer"]).optional().parse(c.req.query("role"));
    const filters = role ? eq(users.role, role) : undefined;
    const adminCount = await activeAdminCount();
    const rows = await db
      .select({ id: users.id, role: users.role, email: users.email, displayName: users.displayName, status: users.status, createdAt: users.createdAt, lastActiveAt: users.lastActiveAt })
      .from(users)
      .where(filters)
      .orderBy(desc(users.createdAt))
      .limit(100);
    return c.json({ items: rows.map((row) => ({ ...row, availableActions: adminUserActions(row, actor.id, adminCount) })) });
  });

  app.get("/admin/agents", requireAuth, requireRole("admin"), async (c: AppContext) => {
    const actor = c.get("actor");
    const adminCount = await activeAdminCount();
    const rows = await db
      .select({
        id: users.id,
        email: users.email,
        displayName: users.displayName,
        status: users.status,
        availability: agents.availability,
        skills: agents.skills,
        capacity: agents.capacity,
        lastActiveAt: users.lastActiveAt,
        lastAssignedAt: agents.lastAssignedAt,
        activeChats: sql<number>`sum(case when ${supportChats.status} = 'open' then 1 else 0 end)`,
        waitingChats: sql<number>`sum(case when ${supportChats.status} = 'waiting' then 1 else 0 end)`,
      })
      .from(agents)
      .innerJoin(users, eq(users.id, agents.userId))
      .leftJoin(supportChats, eq(supportChats.assignedAgentId, agents.userId))
      .groupBy(users.id, agents.userId)
      .limit(100);
    return c.json({ items: rows.map((row) => ({ ...row, availableActions: adminUserActions({ id: row.id, role: "agent", status: row.status }, actor.id, adminCount) })) });
  });

  app.get("/admin/agents/:id", requireAuth, requireRole("admin"), async (c: AppContext) => {
    const actor = c.get("actor");
    const targetId = z.string().min(1).parse(c.req.param("id"));
    const [row] = await db
      .select({
        id: users.id,
        email: users.email,
        displayName: users.displayName,
        phone: users.phone,
        avatarFileId: users.avatarFileId,
        status: users.status,
        timezone: users.timezone,
        lastActiveAt: users.lastActiveAt,
        createdAt: users.createdAt,
        availability: agents.availability,
        skills: agents.skills,
        capacity: agents.capacity,
        lastAssignedAt: agents.lastAssignedAt,
        activeChats: sql<number>`sum(case when ${supportChats.status} = 'open' then 1 else 0 end)`,
        waitingChats: sql<number>`sum(case when ${supportChats.status} = 'waiting' then 1 else 0 end)`,
      })
      .from(agents)
      .innerJoin(users, eq(users.id, agents.userId))
      .leftJoin(supportChats, eq(supportChats.assignedAgentId, agents.userId))
      .where(eq(agents.userId, targetId))
      .groupBy(users.id, agents.userId)
      .limit(1);
    if (!row) fail("NOT_FOUND", "Agent was not found.", 404);
    const adminCount = await activeAdminCount();
    return c.json({
      agent: {
        ...row,
        availableActions: adminUserActions({ id: row.id, role: "agent", status: row.status }, actor.id, adminCount),
      },
    });
  });

  app.get("/admin/customers", requireAuth, requireRole("admin"), async (c: AppContext) => {
    const actor = c.get("actor");
    const adminCount = await activeAdminCount();
    const rows = await db
      .select({
        id: users.id,
        email: users.email,
        displayName: users.displayName,
        status: users.status,
        accountStatus: customers.accountStatus,
        tags: customers.tags,
        chatId: supportChats.id,
        chatStatus: supportChats.status,
      })
      .from(customers)
      .innerJoin(users, eq(users.id, customers.userId))
      .leftJoin(supportChats, eq(supportChats.customerId, customers.userId))
      .limit(100);
    return c.json({ items: rows.map((row) => ({ ...row, availableActions: adminUserActions({ id: row.id, role: "customer", status: row.status }, actor.id, adminCount) })) });
  });

  app.post("/admin/users/:id/approve", requireAuth, requireRole("admin"), rateLimit({ scope: "admin.users.approve", limit: 60, windowSeconds: 60, key: actorKey }), async (c: AppContext) => {
    const actor = c.get("actor");
    const targetId = z.string().min(1).parse(c.req.param("id"));
    const [target] = await db.select().from(users).where(eq(users.id, targetId)).limit(1);
    if (!target) fail("NOT_FOUND", "User was not found.", 404);
    if (target.role !== "customer" || target.status !== "pending_approval") fail("CONFLICT", "Only pending customers can be approved.", 409);

    await db.transaction(async (tx) => {
      await tx.update(users).set({ status: "active", updatedAt: new Date().toISOString() }).where(eq(users.id, targetId));
      await tx.insert(supportChats).values({ id: randomUUID(), customerId: targetId, priority: await defaultChatPriority() }).onConflictDoNothing();
    });
    await audit(actor, "customer_approved", "user", targetId, {}, c.get("requestId"));
    await sendCustomerApproved(target.email).catch((error) => console.error("customer approved email failed", error));
    const notificationId = randomUUID();
    const inserted = await db.insert(notifications).values({
      id: notificationId,
      userId: targetId,
      type: "customer_approved",
      resourceType: "user",
      resourceId: targetId,
      title: "Account approved",
      body: "Your account has been approved. You can now sign in.",
      dedupeKey: `customer-approved:${targetId}`,
    }).onConflictDoNothing().returning({ id: notifications.id });
    if (inserted.length) await publishEvent([userChannel(targetId)], "notification:new", { resourceId: notificationId, notificationId, resourceType: "user" });
    const [updated] = await db.select().from(users).where(eq(users.id, targetId)).limit(1);
    await publishEvent([userChannel(targetId), adminChannel], "customer:approved", { resourceId: targetId, userId: targetId, actor });
    return c.json({ user: publicUser(updated) });
  });

  app.get("/admin/dashboard", requireAuth, requireRole("admin"), async (c: AppContext) => {
    const [open] = await db.select({ value: count() }).from(supportChats).where(eq(supportChats.status, "open"));
    const [waiting] = await db.select({ value: count() }).from(supportChats).where(eq(supportChats.status, "waiting"));
    const [unassigned] = await db.select({ value: count() }).from(supportChats).where(and(isNull(supportChats.assignedAgentId), inArray(supportChats.status, ["open", "waiting"])));
    const [activeAgents] = await db.select({ value: count() }).from(users).where(and(eq(users.role, "agent"), eq(users.status, "active")));
    const [pendingCustomers] = await db.select({ value: count() }).from(users).where(and(eq(users.role, "customer"), eq(users.status, "pending_approval")));
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const [resolvedToday] = await db.select({ value: count() }).from(auditLogs).where(and(eq(auditLogs.action, "chat_resolved"), eq(auditLogs.resourceType, "chat"), gte(auditLogs.createdAt, today.toISOString())));
    const [pendingReports] = await db.select({ value: count() }).from(reports).where(eq(reports.status, "pending"));
    return c.json({
      counts: {
        openChats: open.value,
        waitingChats: waiting.value,
        unassignedChats: unassigned.value,
        resolvedToday: resolvedToday.value,
        activeAgents: activeAgents.value,
        pendingCustomers: pendingCustomers.value,
        pendingReports: pendingReports.value,
      },
    });
  });

  app.patch("/admin/users/:id", requireAuth, requireRole("admin"), rateLimit({ scope: "admin.users.patch", limit: 60, windowSeconds: 60, key: actorKey }), async (c: AppContext) => {
    const actor = c.get("actor");
    const targetId = z.string().min(1).parse(c.req.param("id"));
    const body = adminUserPatchSchema.parse(await c.req.json());
    if (targetId === actor.id && body.status === "suspended") fail("CONFLICT", "Admins cannot suspend themselves.", 409);
    const [target] = await db.select().from(users).where(eq(users.id, targetId)).limit(1);
    if (!target) fail("NOT_FOUND", "User was not found.", 404);
    if (target.status === "anonymized") fail("CONFLICT", "Anonymized users cannot be updated.", 409);
    if (body.status === "suspended") await assertNotLastActiveAdmin(target, "suspend");

    await db.transaction(async (tx) => {
      await tx.update(users).set({ ...body, updatedAt: new Date().toISOString() }).where(eq(users.id, targetId));
      if (body.status === "suspended") {
        await tx.update(userSessions).set({ revokedAt: new Date().toISOString() }).where(and(eq(userSessions.userId, targetId), isNull(userSessions.revokedAt)));
        if (target.role === "agent") {
          await tx.update(supportChats).set({ assignedAgentId: null, updatedAt: new Date().toISOString() }).where(eq(supportChats.assignedAgentId, targetId));
          await tx.update(chatAssignments).set({ endedAt: new Date().toISOString() }).where(and(eq(chatAssignments.agentId, targetId), isNull(chatAssignments.endedAt)));
        }
      }
    });

    if (body.status === "suspended") {
      await audit(actor, "user_suspended", "user", targetId, {}, c.get("requestId"));
      await publishEvent([userChannel(targetId)], "force:logout", { resourceId: targetId, reason: "user_suspended" });
    } else {
      await audit(actor, "user_updated", "user", targetId, body, c.get("requestId"));
    }
    const [updated] = await db.select().from(users).where(eq(users.id, targetId)).limit(1);
    return c.json({ user: publicUser(updated) });
  });

  app.delete("/admin/users/:id/anonymize", requireAuth, requireRole("admin"), rateLimit({ scope: "admin.users.anonymize", limit: 30, windowSeconds: 60, key: actorKey }), async (c: AppContext) => {
    const actor = c.get("actor");
    const targetId = z.string().min(1).parse(c.req.param("id"));
    if (targetId === actor.id) fail("CONFLICT", "Admins cannot anonymize themselves.", 409);
    const [target] = await db.select().from(users).where(eq(users.id, targetId)).limit(1);
    if (!target) fail("NOT_FOUND", "User was not found.", 404);
    if (target.status === "anonymized") fail("CONFLICT", "User is already anonymized.", 409);
    await assertNotLastActiveAdmin(target, "anonymize");
    const now = new Date().toISOString();
    await db.transaction(async (tx) => {
      await tx.update(users).set({
        email: `deleted-${targetId}@deleted.local`,
        displayName: "Deleted User",
        phone: null,
        avatarFileId: null,
        status: "anonymized",
        anonymizedAt: now,
        updatedAt: now,
      }).where(eq(users.id, targetId));
      await tx.update(userSessions).set({ revokedAt: now }).where(and(eq(userSessions.userId, targetId), isNull(userSessions.revokedAt)));
      if (target.role === "agent") {
        await tx.update(supportChats).set({ assignedAgentId: null, updatedAt: now }).where(eq(supportChats.assignedAgentId, targetId));
        await tx.update(chatAssignments).set({ endedAt: now }).where(and(eq(chatAssignments.agentId, targetId), isNull(chatAssignments.endedAt)));
      }
      if (target.role === "customer") {
        await tx.update(supportChats).set({ status: "closed", closedAt: now, updatedAt: now }).where(and(eq(supportChats.customerId, targetId), ne(supportChats.status, "closed")));
        const targetChats = await tx.select({ id: supportChats.id }).from(supportChats).where(eq(supportChats.customerId, targetId));
        if (targetChats.length) {
          await tx
            .update(chatAssignments)
            .set({ endedAt: now })
            .where(and(inArray(chatAssignments.chatId, targetChats.map((chat) => chat.id)), isNull(chatAssignments.endedAt)));
        }
      }
    });
    await audit(actor, "user_anonymized", "user", targetId, {}, c.get("requestId"));
    await publishEvent([userChannel(targetId)], "force:logout", { resourceId: targetId, reason: "user_anonymized" });
    return c.json({ ok: true });
  });

  app.delete("/admin/users/:id/sessions", requireAuth, requireRole("admin"), rateLimit({ scope: "admin.sessions.revoke", limit: 20, windowSeconds: 60, key: actorKey }), async (c: AppContext) => {
    const actor = c.get("actor");
    const targetId = z.string().min(1).parse(c.req.param("id"));
    if (targetId === actor.id) fail("CONFLICT", "Admins cannot revoke all of their own sessions from this endpoint.", 409);
    const [target] = await db.select().from(users).where(eq(users.id, targetId)).limit(1);
    if (!target) fail("NOT_FOUND", "User was not found.", 404);
    await assertNotLastActiveAdmin(target, "revoke sessions for");

    await db.update(userSessions).set({ revokedAt: new Date().toISOString() }).where(and(eq(userSessions.userId, targetId), isNull(userSessions.revokedAt)));
    await audit(actor, "session_revoked", "user", targetId, {}, c.get("requestId"));
    await publishEvent([userChannel(targetId)], "force:logout", { resourceId: targetId, reason: "admin_revoked_sessions" });
    return c.json({ ok: true });
  });
}
