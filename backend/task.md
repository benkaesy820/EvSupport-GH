# evComm Backend — Task Tracker

Living tracker of everything done, everything still to do, and edge cases not yet covered. Last updated **2026-05-18**.

Status legend: ✅ done · 🟡 partial · ⬜ todo · ⛔ locked (won't do).

---

## Completed

### Pass 1 — Tighten without growing (commit-ready)

**Schema cleanup (one migration `0005_left_viper.sql`, net −1 table, −1 column)**

- ✅ Dropped `outbox_events` table and every `publishEvent` write to it.
- ✅ Dropped `notifications.email_status` column (no producer, no consumer).
- ✅ Removed `outbox_events` + `outbox_events_created_idx` from `verify-schema.ts` required lists.

**Correctness fixes**

- ✅ `sql\`${col} is not ${actor.id}\`` → `ne(col, actor.id)` in three unread-count queries (`support.ts:buildChatResponse`, `auth.ts:/me`, `content.ts:teamUnreadCount`). Was silently miscounting.
- ✅ Login runs argon2 against a dummy hash when the user is missing (constant-time; mitigates email-enumeration via timing).
- ✅ `/auth/refresh` checks `gt(userSessions.expiresAt, now)` AND rotates the refresh token (new JWT, new hash, persisted, cookie reset).
- ✅ `/admin/users/:id/anonymize` rejects if target is already anonymized; for agents ends open `chat_assignments` rows; for customers closes open `supportChats` rows.
- ✅ `/admin/users/:id` (suspend) ends open `chat_assignments` rows when target is an agent.
- ✅ `/chats/:id/takeover` with `reassignToSelf=true` ends the open `chat_assignments` row.
- ✅ `/admin/dashboard.pendingReports` queries `reports.status = 'pending'` instead of the notifications proxy.
- ✅ `force:logout` SSE event aborts every live stream for the target user (per-user clients map in `events.ts`).
- ✅ SIGTERM/SIGINT drains all SSE streams before `server.close()`.
- ✅ `rateLimit` is a single `INSERT … ON CONFLICT DO UPDATE … RETURNING count` (race-free, half the round-trips).
- ✅ Production boot rejects missing `CORS_ORIGIN`.

**Performance — N+1s killed**

- ✅ `/chats` list batched via `buildChatList` (3 IN queries: users, last messages, unread counts).
- ✅ `/announcements` list batched (3 grouped queries: reactions, comment counts, files).
- ✅ `/reports` list batched (1 IN query for files).
- ✅ `/team/messages` list batched (1 IN query for files).
- ✅ `targetedCustomerIds` + jobs.ts announcement publish: load targets once, batch customer+chat fetch.

**New routes (all inside existing files)**

- ✅ `POST /me/2fa/enroll`, `POST /me/2fa/enroll/verify`, `POST /me/2fa/disable` (optional 2FA for agents/customers).
- ✅ `PATCH /me` accepts `avatarFileId` with ownership + `ready` verification.
- ✅ `/admin/users/:id/approve` auto-creates the customer's support chat.
- ✅ `GET /chats?filter=mine|unassigned|waiting|resolved|closed` inbox filter aliases.
- ✅ `GET /customers/:id` returns identity + tags + internal notes + chat summary + rating stats.
- ✅ `PATCH /admin/customers/:id` updates tags + internal notes.
- ✅ `GET /me/ratings` (agent own) + `GET /admin/ratings` (admin all with summary).
- ✅ `DELETE /chats/:id/takeover` (admin "leave chat").
- ✅ `DELETE /announcements/:id/reactions` (toggle reaction off).
- ✅ `PATCH /me/availability` (agent self) + `PATCH /admin/agents/:id` (admin).
- ✅ `PATCH /admin/quick-replies` (admin-managed quick replies; stored in `system_settings`).
- ✅ `defaultChatPriority` added to settings defaults.

**Email**

- ✅ `email.ts` simplified to text-only with a single `<p>` wrapper.
- ✅ `sendChatResolved` wired into `/chats/:id/status` resolved branch.
- ✅ `sendReportStatusChanged` wired into `/reports/:id/status`.
- ✅ All sends wrapped in `.catch(console.error)` so delivery failures never break DB transactions.

**Docs**

- ✅ `product-recommendations.md` fully rewritten — Locked Exclusions section, removed auto-assignment / SSE replay / complex email content, documented new routes + slow-lane email rule.
- ✅ `backend-contract.md` updated with every new/changed route, inbox filters, email events, outbox removal note.

### Pass 2 — Critical + High follow-ups

**Critical bugs**

- ✅ Slow-lane email no-op guards — chat status returns early on same-state; report status only emits notification + email + audit + SSE when `report.status !== body.status` (still allows `adminNotes`-only edits to persist).
- ✅ `force:logout` sessionId-scoped close — when the payload carries `sessionId`, only that session's streams close; otherwise all of the user's streams close (suspend / anonymize / password-reset / admin-revoke-all).
- ✅ `/customers/:id` PII scoping for agents — uses existing `canViewChat`; agents only see customers whose current chat is assigned to them or unassigned.
- ✅ Internal note `fileIds` dropped from schema and handler — files weren't actually linked to notes, so removing the field is the honest fix.
- ✅ `users.lastActiveAt` updated by `touchUserActivity` in `readActor` (in-memory throttle, ≤1 write per 60 s per user).

**High-priority UX gaps**

- ✅ Message + note rows include `sender`/`author` summaries `{ id, displayName, role, status }` via `attachMessageFiles` + `attachNoteAuthors`.
- ✅ `GET /announcements/:id` (single detail with reactions, comments count, files, `availableActions`).
- ✅ `GET /announcements/:id/comments` (cursor-paginated, includes author summary).
- ✅ `/me` returns agent profile when `role === "agent"`, plus `avatarFileId` and `lastActiveAt`.
- ✅ `/sessions` returns active sessions only by default; `?includeRevoked=true` opts into history.
- ✅ `sendCustomerApproved` email fires from `/admin/users/:id/approve` (customer learns their account is ready).

**Bonus items rolled in**

- ✅ Closing a chat (`status: 'closed'`) ends the open `chat_assignments` row.
- ✅ `POST /chats/:id/messages` response includes attached files + sender (consistent with `GET /chats/:id`).
- ✅ 8 new test cases (20 total, all passing): 2FA enrollment + disable, `/customers/:id` scoping, inbox filter aliases, reactions toggle, comments listing, auto-chat + sender enrichment, resolve idempotency + close-ends-assignment, sessions filter.

---

## In progress

_Nothing currently in progress._

---

## TODO — Medium priority (real gaps, not blocking)

### Search

- ⬜ Broaden admin `/search` to include chats (by customer name), messages, internal notes, team messages, and audit log metadata. Currently only users + reports + announcements.
- ⬜ Agent `/search` should include announcements visible to internal users + own ratings + own reports. Currently only chats + team messages.
- ⬜ Customer `/search` should include published announcements targeted to them. Currently only own messages + own reports.

### Lifecycle hygiene

- ⬜ Reopening a closed chat (admin closed→open) leaves `supportChats.assignedAgentId` set but no open `chat_assignments` row. Either null out the agent on reopen-from-closed OR insert a new assignment row.
- ⬜ Block destructive admin actions when only one active admin remains (anonymize / suspend / revoke-all-sessions). Currently only self-action is blocked.
- ⬜ `DELETE /internal-notes/:id` for the note author or admin (column `deletedAt` already exists, route doesn't).
- ⬜ `GET /admin/agents/:id` single-agent detail (currently only list `/admin/agents`).

### File / notification housekeeping

- ⬜ R2 cleanup: when `runDueJobs` flips `files.status = 'expired'`, also `DeleteObject` from R2 so storage doesn't bloat.
- ⬜ Orphaned ready files cleanup: any `files` row with `status='ready' AND resourceType IS NULL AND completedAt < now() - 24h` should be expired + deleted from R2 (covers uploaded-but-never-attached).
- ⬜ Notification retention: delete `notifications` rows where `readAt < now() - 90d` (or per a configurable retention setting).
- ⬜ Audit log retention policy decision: today it's append-only forever. Either document "no retention" formally OR add an archival cron.

### Security tightening

- ⬜ Unattached file download leak: `canAccessResource` returns `true` when `resourceType` is null. Anyone with a file ID can download an unattached file. Tighten to "owner only" for unattached files; avatar files specifically can have a public-readable path if needed.

### Tests still missing for new routes

- ⬜ `/me/ratings` and `/admin/ratings` (just shape + summary).
- ⬜ `/chats/:id/takeover` DELETE (admin join → leave; `chat_admin_participants.leftAt` set).
- ⬜ `/admin/agents/:id` PATCH (availability/skills/capacity).
- ⬜ `/me/availability` PATCH (agent self) — including 403 on skills/capacity changes from agent.
- ⬜ `/admin/customers/:id` PATCH (tags + internal notes).
- ⬜ `/admin/quick-replies` PATCH (round-trip via `/settings`).
- ⬜ `/me/2fa/enroll` for admin returns 409; `/me/2fa/disable` for admin returns 403.
- ⬜ `PATCH /me` with someone else's `avatarFileId` returns 403; with a non-ready file returns 409.
- ⬜ `lastActiveAt` updates on the next authenticated request after login.
- ⬜ Customer approval triggers email (assert via the dev `console.log` path or a stub).

---

## TODO — Low priority / nice-to-have

### Operational

- ⬜ Job runner overlap guard: `runDueJobs` is on `setInterval(..., 60_000)`. If a run takes >60 s, two runs overlap and could double-fire announcement notifications (dedupe key saves us, but the work is wasted). Wrap with an in-progress flag.
- ⬜ Email sending: currently `await sendXxx(...)` inside the request path. If Brevo is slow, the request latency suffers. Consider fire-and-forget queueing OR a tiny in-process worker that drains a pending-emails table.
- ⬜ SSE backpressure: no max client count per user OR globally. A malicious client could open thousands of streams. Add a cap (e.g. 5 per user, 1000 global).
- ⬜ Multi-origin CORS: today single `CORS_ORIGIN` env. If we ship a separate mobile/web origin pair, extend to a comma-separated list with origin reflection.
- ⬜ Structured logger with levels: today `console.log` JSON. A real logger (pino) would give us levels + redaction.
- ⬜ Phone number format validation in `PATCH /me` (currently any string ≤50 chars).

### UX polish

- ⬜ Avatar URL in `/admin/customers` and `/admin/agents` list rows so admin tables can render avatars without N round-trips.
- ⬜ Customer profile "support history" enrichment: resolved-cycle count, total message count, days-since-first-contact (today we only return rating summary).
- ⬜ Avatar caching strategy: signed URLs expire in 10 min, so frontends must re-fetch frequently. Consider longer-lived avatar URLs (1 hour) or a dedicated `/users/:id/avatar` redirect endpoint that returns a fresh signed URL.

### API completeness

- ⬜ `GET /me/ratings` for customers (their own ratings they've given). Currently only agent-self + admin-all.
- ⬜ `GET /reports?status=...` filter (pending-only inbox view for admin).
- ⬜ `GET /chats?priority=urgent` filter (operational triage).
- ⬜ `DELETE /me/avatar` (clear avatar without setting another).

---

## TODO — Hardening / edge cases (think carefully before promoting these)

- ⬜ Audit-log append-only enforcement at DB level (trigger that rejects UPDATE/DELETE on `audit_logs`). Today it's application-contract only.
- ⬜ Test SSE force:logout sessionId scoping end-to-end (hard to test — would need to drive an actual SSE client in tests).
- ⬜ Test refresh-token rotation: after one refresh, the old refresh token can no longer mint a new access token.
- ⬜ Test concurrent claim: two simultaneous claims on the same unassigned chat — exactly one returns 200, the other returns 409.
- ⬜ Test concurrent rate-limit upsert: hammer the same scope+key and assert count is exact (no row duplicates).
- ⬜ Validate scheduled-announcement times round-trip through UTC correctly across DST boundaries.
- ⬜ Live presence (who is currently viewing a chat) — could be derived from SSE client subscriptions per chat; not in spec.
- ⬜ Cross-process SSE fan-out via Redis pub/sub (only matters when we scale beyond one process).

---

## Out of scope — locked exclusions (do not revisit)

All of the below have explicit user-approved decisions. Document, don't implement.

- ⛔ Auto-assignment (manual claim + admin assign only; `autoAssignmentEnabled` setting is a UI hint).
- ⛔ Super-admin role (three roles only).
- ⛔ Public admin creation (admin is seed/SQL-only).
- ⛔ Private DMs (one shared Team Chat).
- ⛔ Admin direct customer creation (invite flow only).
- ⛔ Report discussion threads (one-way submission + internal comments only).
- ⛔ File detach/delete after `ready` (immutable; soft-deleting a message hides attachments).
- ⛔ SSE replay / `Last-Event-ID` buffer (client refetches state on reconnect via `/events/state`).
- ⛔ Complex email templates (text-only, single link; rich rendering lives in the frontend).
- ⛔ Malware scanning (type whitelist + size cap only).
- ⛔ Advanced invite lifecycle (one-shot setup token; no reminders, rotation, multi-step).
- ⛔ Push notifications (FCM/APNS) — in-app + email only.
- ⛔ Native mobile app.
- ⛔ Multi-language i18n on the backend.
- ⛔ OpenAPI / GraphQL / gRPC layer.
- ⛔ API versioning (/v1/ prefix).
- ⛔ Bulk admin operations (mass approve / mass delete).
- ⛔ Customer data export endpoint.
- ⛔ Customer self-deletion route (admin anonymizes on request).
- ⛔ Webhook outbound integrations.
- ⛔ Role conversion (customer↔agent↔admin).
- ⛔ Email change route.

---

## Verification — current state

| Check | Status |
| --- | --- |
| `npm run typecheck` | ✅ clean |
| `npm run build` | ✅ clean |
| `npm test` | ✅ 20 / 20 pass |
| `npm run db:migrate` (Turso) | ✅ 0005 applied |
| `npm run verify:schema` (Turso) | ✅ `{ ok: true, tables: 32, indexes: 15 }` |
| `npm run smoke` (live local) | ✅ 18 checks pass |
| Manual /me spot-check | ✅ `lastActiveAt` populated, `agent` field present for agents, `avatarFileId` exposed |
| Manual inbox-filter spot-check | ✅ `?filter=mine` and `?filter=unassigned` partition correctly |

---

## File map (no new `src/*.ts` files since pass 1)

```
backend/
  drizzle/
    0000_pink_roughhouse.sql              (initial schema)
    0001_easy_the_call.sql                (two_factor_challenges)
    0002_old_lionheart.sql
    0003_ancient_synch.sql
    0004_majestic_the_professor.sql
    0005_left_viper.sql                   (drop outbox_events + email_status)
    meta/*                                (drizzle bookkeeping)
  src/
    app.ts            (router boot, CORS, secure headers, /health, /ready)
    auth.ts           (auth, sessions, 2FA, admin user/customer mgmt, dashboard)
    config.ts         (env validation, CORS prod check, fileConfig)
    content.ts        (announcements, reports, notifications, team chat, settings, search, audit log GET, quick replies, agent availability)
    db.ts             (libsql + drizzle client)
    email.ts          (Brevo sender + 7 helpers including slow-lane sends)
    events.ts         (SSE clients map, sessionId-scoped force:logout abort)
    files.ts          (R2 signed URL intent/complete/download)
    jobs.ts           (in-process scheduler: announcements, cleanup)
    schema.ts         (Drizzle SQLite schema, 31 tables)
    security.ts       (errors, JWT, requireAuth/Role, rateLimit upsert, audit, idempotency, lastActiveAt touch)
    seed.ts           (admin bootstrap + sample data)
    server.ts         (HTTP serve + graceful shutdown w/ SSE drain)
    smoke.ts          (live end-to-end smoke)
    support.ts        (chats, messages, internal notes, assignments, takeover, ratings, customer profile, admin customer PATCH, ratings GET)
    verify-schema.ts  (asserts required tables/indexes exist in target DB)
  tests/
    backend.test.ts   (20 tests; isolated file-backed SQLite)
  backend-contract.md
  product-recommendations.md
  task.md             ← this file
  drizzle.config.ts
  package.json
  tsconfig.json
```

13 production `src/*.ts` files. Per the engineering rule, none added since pass 1.

---

## Notes for whoever picks this up next

- **Where bugs hide most often:** the message-send path is the busiest write surface; race conditions in claim/transfer/takeover are the most likely to bite under real load.
- **Where the spec is loosest:** "support history" in the customer profile is currently shallow (rating summary only). If the UI wants more, it's a 1-query extension.
- **What to verify after a Drizzle bump:** the rate-limit single-statement upsert uses `onConflictDoUpdate(..., { set: { count: sql\`${col} + 1\` } })`. If Drizzle's SQL builder changes the underlying SQL, re-run the rate-limit tests.
- **What changes invalidate the test scaffold:** tests apply every `drizzle/*.sql` file sequentially against a fresh SQLite — any migration that depends on Turso-specific features will break the test bootstrap.
- **Money-saving low-hanging fruit:** the orphaned-file cleanup will be the first noticeable storage line-item to bend down once usage ramps.
