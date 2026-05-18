# evComm Backend Contract

This backend is the source of truth for roles, permissions, state transitions, files, notifications, and realtime hints.

## Auth

- `POST /auth/login` -> password check. Admin/2FA users receive `{ requiresTwoFactor, challengeId }`.
- `POST /auth/2fa/verify` -> creates session cookies and returns `{ user, session }`.
- `POST /auth/logout`
- `POST /auth/refresh`
- `POST /auth/password-reset/request`
- `POST /auth/password-reset/confirm`
- `GET /me` -> `{ user, counts }`
- `PATCH /me`
- `GET /sessions`
- `DELETE /sessions/:id`

## Admin

- `GET /admin/dashboard`
- `GET /admin/users`
- `POST /admin/users`
- `PATCH /admin/users/:id`
- `DELETE /admin/users/:id/anonymize`
- `DELETE /admin/users/:id/sessions`
- `GET /admin/agents`
- `GET /admin/customers`
- `GET /admin/audit-logs`
- `PATCH /admin/settings`

## Support Chat

- `GET /chats`
- `POST /chats/current`
- `GET /chats/:id`
- `POST /chats/:id/messages`
- `POST /chats/:id/internal-notes`
- `POST /chats/:id/read`
- `POST /chats/:id/typing`
- `POST /chats/:id/claim`
- `POST /chats/:id/assign`
- `POST /chats/:id/transfer`
- `POST /chats/:id/takeover`
- `POST /chats/:id/status`
- `PATCH /chats/:id/meta`
- `POST /chats/:id/ratings`
- `DELETE /messages/:id`

Chat responses include backend-computed `availableActions`, `unreadCount`, and `lastMessagePreview`.
`GET /chats/:id` supports `cursor` and capped `limit` for message history and returns `nextMessageCursor`.

## Files

- `POST /files/upload-intents`
- `POST /files/:id/complete`
- `GET /files/:id/download`

File access follows parent resource access. Production upload completion verifies object metadata in R2.

## Announcements

- `GET /announcements`
- `POST /announcements`
- `PATCH /announcements/:id`
- `POST /announcements/:id/publish`
- `DELETE /announcements/:id`
- `POST /announcements/:id/reactions`
- `POST /announcements/:id/comments`
- `DELETE /announcement-comments/:id`

Customers only see published announcements targeted to them.
Reactions, comments, and announcement file downloads enforce the same targeting rules.

## Reports

- `GET /reports`
- `GET /reports/:id`
- `POST /reports`
- `PATCH /reports/:id/status`
- `POST /reports/:id/internal-comments`

Customers can see only their own reports. Admin-only report detail includes internal comments.
Report list/detail responses include files and backend-computed `availableActions`.

## Notifications

- `GET /notifications`
- `POST /notifications/:id/read`
- `POST /notifications/read-all`

## Team Chat

- `GET /team/messages`
- `POST /team/messages`
- `POST /team/messages/read`
- `DELETE /team/messages/:id`

Team Chat is admin/agent only. There are no private DMs. Messages support attachments, explicit `mentionUserIds`, unread counts, read receipts, sender/admin delete rules, and realtime create/delete events.

## Settings, Search, Realtime

- `GET /settings`
- `GET /search?q=...`
- `GET /events`
- `GET /events/state`

SSE is a delivery hint. Clients should refetch `me`, notifications, chats, open chat messages, and Team Chat after reconnect.
`GET /admin/audit-logs` supports cursor pagination plus `action`, `resourceType`, and `actorId` filters.

## Verification

- `npm run typecheck`
- `npm run build`
- `npm test` uses isolated file-backed SQLite.
- `npm run smoke` uses the configured live backend/database.
