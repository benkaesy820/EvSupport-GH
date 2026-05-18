import { randomBytes, randomInt, randomUUID } from "node:crypto";
import { hash, verify } from "@node-rs/argon2";
import { Hono } from "hono";
import { getCookie, deleteCookie } from "hono/cookie";
import { jwtVerify } from "jose";
import { and, count, desc, eq, gt, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "./db.js";
import { agents, customers, notifications, passwordResetTokens, supportChats, teamMessages, twoFactorChallenges, userSessions, users } from "./schema.js";
import { audit, actorKey, fail, hashToken, ipKey, rateLimit, requireAuth, requireRole, setAuthCookies, signAccessToken, signRefreshToken, type Actor, type AppContext } from "./security.js";
import { config, isProduction } from "./config.js";
import { adminChannel, publishEvent, userChannel } from "./events.js";
import { sendCustomerInvite, sendNewAccountEmail, sendPasswordReset, sendSecurityAlert, sendTwoFactorCode } from "./email.js";

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
});
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
    status: row.status,
    timezone: row.timezone,
    twoFactorEnabled: row.twoFactorEnabled,
  };
}

async function notifyAdmins(type: string, resourceType: string, resourceId: string, title: string, body: string, dedupePrefix: string) {
  const admins = await db.select({ id: users.id }).from(users).where(and(eq(users.role, "admin"), eq(users.status, "active")));
  for (const admin of admins) {
    const notificationId = randomUUID();
    await db
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
      .onConflictDoNothing();
    await publishEvent([userChannel(admin.id)], "notification:new", { resourceId: notificationId, notificationId, resourceType });
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
    expiresAt,
  });

  setAuthCookies(c, accessToken, refreshToken);
  return { accessToken, refreshToken, sessionId, expiresAt };
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
    return c.json({ user: publicUser(created), approvalRequired: true }, 201);
  });

  app.post("/auth/login", rateLimit({ scope: "auth.login", limit: 5, windowSeconds: 10 * 60, key: ipKey }), async (c: AppContext) => {
    const body = loginSchema.parse(await c.req.json());
    const [user] = await db.select().from(users).where(eq(users.email, body.email)).limit(1);

    if (!user || !(await verify(user.passwordHash, body.password))) {
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

    const [row] = await db
      .select({ user: users, session: userSessions })
      .from(users)
      .innerJoin(userSessions, eq(userSessions.id, sessionId))
      .where(and(eq(users.id, userId), eq(userSessions.refreshTokenHash, hashToken(refreshToken)), isNull(userSessions.revokedAt)))
      .limit(1);

    if (!row || row.user.status !== "active") fail("UNAUTHORIZED", "Invalid refresh token.", 401);
    const accessToken = await signAccessToken({ id: row.user.id, role: row.user.role }, sessionId);
    setAuthCookies(c, accessToken, refreshToken);
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
                sql`${teamMessages.senderId} is not ${actor.id}`,
                sql`not exists (select 1 from team_message_reads tmr where tmr.message_id = ${teamMessages.id} and tmr.user_id = ${actor.id})`,
              ),
            )
        : [{ value: 0 }];
    return c.json({ user: publicUser(user), counts: { notificationsUnread: unread.value, teamUnread: teamUnread.value } });
  });

  app.patch("/me", requireAuth, async (c: AppContext) => {
    const actor = c.get("actor");
    const body = profileSchema.parse(await c.req.json());
    await db.update(users).set({ ...body, updatedAt: new Date().toISOString() }).where(eq(users.id, actor.id));
    const [user] = await db.select().from(users).where(eq(users.id, actor.id)).limit(1);
    return c.json({ user: publicUser(user) });
  });

  app.get("/sessions", requireAuth, async (c: AppContext) => {
    const actor = c.get("actor");
    const rows = await db
      .select({
        id: userSessions.id,
        userAgent: userSessions.userAgent,
        expiresAt: userSessions.expiresAt,
        revokedAt: userSessions.revokedAt,
        createdAt: userSessions.createdAt,
      })
      .from(userSessions)
      .where(eq(userSessions.userId, actor.id))
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
    await sendNewAccountEmail(body.email, body.password).catch((error) => console.error("new account email failed", error));
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
    return c.json({ user: publicUser(created), debugSetupToken: isProduction ? undefined : token }, 201);
  });

  app.get("/admin/users", requireAuth, requireRole("admin"), async (c: AppContext) => {
    const role = c.req.query("role");
    const filters = role === "admin" || role === "agent" || role === "customer" ? eq(users.role, role) : undefined;
    const rows = await db
      .select({ id: users.id, role: users.role, email: users.email, displayName: users.displayName, status: users.status, createdAt: users.createdAt, lastActiveAt: users.lastActiveAt })
      .from(users)
      .where(filters)
      .orderBy(desc(users.createdAt))
      .limit(100);
    return c.json({ items: rows });
  });

  app.get("/admin/agents", requireAuth, requireRole("admin"), async (c: AppContext) => {
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
    return c.json({ items: rows });
  });

  app.get("/admin/customers", requireAuth, requireRole("admin"), async (c: AppContext) => {
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
    return c.json({ items: rows });
  });

  app.post("/admin/users/:id/approve", requireAuth, requireRole("admin"), async (c: AppContext) => {
    const actor = c.get("actor");
    const targetId = z.string().min(1).parse(c.req.param("id"));
    const [target] = await db.select().from(users).where(eq(users.id, targetId)).limit(1);
    if (!target) fail("NOT_FOUND", "User was not found.", 404);
    if (target.role !== "customer" || target.status !== "pending_approval") fail("CONFLICT", "Only pending customers can be approved.", 409);

    await db.update(users).set({ status: "active", updatedAt: new Date().toISOString() }).where(eq(users.id, targetId));
    await audit(actor, "customer_approved", "user", targetId, {}, c.get("requestId"));
    const notificationId = randomUUID();
    await db.insert(notifications).values({
      id: notificationId,
      userId: targetId,
      type: "customer_approved",
      resourceType: "user",
      resourceId: targetId,
      title: "Account approved",
      body: "Your account has been approved. You can now sign in.",
      dedupeKey: `customer-approved:${targetId}`,
    }).onConflictDoNothing();
    await publishEvent([userChannel(targetId)], "notification:new", { resourceId: notificationId, notificationId, resourceType: "user" });
    const [updated] = await db.select().from(users).where(eq(users.id, targetId)).limit(1);
    return c.json({ user: publicUser(updated) });
  });

  app.get("/admin/dashboard", requireAuth, requireRole("admin"), async (c: AppContext) => {
    const [open] = await db.select({ value: count() }).from(supportChats).where(eq(supportChats.status, "open"));
    const [waiting] = await db.select({ value: count() }).from(supportChats).where(eq(supportChats.status, "waiting"));
    const [unassigned] = await db.select({ value: count() }).from(supportChats).where(isNull(supportChats.assignedAgentId));
    const [activeAgents] = await db.select({ value: count() }).from(users).where(and(eq(users.role, "agent"), eq(users.status, "active")));
    const [pendingReports] = await db.select({ value: count() }).from(notifications).where(and(eq(notifications.resourceType, "report"), isNull(notifications.readAt)));
    return c.json({
      counts: {
        openChats: open.value,
        waitingChats: waiting.value,
        unassignedChats: unassigned.value,
        activeAgents: activeAgents.value,
        pendingReportNotifications: pendingReports.value,
      },
    });
  });

  app.patch("/admin/users/:id", requireAuth, requireRole("admin"), async (c: AppContext) => {
    const actor = c.get("actor");
    const targetId = z.string().min(1).parse(c.req.param("id"));
    const body = adminUserPatchSchema.parse(await c.req.json());
    if (targetId === actor.id && body.status === "suspended") fail("CONFLICT", "Admins cannot suspend themselves.", 409);
    const [target] = await db.select().from(users).where(eq(users.id, targetId)).limit(1);
    if (!target) fail("NOT_FOUND", "User was not found.", 404);

    await db.transaction(async (tx) => {
      await tx.update(users).set({ ...body, updatedAt: new Date().toISOString() }).where(eq(users.id, targetId));
      if (body.status === "suspended") {
        await tx.update(userSessions).set({ revokedAt: new Date().toISOString() }).where(and(eq(userSessions.userId, targetId), isNull(userSessions.revokedAt)));
        if (target.role === "agent") {
          await tx.update(supportChats).set({ assignedAgentId: null, updatedAt: new Date().toISOString() }).where(eq(supportChats.assignedAgentId, targetId));
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

  app.delete("/admin/users/:id/anonymize", requireAuth, requireRole("admin"), async (c: AppContext) => {
    const actor = c.get("actor");
    const targetId = z.string().min(1).parse(c.req.param("id"));
    if (targetId === actor.id) fail("CONFLICT", "Admins cannot anonymize themselves.", 409);
    const [target] = await db.select().from(users).where(eq(users.id, targetId)).limit(1);
    if (!target) fail("NOT_FOUND", "User was not found.", 404);
    await db.transaction(async (tx) => {
      await tx.update(users).set({
        email: `deleted-${targetId}@deleted.local`,
        displayName: "Deleted User",
        phone: null,
        avatarFileId: null,
        status: "anonymized",
        anonymizedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }).where(eq(users.id, targetId));
      await tx.update(userSessions).set({ revokedAt: new Date().toISOString() }).where(and(eq(userSessions.userId, targetId), isNull(userSessions.revokedAt)));
      if (target.role === "agent") await tx.update(supportChats).set({ assignedAgentId: null, updatedAt: new Date().toISOString() }).where(eq(supportChats.assignedAgentId, targetId));
    });
    await audit(actor, "user_anonymized", "user", targetId, {}, c.get("requestId"));
    await publishEvent([userChannel(targetId)], "force:logout", { resourceId: targetId, reason: "user_anonymized" });
    return c.json({ ok: true });
  });

  app.delete("/admin/users/:id/sessions", requireAuth, requireRole("admin"), rateLimit({ scope: "admin.sessions.revoke", limit: 20, windowSeconds: 60, key: actorKey }), async (c: AppContext) => {
    const actor = c.get("actor");
    const targetId = z.string().min(1).parse(c.req.param("id"));
    if (targetId === actor.id) fail("CONFLICT", "Admins cannot revoke all of their own sessions from this endpoint.", 409);

    await db.update(userSessions).set({ revokedAt: new Date().toISOString() }).where(and(eq(userSessions.userId, targetId), isNull(userSessions.revokedAt)));
    await audit(actor, "session_revoked", "user", targetId, {}, c.get("requestId"));
    await publishEvent([userChannel(targetId)], "force:logout", { resourceId: targetId, reason: "admin_revoked_sessions" });
    return c.json({ ok: true });
  });
}
