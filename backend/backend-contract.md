# evComm Backend Contract

This backend is the source of truth for roles, permissions, state transitions, files, notifications, and realtime hints.

## Auth

- `POST /auth/login` — password check. Admin and any 2FA-enabled user gets `{ requiresTwoFactor, challengeId, debugCode? }`.
- `POST /auth/register` — customer self-registration. Creates a `pending_approval` customer and notifies admins.
- `POST /auth/2fa/verify` — completes login challenge; sets session cookies; returns `{ user, session }`.
- `POST /auth/logout`
- `POST /auth/refresh` — rotates the refresh token; rejects expired sessions.
- `POST /auth/password-reset/request`
- `POST /auth/password-reset/confirm`
- `GET /me` → `{ user, counts }`. For agents the response includes `user.agent: { availability, skills, capacity, lastAssignedAt }`. Every authenticated request updates `users.lastActiveAt` (throttled to 60s per user).
- `PATCH /me` — display name, phone, timezone, notification prefs, avatar (verified file ownership + `ready` status).
- `POST /me/2fa/enroll`
- `POST /me/2fa/enroll/verify`
- `POST /me/2fa/disable` — body `{ password }`; rejected for admin.
- `GET /sessions` — active sessions only by default; `?includeRevoked=true` returns the full history.
- `DELETE /sessions/:id` — revoking another session only closes that session's SSE streams (other sessions stay live).

Login uses constant-time argon2 (dummy hash on user-miss) to mitigate timing-based user enumeration. Refresh tokens rotate on every successful refresh and are rejected if the session row is expired or revoked.

## Admin

- `GET /admin/dashboard` — `{ counts: { openChats, waitingChats, unassignedChats, resolvedToday, activeAgents, pendingCustomers, pendingReports } }`.
- `GET /admin/users`
- `POST /admin/users` — agent role only.
- `POST /admin/customer-invites` — invite + setup token.
- `POST /admin/users/:id/approve` — also auto-creates the customer's support chat row AND sends the customer an "account approved" email.
- `PATCH /admin/users/:id` — `{ status?, displayName? }`. Suspending an agent ends open `chat_assignments` rows and unassigns their chats.
- `DELETE /admin/users/:id/anonymize` — idempotent (rejects if already anonymized). Ends open `chat_assignments` rows for agents; closes open `supportChats` for customers.
- `DELETE /admin/users/:id/sessions`
- `GET /admin/agents`
- `GET /admin/agents/:id`
- `PATCH /admin/agents/:id` — `{ availability?, skills?, capacity? }`.
- `GET /admin/customers`
- `PATCH /admin/customers/:id` — `{ tags?, internalNotes? }`.
- `GET /admin/ratings` — cursor-paginated; includes agent + customer display names and global summary stats.
- `GET /admin/audit-logs` — cursor + filters `action`, `resourceType`, `actorId`.
- `PATCH /admin/settings`
- `PATCH /admin/quick-replies` — body `{ items: string[] }`.

Admins are seed/SQL-only. `POST /admin/users` creates agents only. Customers either self-register or are invited; both require admin approval before login. Admin user/customer/agent list rows include backend-computed `availableActions`.

## Support Chat

- `GET /chats` — supports `?filter=mine|unassigned|waiting|resolved|closed`, `?status=`, `?cursor=`, `?limit=`. List build is fully batched (page-wide IN queries for participants, last messages, and unread counts).
- `POST /chats/current` — customer-only; idempotent.
- `GET /chats/:id` — cursor + capped limit for message history; returns `nextMessageCursor`.
- `POST /chats/:id/messages` — idempotency key required. Response includes attached files and `sender` summary. Support users can send only while the chat is `open` or `waiting`; customers can send on `resolved` to reopen; `closed` rejects all messages.
- `POST /chats/:id/internal-notes` — body only; internal notes do not support file attachments (use chat messages for files).
- `DELETE /internal-notes/:id` — admin or note author soft-deletes an internal note.
- `POST /chats/:id/read`
- `POST /chats/:id/typing` — same write permission as messages; support-side typing is limited to `open`/`waiting` chats.
- `POST /chats/:id/claim` — atomic; only unassigned `open`/`waiting` chats.
- `POST /chats/:id/assign` — admin-only; only `open`/`waiting` chats.
- `POST /chats/:id/transfer` — only `open`/`waiting` chats.
- `POST /chats/:id/takeover` — admin join; optional `reassignToSelf` cleanly ends the open `chat_assignments` row.
- `DELETE /chats/:id/takeover` — admin leave (sets `chat_admin_participants.leftAt`).
- `POST /chats/:id/status` — no-op (returns current chat) when transitioning to the same status. Closing also ends the open `chat_assignments` row.
- `PATCH /chats/:id/meta` — priority, category, tags.
- `POST /chats/:id/ratings` — customer-only; idempotency key required; one per `(chatId, supportCycle, customerId)`.
- `DELETE /messages/:id`
- `GET /customers/:id` — admin sees all. Agent sees only when the customer's current chat is assigned to them or unassigned (PII-scoped). Returns identity, customer profile (tags, internalNotes), chat summary, rating stats.
- `GET /me/ratings` — agent-only; own ratings + summary.

Chat responses include backend-computed `availableActions`, `unreadCount`, `lastMessagePreview`. Message rows include `sender: { id, displayName, role, status } | null`. Internal note rows include `author` with the same shape.

## Files

- `POST /files/upload-intents`
- `POST /files/:id/complete`
- `GET /files/:id/download`

File access follows parent resource access. Chat upload intents follow message-write permissions, so support users cannot attach into `resolved` or `closed` cycles. Production upload completion verifies object metadata in R2. Files are immutable after `ready`; detach/delete is not supported.

## Announcements

- `GET /announcements` — batched (reactions, comment counts, files via grouped IN queries).
- `GET /announcements/:id` — single-announcement detail with reaction counts, comment count, files, and `availableActions`.
- `GET /announcements/:id/comments` — cursor-paginated; each comment includes an `author` summary.
- `POST /announcements`
- `PATCH /announcements/:id`
- `POST /announcements/:id/publish`
- `DELETE /announcements/:id`
- `POST /announcements/:id/reactions` — body `{ emoji }`.
- `DELETE /announcements/:id/reactions` — body `{ emoji }`; toggles the reaction off.
- `POST /announcements/:id/comments`
- `DELETE /announcement-comments/:id`

Customers only see published announcements targeted to them. Reactions, comments, and announcement file downloads enforce the same targeting rules.

## Reports

- `GET /reports` — batched file fetch.
- `GET /reports/:id`
- `POST /reports` — idempotency key required; `evidenceMessageIds` snapshot at submit time.
- `PATCH /reports/:id/status` — emits in-app notification AND sends a slow-lane email to the customer. No-op when the status is unchanged (notification + email are skipped).
- `POST /reports/:id/internal-comments`

Customers see only their own reports. Admin-only detail view includes internal comments. List/detail responses include files and backend-computed `availableActions`.

## Notifications

- `GET /notifications`
- `POST /notifications/:id/read`
- `POST /notifications/read-all`

Dedupe via `(userId, dedupeKey)` unique index.

## Team Chat

- `GET /team/messages` — batched file fetch.
- `POST /team/messages` — idempotency key required.
- `POST /team/messages/read`
- `DELETE /team/messages/:id`

Admin/agent only. There are no DMs. Mentions notify mentioned internal users. Admin can delete any team message; agents can delete their own.

## Settings, Search, Realtime

- `GET /settings` — defaults include `defaultChatPriority` and `quickReplies`.
- `GET /search?q=...` — role-aware result groups; result-count capped.
- `GET /events` — SSE stream. On `force:logout`, the backend aborts matching live streams: if the payload carries a `sessionId`, only that session's streams close; otherwise all of the user's streams close (suspend, anonymize, password reset, admin-revoke-all).
- `GET /events/state` — `{ reconnect: { refetch, unreadNotifications, serverTime } }`.

SSE is a delivery hint. Clients should refetch the `refetch` list after reconnect. There is no per-event replay buffer (`outbox_events` is intentionally not in the schema).

## Email Side Effects

Backend triggers email only on:

- Security events: password reset, 2FA code, security alert, new agent account, customer invite.
- Slow-lane in-app events: `customer_approved` → customer (account is ready), `chat:resolved` → customer (rating nudge), `report:status_changed` → customer.

All other notifications stay in-app + SSE only. Throttling is implicit via the notification dedupe key.

## Verification

- `npm run typecheck`
- `npm run build`
- `npm test` (isolated file-backed SQLite, runs all migrations)
- `npm run db:migrate` (live Turso)
- `npm run verify:schema` (live Turso)
- `npm run smoke` (against a running local backend)
