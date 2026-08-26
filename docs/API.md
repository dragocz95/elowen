# API Reference

Elowen exposes a Hono REST API from the daemon. The current implementation in
`src/api/routes/` and its Zod schemas in `src/api/schemas/` are the executable
contract; this page is the stable route-family reference.

**Base URL:** `http://localhost:4400`

## Authentication and access

When a user store contains at least one user, requests require a bearer token:

```http
Authorization: Bearer <token>
```

The public probes are `GET /health`, `GET /setup`, `POST /auth/login`, and
`GET /push/vapid-public-key`. A signed avatar URL and the single-use terminal
WebSocket ticket have their own validation paths. During first-run setup, the
daemon remains open until the first user is created.

The browser does not expose a daemon token to JavaScript. It uses the
same-origin `/api` proxy and an httpOnly session cookie; the CLI sends the
bearer header directly.

Tokens resolve to two effective scopes:

| Scope | Intended use |
| --- | --- |
| `full` | Interactive users |
| `agent` | Spawned workers, pilots, and overseers; a route and field allow-list limits this scope |

Advisor credentials are stored separately from login tokens but resolve to the owner's `full` scope. Rotating or stopping an advisor therefore does not invalidate an interactive login.

When project assignments are enabled, non-admin users are limited to their
assigned projects. Per-user model and tool policy applies in addition to the
global configuration. Route handlers make the final project-level check.

## Route families

All request bodies are JSON unless a route documents a file upload. Validation
errors return `{ "error": "…" }` with HTTP 400; authentication and policy
failures use 401 and 403 respectively.

### Health, setup, configuration, and events

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/health` | Daemon health and version |
| `GET` | `/setup` | Whether initial setup is required |
| `GET`, `PUT` | `/config` | Read configuration; administrators update it |
| `GET` | `/system` | Version, update posture, and diagnostics |
| `GET` | `/system/readiness` | Administrator readiness checks |
| `GET` | `/system/skills` | Installed workflow-skill status |
| `POST` | `/system/skills/install` | Install or repair workflow skills |
| `POST` | `/system/update` | Start a guarded update |
| `POST` | `/system/restart` | Restart the selected service |
| `GET` | `/events` | Global SSE event stream |
| `POST` | `/mcp` | Stateless MCP request endpoint |
| `GET` | `/push/vapid-public-key` | Public push key |
| `POST` | `/push/subscribe`, `/push/unsubscribe` | Manage the caller's push devices |

`GET /events` is an SSE stream. Core and enabled plugins publish state-change events; project-scoped rows are filtered through the subscriber's current Project access.

### Authentication and users

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/auth/login`, `/auth/logout` | Start or revoke a session |
| `GET`, `PATCH` | `/auth/me` | Read or update the current profile |
| `POST` | `/auth/me/password`, `/auth/me/avatar` | Change password or upload avatar |
| `GET`, `PUT`, `DELETE` | `/auth/me/prompts/:name` | Read, save, or remove personal prompts |
| `GET`, `PATCH` | `/auth/me/cli-settings` | CLI preferences, communication style (`advisorStyle`), and global agent instructions (`userInstructions`; legacy alias `personalityBody`) |
| `GET`, `PATCH` | `/auth/me/terminal-settings` | Terminal preferences |
| `GET`, `PATCH` | `/auth/me/permissions` | Current-user permissions |
| `GET`, `POST` | `/users` | List or create users (admin surface) |
| `PATCH`, `DELETE` | `/users/:id` | Update or remove a user |
| `GET` | `/users/:id/avatar`, `/users/:id/avatar/url` | Avatar content or signed URL |
| `GET` | `/users/:id/tools`, `/users/:id/stats` | User policy and aggregate information |
| `POST` | `/users/:id/impersonate` | Start admin impersonation |
| `GET`, `POST` | `/users/:id/projects` | Read or add project assignments |
| `DELETE` | `/users/:id/projects/:pid` | Remove a project assignment |

### Usage

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/usage/by-model`, `/usage/by-day`, `/usage/by-origin` | Aggregated account usage |
| `POST` | `/usage/reset` | Administrator usage reset |

Task tracking, missions, coding-agent sessions, and their route families are not core APIs. When installed, a domain plugin serves its own authenticated routes under `/plugins/<name>/api/*` or an explicitly declared root mount.

### Projects and repository files

| Method | Path | Purpose |
| --- | --- | --- |
| `GET`, `POST` | `/projects` | List or register projects |
| `PATCH`, `DELETE` | `/projects/:id` | Edit or remove a project |
| `GET` | `/fs/dirs` | Discover permitted directories |
| `GET` | `/projects/:id/git` | Read-only Git snapshot, branches, and recent commits |

File browsing and editing routes are plugin-owned and use the same core Project tenancy and path guards.

### Brain and advisor

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/advisor/status` | Current user's advisor state |
| `POST` | `/advisor/start`, `/advisor/stop` | Start or stop the advisor |
| `GET` | `/brain/status`, `/brain/rate-limits`, `/brain/models`, `/brain/commands` | Chat capability and catalog metadata |
| `POST` | `/brain/start`, `/brain/send`, `/brain/abort`, `/brain/session/stop` | Start, send to, abort, or stop chat work |
| `PATCH`, `DELETE` | `/brain/sessions/:id` | Update or remove a conversation |
| `GET` | `/brain/sessions/:id/export` | Export a conversation |
| `GET` | `/brain/sessions`, `/brain/managed-sessions`, `/brain/messages`, `/brain/search` | Conversation listings, messages, and search |
| `DELETE` | `/brain/managed-sessions`, `/brain/managed-sessions/:id` | Remove managed conversations |
| `POST` | `/brain/model`, `/brain/think`, `/brain/fast`, `/brain/yolo`, `/brain/compact` | Change current-turn controls |
| `POST` | `/brain/command`, `/brain/answer`, `/brain/goal`, `/brain/goal/action`, `/brain/subgoal`, `/brain/subagent/send` | Commands, answers, goals, and subagents |
| `GET`, `DELETE` | `/brain/queue`, `/brain/queue/:id` | Pending message queue |
| `GET`, `POST`, `DELETE` | `/brain/processes`, `/brain/processes/:id/output`, `/brain/processes/:id` | Background process inspection and termination |
| `GET`, `POST` | `/brain/lsp`, `/brain/lsp/install`, `/brain/lsp/uninstall` | Language-server controls (served by the `lsp` plugin; 503 while it is disabled) |
| `POST` | `/brain/providers/probe`, `/brain/test` | Provider discovery and test call |
| `GET` | `/brain/images/:file`, `/brain/stream` | Stored image and SSE chat stream |

### Plugins, memory, and integrations

| Family | Route prefix | Purpose |
| --- | --- | --- |
| Plugins | `/plugins` | Discovery, install/update, configuration, runtime contributions, plugin data, logs, hooks, cron, skills, Discord, WhatsApp, and MCP server controls |
| Memory | `/memory` | Entries, categories, events, merge/trash/purge, retrieval, categorization, and embedding configuration/test |
| Activity | `/activity` | Core and plugin event history, scoped by Project access |
| OAuth models | `/brain/oauth` | Status, catalog, interactive flow, and disconnect for supported providers |

For exact method/path pairs in these broader families, see the matching route modules in `src/api/routes/` and each installed plugin's manifest.

There is no separate personality route family: Elowen stores one global set of
agent instructions per account and appends it to the system prompt on every
platform. The public field is `userInstructions` on `/auth/me/cli-settings`,
alongside `advisorStyle`; `personalityBody` remains a compatibility alias and the
internal persisted key. The old per-platform, multi-profile personality system
(`/personality/profiles`, `personality_profiles` and
`personality_active_profiles` tables) has been removed.

## Error responses

All handled failures return a JSON body with an `error` string. Typical status
codes are 400 (invalid input), 401 (missing or invalid token), 403 (policy or
project access), 404 (unknown resource), 409 (conflicting runtime state), and
422 (an external workflow could not complete). Clients should branch on the
HTTP status and treat the error text as human-readable diagnostics, not a
stable enum.
