# SupportChat Build Specification

This document defines the product we will build: a small, professional WhatsApp-like customer support platform.

It includes only the features that should exist in the product. Unnecessary or weak ideas are excluded.

## Product Goal

Build a simple customer support messaging system that feels easy for customers and operationally strong for support teams.

Customers should feel like they are messaging support.

Agents should feel like they are working from a clean inbox.

Admins should have enough control to run the support operation professionally.

## Roles

## Admin

Admin controls the system.

Admin can:

- Manage agents
- Manage customers
- View all support chats
- Join or take over any support chat
- Assign chats
- Reassign chats
- Resolve chats
- Close chats
- Publish announcements
- Review reports
- Manage files through the resources they belong to
- View ratings
- View audit log
- Manage system settings
- Suspend users
- Revoke user sessions

## Agent

Agent handles customer support.

Agent can:

- View assigned chats
- Claim unassigned chats
- Reply to customers
- Transfer chats
- Resolve chats
- Add internal notes
- Use team chat
- Use quick replies
- View customer context for assigned chats
- View announcements
- View own ratings
- Manage own profile/settings

## Customer

Customer requests support.

Customer can:

- Use one main support chat
- Send messages
- Send attachments
- View support history
- View announcements
- React/comment on announcements
- Submit reports or feedback
- Rate resolved support
- Manage own profile/settings

## Customer Chat Model

Each customer has one main support chat.

The customer does not create many tickets. They open the app and continue their support conversation.

The support team manages structure internally using:

- Status
- Assignment
- Priority
- Category
- Tags
- Internal notes

## Priority and Categories

Chats should support category and priority.

Categories:

- Account
- Billing
- Technical support
- General support
- Complaint
- Other

Priority levels:

- `normal`
- `high`
- `urgent`

Rules:

- Customer may choose an initial category when starting support.
- Agent can change category.
- Admin can change category.
- Agent can set priority.
- Admin can set priority.
- Customers do not set priority directly.
- Priority changes create chat system events.
- Priority changes create audit records.

## Chat Statuses

The chat uses these statuses:

- `open` - active support is ongoing
- `waiting` - support is waiting for customer response
- `resolved` - issue is resolved but can be reopened
- `closed` - archived and no longer active

Rules:

- A new customer message reopens a resolved chat.
- Agent can mark chat as waiting.
- Agent can resolve chat.
- Admin can resolve or close chat.
- Closed chats remain visible in history.

## Messaging

The chat supports:

- Text messages
- Attachments
- Image previews
- File downloads
- Read receipts
- Typing indicators
- Message timestamps
- Unread counts
- Message soft-delete
- Chat search

Support-only chat events:

- Assignment changed
- Status changed
- Internal note added
- Chat transferred
- Chat resolved

## Internal Notes

Agents and admins can add internal notes inside a customer chat.

Internal notes:

- Are not visible to customers
- Are visible to agents/admins with access to the chat
- Are included in chat history for support context

## Agent Inbox

Agents work from one inbox.

Inbox filters:

- My chats
- Unassigned
- Waiting
- Resolved
- Closed

Each inbox item shows:

- Customer name
- Last message preview
- Status
- Assigned agent
- Unread count
- Last activity time
- Priority
- Category/tag

Agent actions:

- Claim chat
- Reply
- Add internal note
- Transfer chat
- Mark waiting
- Resolve
- Search
- Use quick replies

## Assignment

New customer chats or reopened chats can be unassigned.

Assignment rules:

- Agent can claim an unassigned chat.
- Admin can assign any chat.
- Admin can reassign any chat.
- Agent can transfer a chat to another agent.
- Assigned agent receives a notification.
- Previous agent receives a notification when reassigned away.

## Agent Selection

Agent selection is manual-first.

Customers do not choose agents. Customers message support, and the support team decides who handles the chat.

Rules:

- If the customer chat already has an assigned agent, keep that agent.
- If the chat is unassigned, it appears in the unassigned inbox.
- Any available agent can claim an unassigned chat.
- Admin can assign an unassigned chat to any agent.
- Admin can reassign an assigned chat to another agent.
- Agent can transfer their assigned chat to another agent.
- Claiming a chat must be atomic so two agents cannot claim the same chat.
- Assignment and reassignment create notifications.
- Assignment and reassignment create audit records.
- Assignment and reassignment create chat system events.

## Admin Chat Takeover

Admin can join or take over any customer support chat.

Customer-facing behavior:

- Customer should see admin as `Support Lead`.
- Customer should not see internal role names like `super admin`.
- Admin messages appear as support messages.

Support-side behavior:

- Assigned agent is notified when admin joins or takes over.
- Takeover creates a chat system event.
- Takeover creates an audit record.
- Admin can reply, add internal notes, assign, reassign, resolve, or close.
- Admin can leave the chat assigned to the original agent or reassign it.

Rules:

- Admin takeover must not erase existing assignment history.
- Admin takeover must not hide previous agent messages.
- Customer read receipts and unread counts still work normally.
- Admin must have full file access inside the chat.

Admin agent selection UI should show:

- Agent name
- Availability
- Current active chat count
- Waiting chat count
- Last active time
- Skills/categories

Agent claim UI should show:

- Unassigned customer
- Last message preview
- Last activity time
- Priority
- Category/tag
- Claim button

Auto-assignment is not part of the default product behavior.

If auto-assignment is enabled later by settings, it must follow these rules:

- Agent must be active.
- Agent must be available.
- Agent must be under active chat capacity.
- Prefer matching skill/category.
- Prefer lowest active workload.
- Tie-break by least recently assigned.

Auto-assignment must never override a manual admin assignment.

## Customer Profile

Customer profile includes:

- Name
- Email
- Phone
- Account status
- Created date
- Last active time
- Tags
- Internal notes
- Support history

Customers can update:

- Display name
- Phone
- Profile photo
- Notification settings

## Files

Files are supported in:

- Chat messages
- Reports
- Announcements

File rules:

- Secure upload
- Secure download
- Image preview
- PDF/document download
- File owner tracking
- Resource-based access control
- File size limit
- File type whitelist

Allowed file types:

- JPG
- PNG
- GIF
- PDF
- DOCX

## Available Actions Contract

Backend responses for complex resources should include available actions.

This prevents the frontend from guessing permissions.

Chat response should include actions such as:

- `send_message`
- `send_internal_note`
- `claim`
- `assign`
- `reassign`
- `transfer`
- `mark_waiting`
- `resolve`
- `close`
- `reopen`
- `delete_message`
- `upload_file`

Announcement response should include actions such as:

- `edit`
- `publish`
- `schedule`
- `delete`
- `react`
- `comment`
- `delete_comment`

Report response should include actions such as:

- `update_status`
- `view_files`
- `comment_internal`

Rules:

- Available actions must be computed by backend.
- Frontend may hide disabled actions, but backend must still enforce permissions.
- Available actions should reflect current role, resource status, assignment, ownership, and account status.

## Announcements

Announcements are operational updates from the business to customers.

Admin can:

- Create announcement
- Edit announcement
- Publish immediately
- Schedule publish time
- Delete announcement
- Target announcement by customer group/category
- Attach files

Customers can:

- View relevant published announcements
- React with emoji
- Comment on announcements
- Download announcement attachments

Announcement fields:

- Title
- Body
- Target audience
- Attachments
- Status
- Scheduled publish time
- Published time
- Author

Announcement statuses:

- `draft`
- `scheduled`
- `published`
- `deleted`

Rules:

- Customers only see published announcements targeted to them.
- Scheduled announcements publish automatically when due.
- Past schedule times are rejected.
- Deleted announcements are hidden from normal views.
- Deleted comments are hidden from normal views.

## Reports and Feedback

Customers can submit reports or feedback.

Report fields:

- Title
- Category
- Description
- Attachments
- Status
- Admin notes
- Created time
- Updated time

Report categories:

- Bug
- Complaint
- Account issue
- Support issue
- General feedback
- Other

Report statuses:

- `pending`
- `reviewed`
- `resolved`
- `dismissed`

Rules:

- Admin can update report status.
- Customer receives notification when report status changes.
- Report attachments follow secure file access rules.

## Notifications

The system sends notifications for:

- New customer message
- New agent reply
- Chat assigned
- Chat reassigned
- Chat resolved
- Announcement published
- Report status changed
- Password/security event

Notification channels:

- In-app notification
- Toast
- Email for important events

Notification rules:

- Track unread count
- Mark one notification as read
- Mark all notifications as read
- Avoid duplicate toasts
- Throttle repeated emails

## Realtime

Use **Server-Sent Events (SSE)** for realtime delivery and normal HTTP routes for user actions.

This keeps the backend smaller and easier to secure than a full bidirectional socket layer.

Realtime endpoint:

- `GET /events`

HTTP actions:

- `POST /chats/:id/messages`
- `POST /chats/:id/read`
- `POST /chats/:id/typing`
- `POST /chats/:id/resolve`
- `POST /team/messages`
- `POST /announcements/:id/reactions`
- `POST /reports`

Server-pushed event types:

- `message:new`
- `message:deleted`
- `chat:assigned`
- `chat:reassigned`
- `chat:resolved`
- `chat:reopened`
- `chat:status_changed`
- `typing:update`
- `read:receipt`
- `notification:new`
- `announcement:published`
- `report:status_updated`
- `team:message:new`
- `force:logout`

Internal event channels:

- `user:{userId}`
- `chat:{chatId}`
- `admin`
- `team`

SSE authentication:

- Prefer secure httpOnly cookies.
- If bearer-token auth is required, use a short-lived event-stream token or a fetch-based SSE client.

Scaling:

- Single server keeps an in-memory map of connected SSE clients.
- Multi-server uses Redis Pub/Sub.
- Each server receives Redis events and pushes matching events to its own local SSE clients.

Important rule:

- SSE is only for delivery.
- All writes still go through normal authenticated HTTP routes.
- Backend services must validate permissions before creating events.

## SSE Reliability

SSE events are delivery hints, not the only source of truth.

Important state must always be stored in the database.

Rules:

- Important events must correspond to committed database state.
- Client should refetch relevant state after reconnect.
- Client should refetch chat messages when opening a chat.
- Client should refetch unread counts after reconnect.
- Client should refetch notifications after reconnect.
- Server should send keep-alive comments to keep the SSE stream open.
- SSE events should include enough IDs for the client to refetch affected resources.

Event payloads should include:

- Event type
- Resource ID
- Actor summary when useful
- Created timestamp
- Minimal resource snapshot when useful

Do not rely on SSE alone for permanent history.

## Idempotency and Duplicate Protection

Important writes must protect against duplicate submission.

Use idempotency keys or database constraints for:

- Send chat message
- Upload complete
- Create report
- Create announcement
- Submit rating
- React to announcement
- Mark notification read
- Claim chat

Rules:

- Duplicate message submission should not create duplicate messages.
- Duplicate rating submission should return conflict or existing rating.
- Duplicate reaction with same emoji/user/resource should not create another count.
- Claim chat must be atomic.
- Upload complete should be safe to retry.

## Pagination

Use cursor pagination for high-volume lists.

Cursor pagination required for:

- Chat messages
- Team Chat messages
- Notifications
- Audit log
- Reports
- Announcements

Rules:

- Default page size should be reasonable.
- Maximum page size must be capped.
- Message history should load newest first, then older pages.
- Audit log should support filters and cursor/offset.
- Search endpoints should have strict limits.

## Ratings

Customers can rate resolved support.

Rating fields:

- Stars from 1 to 5
- Optional comment
- Customer
- Agent
- Chat reference
- Created time

Rules:

- Customer can rate after support is resolved.
- One rating per resolved support cycle.
- Agent can view own ratings.
- Admin can view all ratings.

## Admin Dashboard

Admin dashboard shows:

- Open chats
- Waiting chats
- Unassigned chats
- Resolved today
- Active agents
- Pending reports
- Recent activity

Admin dashboard actions:

- Assign chats
- Open queue
- Review reports
- Create announcement
- Create agent

## Search

Search should be role-aware.

Customer search:

- Own support messages
- Own reports
- Published announcements visible to them

Agent search:

- Assigned chats
- Unassigned chats
- Customers they can access through support work
- Team Chat messages
- Announcements visible to agents
- Own reports/ratings

Admin search:

- Customers
- Agents
- Chats
- Messages
- Internal notes
- Reports
- Announcements
- Team Chat messages
- Audit log metadata

Rules:

- Search results must respect role permissions.
- Search endpoints must have strict limits.
- Search must not expose deleted/anonymized personal data.
- Search must not expose internal notes to customers.
- Admin global search should return grouped result types.

## Authentication and Sessions

The system supports:

- Email/password login
- Password reset
- Session refresh
- Logout
- View own sessions
- Revoke own sessions
- Admin revoke user sessions
- Optional 2FA for customers and agents
- Mandatory 2FA for admin

## Email

Transactional email is required for important account and support events.

Email events:

- Password reset
- New agent account
- Security/session alert
- Customer support reply
- Chat assigned to agent
- Announcement published
- Report status changed

Rules:

- Security emails cannot be disabled.
- Non-critical emails can be disabled by user preference.
- Emails must be HTML-escaped.
- Email delivery failure must not break the core database transaction.
- Repeated non-critical emails should be throttled.

## Security

Security requirements:

- Strong password hashing
- Access tokens
- Refresh tokens
- Secure reset tokens
- Role-based authorization
- Rate limiting
- Secure file access
- Session revocation
- Audit logging
- Timing-safe token/code comparison where needed

## Audit Log

The audit log records:

- Login
- Logout
- Password change
- Password reset
- User created
- User suspended
- Session revoked
- Chat assigned
- Chat reassigned
- Chat resolved
- Announcement published
- Announcement deleted
- Report status changed
- File uploaded

Audit records are append-only.

## System Settings

Admin can configure:

- Max file size
- Allowed file types
- Email notification toggle
- Push notification toggle
- Support availability hours
- Default timezone
- Queue behavior

Admin-configurable settings:

- Max file size
- Allowed file types
- Email notifications enabled
- Push notifications enabled
- Support availability hours
- Default timezone
- Queue behavior
- Auto-assignment enabled/disabled
- Default chat priority

Environment-only settings:

- JWT secrets
- Database URL
- Object storage credentials
- Email provider API key
- Cookie security settings
- CORS origin
- Production mode

Rules:

- Secret values are never editable from admin UI.
- Environment-only settings are validated at boot.
- Admin setting changes are audited.

## Timezone Policy

All timestamps are stored in UTC.

Rules:

- Database timestamps use UTC.
- API returns ISO timestamps.
- Frontend displays time in the user's timezone.
- User timezone is stored in user settings.
- Scheduled announcements are converted to UTC before storage.
- Backend validates scheduled times against current UTC time.
- Past scheduled times are rejected.

## Support Availability

Support availability hours are configurable by admin.

Behavior:

- Customers can send messages outside support hours.
- Outside-hours messages remain in the inbox.
- System can show an automatic notice that support will respond during business hours.
- Outside-hours messages still create notifications.
- Admin and agents can still reply outside support hours.

Availability settings:

- Weekday support hours
- Weekend support hours
- Timezone
- Holiday/closed-day override

## API Error Format

All API errors should use one consistent shape.

Format:

```json
{
  "error": "ERROR_CODE",
  "message": "Human readable message",
  "details": {}
}
```

Common error codes:

- `BAD_REQUEST`
- `VALIDATION_ERROR`
- `UNAUTHORIZED`
- `FORBIDDEN`
- `NOT_FOUND`
- `CONFLICT`
- `RATE_LIMITED`
- `INTERNAL_SERVER_ERROR`

Rules:

- Validation errors include details.
- Production errors do not expose stack traces.
- Business-rule failures use clear messages.
- Frontend should display `message`, not invent its own generic text unless needed.

## Rate Limit Matrix

The backend must define a rate limit matrix before implementation.

Required rate-limited actions:

- Login
- Password reset request
- Password reset confirm
- 2FA verify
- File upload intent
- File upload complete
- Send chat message
- Send team message
- Typing update
- Create report
- Create announcement
- React to announcement
- Submit rating

Rules:

- Rate limits should have scope.
- Scope can be IP, user, email, resource, or combined.
- Security-sensitive unauthenticated routes need IP and identifier limits.
- Message routes need per-user limits.
- File routes need per-user and size limits.
- Rate limit errors use `RATE_LIMITED`.

## Accessibility

The frontend must be accessible enough for professional use.

Rules:

- All controls are keyboard usable.
- Buttons use real button elements.
- Inputs have labels.
- Modals trap focus and close predictably.
- Focus states are visible.
- Color contrast must be readable.
- No critical action is hover-only.
- Icon-only buttons need accessible labels.
- Toasts should not be the only way to know an action succeeded.
- Text must not overflow or overlap on mobile.

## Observability

The backend must be observable in production.

Required:

- Request logging
- Request ID
- Actor ID where safe
- Error logging
- Job failure logging
- Email delivery failure logging
- File upload failure logging
- SSE connection count
- Notification delivery status

Recommended metrics:

- Request count
- Error count
- Response time
- Active SSE connections
- Messages sent
- Failed jobs
- Pending notifications
- File upload failures

Operational rules:

- Background job failures must be logged.
- Repeated job failures should alert admin/operator.
- Health check should confirm server is alive.
- Readiness check should confirm required dependencies are usable.

## Team Chat

The system includes one internal Team Chat.

Team Chat is for agents and admins only.

Purpose:

- Let agents coordinate with each other
- Let admin communicate with the support team
- Keep internal support discussion transparent
- Avoid private side conversations

Team Chat supports:

- One shared internal thread
- Text messages
- Attachments
- Mentions
- Unread count
- Read receipts
- Search
- Delete own message
- Admin delete any team message
- Realtime `team:message:new` event

Rules:

- Customers cannot access Team Chat.
- There are no private DMs.
- Team Chat files follow internal-user file access rules.
- Team Chat does not replace internal notes inside customer chats.
- Customer-specific discussion should happen as an internal note on the customer chat.

## Database

Use **Drizzle-first database access**.

Default:

- Drizzle schema
- Drizzle migrations
- Drizzle typed inserts/updates/selects
- Drizzle relations where useful

Use raw SQL only when it is clearly better:

- Complex reporting queries
- Analytics aggregation
- Full-text/search queries
- Bulk updates
- Highly specific optimized joins

Rules:

- Raw SQL must be parameterized.
- No string-concatenated user input.
- Raw SQL should stay inside the domain module that owns the data.
- Query result shapes must be typed.
- Database constraints must enforce important business invariants.

Recommended database targets:

- SQLite/Turso for small deployment
- PostgreSQL if the product needs heavier analytics or larger scale later

The schema should be designed from the product contract first, not from the UI screens.

## Database Entities

Recommended core entities:

- `users`
- `user_sessions`
- `password_reset_tokens`
- `two_factor_challenges`
- `customers`
- `agents`
- `support_chats`
- `chat_assignments`
- `messages`
- `internal_notes`
- `message_reads`
- `files`
- `announcements`
- `announcement_targets`
- `announcement_comments`
- `announcement_reactions`
- `reports`
- `report_attachments`
- `ratings`
- `notifications`
- `notification_reads`
- `team_messages`
- `team_message_reads`
- `audit_logs`
- `system_settings`
- `idempotency_keys`

Important constraints:

- One main support chat per customer.
- One active assignment per active chat.
- One rating per resolved support cycle.
- Unique reaction per user/resource/emoji.
- File owner must be tracked.
- Audit log is append-only.
- Idempotency key uniqueness must be enforced.

## Data Retention and Anonymization

The system must support safe user deletion/anonymization.

Rules:

- Deleting a user should anonymize personal data instead of breaking history.
- Audit logs should remain append-only.
- Chat/report history should remain coherent.
- Deleted/anonymized user display name can become `Deleted User`.
- Email/phone/profile photo should be removed or anonymized.
- Active sessions must be revoked.
- Active chats should be closed or reassigned depending on role.
- Internal notes and audit logs should remain for business recordkeeping.

Message deletion:

- Normal users see deleted messages as removed or hidden.
- Backend may retain deleted message body internally for audit/report evidence if legally allowed.
- Report evidence should snapshot message content at report creation time.

## Navigation

## Customer Navigation

- Home
- Support Chat
- Announcements
- Reports
- Settings

## Agent Navigation

- Inbox
- Customers
- Announcements
- Reports
- Ratings
- Settings

## Admin Navigation

- Dashboard
- Inbox
- Customers
- Agents
- Announcements
- Reports
- Ratings
- Audit Log
- Settings

## Backend Rules

The backend owns:

- Roles
- Permissions
- Status transitions
- File access rules
- Notifications
- Audit records
- Validation
- Error behavior

The frontend renders allowed actions from backend state and should not be the only place enforcing business rules.

## Engineering Rules

Build the system with strict discipline.

Rules:

- No bloat.
- No unnecessary features.
- No unnecessary libraries.
- No giant catch-all service file.
- No duplicated permission logic.
- No frontend-only business rules.
- No route handlers with hidden business logic.
- No raw SQL string concatenation with user input.
- No speculative abstractions.

Code standards:

- Direct code over clever code.
- Small shared helpers only when they remove real duplication.
- Domain modules own their business rules.
- Routes validate and delegate.
- Services enforce permissions and state transitions.
- Database constraints protect critical invariants.
- Every write path has clear side effects.
- Every security-sensitive action is audited.
- Every realtime event comes from a committed backend state change.

Performance rules:

- Avoid N+1 queries.
- Paginate list endpoints.
- Index lookup/filter columns.
- Keep response shapes purposeful.
- Do not over-fetch large histories.
- Keep file upload/download out of the app server data path by using signed URLs.

Maintainability rules:

- Keep files under about 900 lines.
- Keep route definitions thin.
- Keep domain behavior near the data it affects.
- Prefer one clear module over many tiny fragmented files.
- Add abstraction only when it improves correctness, reuse, or clarity.

## Backend-First Build Rule

The backend must be designed fully before the frontend is treated as complete.

The reason backend changes keep happening late is usually this:

- A page is built first.
- Then the frontend discovers it needs counts, permissions, file access, status rules, or realtime events.
- The backend response or rule is missing.
- The backend has to change after the UI already exists.

To avoid that, every feature must start with a backend contract.

For each feature, define before coding UI:

- Roles allowed
- Resource visibility
- Statuses
- Valid state transitions
- Request schema
- Response shape
- File access rules
- Notification side effects
- Realtime events
- Audit records
- Rate limits
- Error codes
- Background job behavior

The frontend should not guess missing backend behavior.

If the frontend needs reaction counts, comment counts, unread counts, recipient visibility, attachment access, or available actions, the backend should return them directly.

## Backend Contract Checklist

Before building any frontend page, define the backend contract.

For every feature, document:

- Who can create it
- Who can view it
- Who can update it
- Who can delete it
- Status values
- Valid status transitions
- Required database constraints
- Request schemas
- Response schemas
- Available role-specific actions
- Realtime events emitted
- Notifications created
- Audit records written
- Rate limits
- File access behavior
- Background job behavior
- Error codes
- Idempotency or duplicate-submission behavior

The feature is not ready for frontend implementation until this contract is clear.

## API Route Matrix Requirement

Before implementation, create an API route matrix.

Each route must define:

- Method
- Path
- Roles allowed
- Auth required
- Rate limit
- Request body schema
- Query schema
- Params schema
- Response shape
- Resource permission check
- Audit record
- Notification side effect
- SSE event side effect
- Idempotency behavior
- Error codes

No route should be implemented without this information.

## Cross-Feature Rules and Edge Cases

These rules must be handled from day one.

### Chat

- Customer message to a `resolved` chat reopens it.
- Customer cannot send to a `closed` chat.
- Agent cannot reply after chat is closed.
- Admin can close any chat.
- Admin can join or take over any chat.
- Agent can resolve assigned chat.
- Admin can assign or reassign any chat.
- Assignment changes notify old and new assignees.
- Chat transfer writes a system event and audit record.
- Internal notes never appear to customers.
- Read receipts update unread counts.
- Typing events expire automatically if no update is received.

### Assignment

- If assigned agent is suspended, active chats become unassigned.
- If assigned agent is deactivated/unavailable, admin can reassign.
- Claiming an unassigned chat must be atomic.
- Two agents cannot claim the same chat simultaneously.
- Reassignment must not lose unread state.
- Customer cannot choose a specific agent.
- Auto-assignment cannot override manual assignment.
- Transfer must preserve full chat history.
- Transfer must notify the previous and new assignee.

### Users and Sessions

- Suspended users cannot log in.
- Suspending a user revokes active sessions.
- Admin cannot suspend themselves.
- Admin session revocation triggers `force:logout`.
- Deleted/anonymized users should not break historical chat/report records.

### Files

- File access follows the parent resource.
- Chat file access requires access to the chat.
- Report file access requires access to the report.
- Announcement file access requires access to the announcement.
- Team Chat file access requires internal-user access.
- Failed uploads expire and are cleaned up.
- File type and file size are enforced by backend.

### Announcements

- Customers only see published announcements targeted to them.
- Past scheduled publish time is rejected.
- Scheduled announcements publish automatically when due.
- Deleted announcements are hidden from normal views.
- Deleted comments are hidden from normal views.
- Announcement reactions are unique per user per emoji.
- Reaction counts are returned by backend.
- Attachment access follows announcement visibility.

### Reports

- Customer can see own reports.
- Admin can see all reports.
- Report status changes notify reporter.
- Evidence messages are snapshotted so later message deletion does not erase evidence.
- Report attachments follow report visibility.

### Ratings

- Customer can rate only resolved support.
- One rating per resolved support cycle.
- Rating notifies assigned agent.
- Admin can view all ratings.
- Agent can view own ratings.

### Notifications and Realtime

- Every notification updates unread count.
- Duplicate toasts should be avoided.
- Email notifications are throttled.
- SSE events are emitted only after database write succeeds.
- Reconnect should reload enough state to recover missed events.
- `force:logout` immediately disconnects or invalidates the affected session.

### Team Chat

- Only agents and admins can access Team Chat.
- Team messages can have attachments.
- Mentions notify mentioned internal users.
- Admin can delete any team message.
- Agents can delete only their own team messages.
- Team Chat unread count is separate from customer chat unread count.

## Testing Requirements

Required backend tests:

- Auth/session tests
- Role permission tests
- Resource visibility tests
- Chat state transition tests
- Assignment atomic-claim tests
- Admin takeover tests
- File access tests
- Announcement schedule tests
- Announcement targeting tests
- Report status tests
- Rating uniqueness tests
- Notification creation tests
- SSE event emission tests
- Idempotency tests
- Audit log tests

Required frontend tests or verification flows:

- Customer support chat flow
- Agent claim/reply/resolve flow
- Admin assign/reassign/takeover flow
- Attachment upload/preview/download flow
- Announcement publish/schedule/comment/reaction flow
- Report submit/status update flow
- Notification unread/read flow
- Responsive layout checks

Every major feature should have:

- allowed role test
- forbidden role test
- edge status test
- file access test if files are involved
- realtime/notification check if events are involved

## Deployment Assumptions

Initial deployment:

- Single backend process
- SSE connections kept in memory
- Database as source of truth
- Object storage for files
- Email provider for transactional emails
- HTTPS required
- Secure cookies recommended

Scaling path:

- Add Redis Pub/Sub for SSE fanout across backend processes
- Add background worker separation if jobs grow
- Add database read replicas only if needed
- Add queue system only if background jobs become heavy

Operational requirements:

- Health check endpoint
- Readiness check endpoint
- Graceful shutdown closes SSE streams
- Job runner must not run duplicate destructive jobs without guardrails
- Logs must include request ID and actor ID where safe
- Production secrets must be validated on boot

## Backend File Structure Recommendation

Use a compact modular monolith.

Recommended files:

- `server.ts` - boot, plugins, lifecycle
- `config.ts` - environment validation
- `db.ts` - database client and transactions
- `schema.ts` - schema bootstrap/migrations
- `auth.ts` - passwords, JWT, sessions, 2FA
- `security.ts` - route wrapper, roles, rate limits, audit
- `events.ts` - SSE connections, event fanout, Redis Pub/Sub integration
- `files.ts` - upload, complete, download, file access
- `jobs.ts` - scheduled jobs
- `support.ts` - chats, inbox, assignment, ratings
- `people.ts` - users, agents, customers, profiles
- `content.ts` - announcements, reports, notifications, team chat

Target:

- Around 10-12 files
- Keep each file under about 900 lines
- No giant catch-all service file
- No duplicated permission checks
- No frontend-only business rules

Route handlers should be thin.

Domain services should enforce exact resource-level rules.

Example flow:

- Route validates request
- Route gets authenticated actor
- Service checks resource permission
- Service writes database transaction
- Service creates notification/audit/event records
- Event layer pushes SSE updates

## Research Links For Next Agent

Read these before choosing or changing realtime architecture:

- MDN Server-Sent Events guide: https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events
- MDN Server-Sent Events API overview: https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events
- Socket.IO Rooms: https://socket.io/docs/v4/rooms/
- Socket.IO Redis Adapter: https://socket.io/docs/v4/redis-adapter/
- Socket.IO Delivery Guarantees: https://socket.io/docs/v4/delivery-guarantees/
- Socket.IO Connection State Recovery: https://socket.io/docs/v4/connection-state-recovery

Decision:

- Use SSE for this product.
- Use HTTP for writes.
- Use Redis Pub/Sub only when scaling beyond one backend process.
- Do not introduce Socket.IO unless the product truly needs bidirectional socket workflows.

## Final Product Shape

The product is:

- One support chat per customer
- One inbox for agents
- Strong admin control
- Secure attachments
- Team Chat
- Announcements
- Reports and feedback
- Notifications
- Ratings
- Audit and security

This is the complete recommended product scope.
