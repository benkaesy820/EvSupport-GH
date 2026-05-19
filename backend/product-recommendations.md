# SupportChat Build Specification

This document defines the product we build: a small, professional WhatsApp-style customer support platform.

It includes only the features that ship. Anything not listed here is out of scope.

## Product Goal

A simple customer support messaging system that feels easy for customers and operationally strong for support teams.

- Customers feel like they are messaging support.
- Agents work from one clean inbox.
- Admins have enough control to run the support operation professionally.

## Locked Exclusions

These features are intentionally NOT in the product. They will not be added.

- **Auto-assignment** — manual claim + admin assign is the model. The `autoAssignmentEnabled` setting exists as a frontend hint only; the backend never auto-assigns.
- **Super-admin role** — three roles only: `admin`, `agent`, `customer`.
- **Public admin creation** — admins are seed/SQL-only. Self-registration is customer-only. `POST /admin/users` creates agents only.
- **Private DMs** — there is one shared Team Chat. Customer-specific discussion lives as internal notes on the customer's chat.
- **Admin direct customer creation** — admins invite customers via `POST /admin/customer-invites`. The customer sets their own password via the reset-token flow and then waits for approval. There is no "create a customer with a password I know" path.
- **Report discussion threads** — reports are one-way submission + admin status updates + admin-only internal comments. Two-way discussion belongs in the support chat.
- **File detach/delete** — files are immutable after upload-complete; resource visibility controls access. Soft-deleting a message hides its attachments to viewers.
- **SSE replay** — `Last-Event-ID` replay buffers are not implemented. SSE is a delivery hint; clients refetch state on reconnect via `GET /events/state`.
- **Complex email templates** — backend sends short text-only emails with a single link back to the app. Rich rendering lives in the frontend.
- **Malware scanning** — file-type whitelist and size cap only.
- **Advanced invite lifecycle** — single-shot setup token + admin approval. No reminder jobs, no rotation flows, no multi-step onboarding.

## Roles

### Admin
Admin controls the system. Admin can:
- Manage agents (create, suspend, anonymize, update availability/skills/capacity)
- Manage customers (approve, suspend, anonymize, edit tags + internal notes)
- View all support chats; join or take over any chat; leave a chat
- Assign / reassign / resolve / close chats
- Publish, schedule, edit, delete announcements
- Review reports; update status; add internal comments
- View ratings (global)
- View audit log
- Manage system settings + quick replies
- Suspend users; revoke any user's sessions

### Agent
Agent handles customer support. Agent can:
- View assigned and unassigned chats (inbox filters: mine, unassigned, waiting, resolved, closed)
- Claim unassigned chats; reply; transfer; resolve; mark waiting
- Add internal notes
- Use Team Chat (with mentions)
- Use quick replies (admin-managed)
- View customer profile + history for any chat they can access
- View announcements visible to internal users
- View own ratings
- Manage own profile, availability, optional 2FA

### Customer
Customer requests support. Customer can:
- Use one main support chat
- Send messages and attachments
- View support history
- View targeted published announcements
- React (toggle on/off) and comment on announcements
- Submit reports / feedback
- Rate resolved support cycles
- Manage own profile, optional 2FA

## Customer Chat Model

Each customer has one main support chat (created on approval, or lazily on first `POST /chats/current`).

The customer never creates many tickets. The support team manages structure internally via status, assignment, priority, category, tags, and internal notes.

## Chat Statuses, Priority, Categories

Statuses: `open`, `waiting`, `resolved`, `closed`.

- A new customer message reopens a `resolved` chat (`supportCycle` increments).
- Agent can mark waiting; agent or admin can resolve; only admin can close.
- Support users can send messages, upload chat attachments, and emit typing indicators only while the chat is `open` or `waiting`. Customers can send on `resolved` chats to reopen the next support cycle.
- Closed chats stay visible in history.

Priority: `normal`, `high`, `urgent`. Set by agent or admin only.

Categories: `account`, `billing`, `technical_support`, `general_support`, `complaint`, `other`. Customer picks the initial category; agent or admin can change.

Priority and category changes write audit records and emit `chat:status_changed`.

## Messaging

Chats support text messages, attachments (image preview / file download), read receipts, typing indicators, timestamps, unread counts, soft-delete, and chat-scoped search (via `/search`).

Backend-emitted chat system events: assignment changed, status changed, internal note added/deleted, chat transferred, chat resolved.

## Internal Notes

Agents and admins can add internal notes inside a customer chat. Notes are never visible to customers and never appear in customer-facing responses.

## Agent Inbox

Agents work from one inbox at `GET /chats`. Supported filters: `mine`, `unassigned`, `waiting`, `resolved`, `closed` (additionally `?status=` for arbitrary status filter).

Each inbox item includes: customer summary, last message preview, status, assigned agent, unread count, last activity time, priority, category, tags, and backend-computed `availableActions`.

## Assignment

- Agent can claim an unassigned `open` or `waiting` chat (atomic).
- Admin can assign / reassign `open` or `waiting` chats.
- Agent can transfer their assigned `open` or `waiting` chat to another active agent.
- Assignment changes notify old and new assignee, write audit records, and emit `chat:assigned` or `chat:reassigned`.
- If an agent is suspended or anonymized, the open `chat_assignments` row is ended and the chat becomes unassigned.

## Admin Chat Takeover

Admin can join any chat (`POST /chats/:id/takeover`) and optionally `reassignToSelf`. Admin can leave (`DELETE /chats/:id/takeover`).

- Customer sees admin as a "Support Lead". The internal role is never exposed.
- Takeover writes a chat_admin_participants row + audit record + system event.
- Existing assignment history is preserved (open rows are ended properly).

## Customer Profile

`GET /customers/:id` (admin and agent) returns: identity (name, email, phone, status, timezone, avatar), customer record (account status, tags, admin internal notes), current chat summary, and rating stats.

`PATCH /admin/customers/:id` (admin only) updates tags and internal notes.

Customers update their own display name, phone, timezone, notification prefs, and avatar via `PATCH /me`.

## Files

Supported in chat messages, reports, announcements, team messages.

Rules: signed upload (intent → complete), signed download, image preview, file-owner tracking, resource-based access control, file-size limit, file-type whitelist (JPG / PNG / GIF / PDF / DOCX). In production the complete step verifies object size and content-type in storage. Files are immutable after `ready`.

## Available Actions Contract

Every complex resource response includes backend-computed `availableActions`. Frontend may hide disabled actions, but backend enforces them.

- Chat: `send_message`, `send_internal_note`, `claim`, `assign`, `reassign`, `transfer`, `mark_waiting`, `resolve`, `close`, `reopen`, `delete_message`, `upload_file`, `rate`.
- Announcement: `edit`, `publish`, `schedule`, `delete`, `react`, `comment`.
- Report: `update_status`, `view_files`, `comment_internal`.

Actions reflect role, resource status, assignment, ownership, and account status.

## Announcements

Admin creates, schedules, publishes, edits (only `draft`/`scheduled`), and deletes announcements. Targeting: `all_customers`, `customer_tag`, `category`. Files attach via the same upload pipeline.

Customers see only published announcements targeted to them. Reactions are one-per-emoji per user (add via POST, remove via DELETE). Comments are flat.

Statuses: `draft`, `scheduled`, `published`, `deleted`. Past schedule times are rejected. Scheduled announcements publish via the in-process job loop.

## Reports and Feedback

Customers submit reports with category, description, optional file attachments, and optional `evidenceMessageIds` (snapshotted at submit time so later message deletion doesn't erase evidence). Idempotency key required for the create path.

Admin updates status and writes internal comments. Customer is notified by in-app notification AND email when status changes (slow-lane event).

Categories: `bug`, `complaint`, `account_issue`, `support_issue`, `general_feedback`, `other`.
Statuses: `pending`, `reviewed`, `resolved`, `dismissed`.

## Notifications

In-app notifications with unread tracking, mark-one-read, mark-all-read. Dedupe via `(userId, dedupeKey)` unique index, which transitively prevents duplicate emails.

Notification types include: new customer message, new agent reply, chat assigned/reassigned/resolved, announcement published, report status changed, customer pending approval, customer approved, team mention, admin takeover, rating received, security events.

## Realtime (SSE)

`GET /events` is the SSE stream. `GET /events/state` returns the reconnect payload (`refetch` list + serverTime).

Backend channels: `user:{userId}`, `chat:{chatId}`, `admin`, `team`.

Server-pushed event types: `message:new`, `message:deleted`, `chat:assigned`, `chat:reassigned`, `chat:resolved`, `chat:reopened`, `chat:status_changed`, `typing:update`, `read:receipt`, `notification:new`, `announcement:published`, `report:status_updated`, `team:message:new`, `team:message:deleted`, `force:logout`, `customer:pending_approval`, `customer:approved`.

Important rules:
- SSE is delivery only. All writes go through authenticated HTTP routes.
- Typing events follow the same write permissions as chat messages; unassigned agents and resolved support cycles cannot generate support-side typing noise.
- Events emit only AFTER the database transaction commits.
- On `force:logout` for a user, the backend aborts every live SSE stream for that user immediately (not just notifies).
- Clients refetch state after reconnect — there is no per-event replay buffer.
- Single-process server keeps clients in memory. Multi-process scaling will use Redis pub/sub (future, not yet wired).

## Idempotency

Required idempotency keys (unique per `(scope, key, actorId)`):
- Send chat message
- Send team message
- Create report
- Submit rating

Optional / DB-enforced uniqueness handles: react-to-announcement (unique per user/resource/emoji), mark-notification-read, claim chat (atomic UPDATE), file upload-complete (state machine).

## Pagination

Cursor pagination (capped page size) for: chat messages, team messages, notifications, audit log, reports, announcements, ratings (admin).

Search endpoints use a strict result-count cap.

## Ratings

Customers rate resolved support cycles. One rating per `(chatId, supportCycle, customerId)`. Agent reads own ratings via `GET /me/ratings` with summary stats. Admin reads all via `GET /admin/ratings` (cursor-paginated with agent/customer display names and summary).

## Admin Dashboard

`GET /admin/dashboard` returns counts: open / waiting / unassigned chats, resolved today, active agents, pending customers, pending reports.

## Search

Role-aware groups:
- Customer: own messages, own reports, announcements visible to them.
- Agent: assigned/unassigned chats, team messages.
- Admin: users, reports, announcements.

LIKE-based; capped result counts; respects role permissions; does not expose internal notes to customers.

## Authentication and Sessions

- Email/password login (constant-time argon2; user enumeration via timing is mitigated).
- Mandatory 2FA for admin (challenge → verify).
- Optional 2FA for agents and customers via `POST /me/2fa/enroll` → `POST /me/2fa/enroll/verify`. Disable via `POST /me/2fa/disable` (requires current password).
- Password reset request + confirm (revokes all sessions; emits `force:logout`).
- Refresh token rotates on every successful refresh; expired sessions are rejected.
- `GET /sessions` / `DELETE /sessions/:id` for self-managed sessions.
- Admin can revoke any user's sessions via `DELETE /admin/users/:id/sessions`.

## Email (Slow-Lane Only)

Backend sends short, text-only emails with a single link back to the app. The full notification template lives in the frontend.

Backend-triggered email events:

- **Always (security-critical):** password reset, 2FA code, security alert, new agent account, customer invite.
- **Slow-lane in-app events:** `chat:resolved` (customer rating nudge), `report:status_changed` (customer status update).

NOT emailed: chat replies, chat assignments, announcements, team mentions, customer-pending-approval. These flow only via SSE + in-app notification to avoid mailbox noise.

Throttling is provided implicitly by the `notifications(userId, dedupeKey)` unique index, which deduplicates per-cycle/per-transition.

Email delivery failure must never break the DB transaction (`.catch` on every send call).

## Security

- Argon2 password hashing.
- HS256 JWT access (15m) + refresh (30d, rotating).
- Refresh token hashed (SHA-256) at rest, session row revocation flips a `revokedAt` column.
- Hashed bearer reset tokens (single-use).
- Per-route rate limiting (single-statement upsert; race-free).
- File access via parent resource.
- Audit log: append-only by application contract.
- Production boot rejects missing `CORS_ORIGIN`.

## Audit Log

Append-only log. Records: login, logout, password reset, customer registered/invited/approved, user created/suspended/anonymized/updated, session revoked, chat assigned/reassigned/resolved/closed/status-changed/meta-changed/reopened, admin takeover (join/leave), internal note added/deleted, message deleted, announcement created/updated/scheduled/published/deleted, report status changed, file uploaded, settings changed, agent updated, customer updated, two_factor_enabled/disabled, team_message_deleted.

`GET /admin/audit-logs` supports cursor pagination plus filters: `action`, `resourceType`, `actorId`.

## System Settings

Admin-configurable via `PATCH /admin/settings`. Defaults exposed via `GET /settings` (all roles read).

Editable keys: `maxFileSize`, `allowedFileTypes`, `emailNotificationsEnabled`, `supportAvailability`, `defaultTimezone`, `queueBehavior`, `autoAssignmentEnabled` (flag only — backend never auto-assigns), `defaultChatPriority`, `quickReplies` (managed separately via `PATCH /admin/quick-replies`).

Environment-only secrets: `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `DATABASE_URL`, `TURSO_AUTH_TOKEN`, R2 credentials, `BREVO_API_KEY`, `EMAIL_FROM`, `CORS_ORIGIN`. Validated at boot.

## Timezone Policy

All timestamps stored in UTC ISO strings. Frontend renders in the user's stored timezone. Scheduled announcements convert to UTC at write time; past schedule times rejected.

## Team Chat

One shared internal thread for agents and admins. Supports text + attachments, mentions (notifies mentioned internal users), unread counts, read receipts, agent-can-delete-own, admin-can-delete-any, realtime `team:message:new` and `team:message:deleted`. Customers have no access. There are no DMs.

## API Error Format

```json
{ "error": "ERROR_CODE", "message": "Human readable message", "details": {} }
```

Codes: `BAD_REQUEST`, `VALIDATION_ERROR`, `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `CONFLICT`, `RATE_LIMITED`, `INTERNAL_SERVER_ERROR`.

Validation errors include `details.issues` (Zod). Production omits stack traces.

## Rate Limit Matrix

All security-sensitive and write-heavy routes have per-IP or per-actor limits enforced via a single-statement upsert against `rate_limit_counters`. Returns `RATE_LIMITED` with `retryAfterSeconds`.

## Observability

Per-request JSON log line with `requestId`, method, path, status, durationMs, actorId. Background job failures are logged. Health check at `/health`; readiness check at `/ready` (DB + R2 + email in production).

## Database

Drizzle-first. Raw SQL only inside the domain module that owns the data, always parameterized. Constraints enforce key invariants (one chat per customer, one rating per cycle, unique reaction per user/resource/emoji, dedupeKey uniqueness, refresh-token-hash uniqueness, idempotency-key compound key).

### Core entities

`users`, `user_sessions`, `password_reset_tokens`, `two_factor_challenges`, `customers`, `agents`, `support_chats`, `chat_assignments`, `chat_admin_participants`, `messages`, `internal_notes`, `message_files`, `message_reads`, `files`, `announcements`, `announcement_targets`, `announcement_comments`, `announcement_files`, `announcement_reactions`, `reports`, `report_files`, `report_internal_comments`, `ratings`, `notifications`, `team_messages`, `team_message_files`, `team_message_reads`, `audit_logs`, `system_settings`, `idempotency_keys`, `rate_limit_counters`.

(There is intentionally no `outbox_events` table — SSE replay is not in scope.)

## Data Retention and Anonymization

`DELETE /admin/users/:id/anonymize` (idempotent — rejects if already anonymized):
- Anonymizes display name, email, phone, avatar.
- Revokes sessions; emits `force:logout`.
- Agent target: nulls `assignedAgentId` on every chat they hold AND closes open `chat_assignments` rows.
- Customer target: closes their open `supportChats` rows.
- Audit logs remain untouched.

Message soft-delete hides body to viewers; backend retains for evidence snapshots.

## Engineering Rules

- No bloat. No unnecessary features. No unnecessary libraries.
- Direct code over clever code.
- Domain modules own their business rules; routes validate and delegate.
- DB constraints protect critical invariants.
- List endpoints are batched — no per-row queries in the page-build path.
- Files under ~900 lines. Compact modular monolith.

## Backend File Structure

`server.ts`, `app.ts`, `config.ts`, `db.ts`, `schema.ts`, `auth.ts`, `security.ts`, `events.ts`, `files.ts`, `jobs.ts`, `support.ts`, `content.ts`, `email.ts`, `verify-schema.ts`, `seed.ts`, `smoke.ts`. No additional module files are anticipated.

## Verification

- `npm run typecheck`
- `npm run build`
- `npm test` (isolated file-backed SQLite, runs all migrations)
- `npm run db:migrate` (against configured Turso DB)
- `npm run verify:schema` (against configured Turso DB)
- `npm run smoke` (against a running local backend)

## Final Product Shape

One support chat per customer · one inbox for agents · strong admin control · secure attachments · Team Chat · announcements · reports + feedback · notifications · ratings · audit + security.

The product is intentionally small, intentionally complete, and intentionally not bigger.
