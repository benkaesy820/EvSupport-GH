import { streamSSE } from "hono/streaming";
import type { Hono } from "hono";
import { fail, requireAuth, type Actor, type AppContext } from "./security.js";
import { db } from "./db.js";
import { count, eq, isNull, and } from "drizzle-orm";
import { notifications } from "./schema.js";

type EventPayload = {
  type: string;
  resourceId?: string;
  actor?: Pick<Actor, "id" | "role" | "displayName">;
  createdAt: string;
  [key: string]: unknown;
};

type Client = {
  id: string;
  actor: Actor;
  channels: Set<string>;
  send: (event: string, data: EventPayload) => Promise<void>;
  close: () => void;
};

const clients = new Map<string, Client>();
const clientsByUser = new Map<string, Set<Client>>();
const MAX_STREAMS_PER_USER = 5;
const MAX_STREAMS_GLOBAL = 1000;

export function userChannel(userId: string) {
  return `user:${userId}`;
}

export function chatChannel(chatId: string) {
  return `chat:${chatId}`;
}

export const adminChannel = "admin";
export const teamChannel = "team";

export async function publishEvent(channels: string[], event: string, data: Omit<EventPayload, "type" | "createdAt">) {
  const payload: EventPayload = {
    type: event,
    createdAt: new Date().toISOString(),
    ...data,
  };

  const uniqueChannels = new Set(channels);
  const targets = new Set<Client>();
  const nonUserChannels = new Set<string>();
  for (const channel of uniqueChannels) {
    if (channel.startsWith("user:")) {
      const userId = channel.slice("user:".length);
      for (const client of clientsByUser.get(userId) ?? []) targets.add(client);
    } else {
      nonUserChannels.add(channel);
    }
  }
  if (nonUserChannels.size) {
    for (const client of clients.values()) {
      if ([...nonUserChannels].some((channel) => client.channels.has(channel))) targets.add(client);
    }
  }

  await Promise.all([...targets].map((client) => client.send(event, payload).catch(() => undefined)));

  if (event === "force:logout") {
    const scopedSessionId = typeof payload.sessionId === "string" ? payload.sessionId : null;
    for (const target of targets) {
      if (!scopedSessionId || target.actor.sessionId === scopedSessionId) target.close();
    }
  }
}

export function closeAllStreams() {
  for (const client of clients.values()) client.close();
}

function channelsFor(actor: Actor) {
  const channels = new Set([userChannel(actor.id)]);
  if (actor.role === "admin") channels.add(adminChannel);
  if (actor.role === "admin" || actor.role === "agent") channels.add(teamChannel);
  return channels;
}

function trackClient(client: Client) {
  clients.set(client.id, client);
  const bucket = clientsByUser.get(client.actor.id) ?? new Set<Client>();
  bucket.add(client);
  clientsByUser.set(client.actor.id, bucket);
}

function untrackClient(client: Client) {
  clients.delete(client.id);
  const bucket = clientsByUser.get(client.actor.id);
  if (!bucket) return;
  bucket.delete(client);
  if (!bucket.size) clientsByUser.delete(client.actor.id);
}

export function registerEventRoutes(app: Hono) {
  app.get("/events/state", requireAuth, async (c: AppContext) => {
    const actor = c.get("actor");
    const [unreadNotifications] = await db.select({ value: count() }).from(notifications).where(and(eq(notifications.userId, actor.id), isNull(notifications.readAt)));
    return c.json({
      reconnect: {
        refetch: ["me", "notifications", "chats", "openChatMessages", "teamMessages"],
        unreadNotifications: unreadNotifications.value,
        serverTime: new Date().toISOString(),
      },
    });
  });

  app.get("/events", requireAuth, async (c: AppContext) => {
    const actor = c.get("actor");
    if ((clientsByUser.get(actor.id)?.size ?? 0) >= MAX_STREAMS_PER_USER) fail("RATE_LIMITED", "Too many realtime streams for this user.", 429);
    if (clients.size >= MAX_STREAMS_GLOBAL) fail("RATE_LIMITED", "Too many realtime streams.", 429);

    return streamSSE(c, async (stream) => {
      const clientId = crypto.randomUUID();
      let closed = false;
      const client: Client = {
        id: clientId,
        actor,
        channels: channelsFor(actor),
        send: (event, data) => stream.writeSSE({ event, data: JSON.stringify(data), id: crypto.randomUUID() }),
        close: () => {
          if (closed) return;
          closed = true;
          stream.abort();
        },
      };

      trackClient(client);
      await stream.writeSSE({
        event: "connected",
        data: JSON.stringify({ type: "connected", createdAt: new Date().toISOString() }),
        id: crypto.randomUUID(),
      });

      const keepAlive = setInterval(() => {
        stream.write(": keep-alive\n\n").catch(() => undefined);
      }, 25_000);

      stream.onAbort(() => {
        clearInterval(keepAlive);
        untrackClient(client);
      });

      while (!stream.aborted && !closed) {
        await stream.sleep(60_000);
      }
    });
  });
}
