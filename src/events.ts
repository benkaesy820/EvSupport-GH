import { streamSSE } from "hono/streaming";
import type { Hono } from "hono";
import { requireAuth, type Actor, type AppContext } from "./security.js";
import { db } from "./db.js";
import { count, eq, isNull, and } from "drizzle-orm";
import { notifications, outboxEvents } from "./schema.js";

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
};

const clients = new Map<string, Client>();

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
  await db.insert(outboxEvents).values({
    id: crypto.randomUUID(),
    event,
    channels: JSON.stringify([...uniqueChannels]),
    payload: JSON.stringify(payload),
  });
  await Promise.all(
    [...clients.values()]
      .filter((client) => [...uniqueChannels].some((channel) => client.channels.has(channel)))
      .map((client) => client.send(event, payload).catch(() => undefined)),
  );
}

function channelsFor(actor: Actor) {
  const channels = new Set([userChannel(actor.id)]);
  if (actor.role === "admin") channels.add(adminChannel);
  if (actor.role === "admin" || actor.role === "agent") channels.add(teamChannel);
  return channels;
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

    return streamSSE(c, async (stream) => {
      const clientId = crypto.randomUUID();
      const client: Client = {
        id: clientId,
        actor,
        channels: channelsFor(actor),
        send: (event, data) => stream.writeSSE({ event, data: JSON.stringify(data), id: crypto.randomUUID() }),
      };

      clients.set(clientId, client);
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
        clients.delete(clientId);
      });

      while (!stream.aborted) {
        await stream.sleep(60_000);
      }
    });
  });
}
