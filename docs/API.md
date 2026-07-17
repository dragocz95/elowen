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

`GET /events` is an SSE stream. It emits state-change events such as `task`,
`mission`, `signal`, `plan`, `review`, `decision`, and `ask`; the subscriber's
project access filters its event set.

### Authentication and users

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/auth/login`, `/auth/logout` | Start or revoke a session |
| `GET`, `PATCH` | `/auth/me` | Read or update the current profile |
| `POST` | `/auth/me/password`, `/auth/me/avatar` | Change password or upload avatar |
| `GET`, `PUT`, `DELETE` | `/auth/me/prompts/:name` | Read, save, or remove personal prompts |
| `GET`, `PATCH` | `/auth/me/cli-settings` | CLI preferences |
| `GET`, `PATCH` | `/auth/me/terminal-settings` | Terminal preferences |
| `GET`, `PATCH` | `/auth/me/permissions` | Current-user permissions |
| `GET`, `POST` | `/users` | List or create users (admin surface) |
| `PATCH`, `DELETE` | `/users/:id` | Update or remove a user |
| `GET` | `/users/:id/avatar`, `/users/:id/avatar/url` | Avatar content or signed URL |
| `GET` | `/users/:id/tools`, `/users/:id/stats` | User policy and aggregate information |
| `POST` | `/users/:id/impersonate` | Start admin impersonation |
| `GET`, `POST` | `/users/:id/projects` | Read or add project assignments |
| `DELETE` | `/users/:id/projects/:pid` | Remove a project assignment |

### Tasks, plans, usage, and asks

| Method | Path | Purpose |
| --- | --- | --- |
| `GET`, `POST` | `/tasks` | List or create tasks; `project_id` can narrow a list |
| `GET` | `/tasks/ready`, `/tasks/deps` | Ready tasks and dependency edges |
| `GET`, `PATCH`, `DELETE` | `/tasks/:id` | Read/update/delete task state |
| `GET` | `/tasks/:id/usage`, `/tasks/:id/conversation` | Usage and embedded-brain transcript |
| `GET` | `/tasks/:id/changed/diff`, `/tasks/:id/commits` | Settled-task changes and commits |
| `GET` | `/tasks/:id/commit/:hash/diff` | File diff from a task commit |
| `POST` | `/tasks/:id/approve-gate` | Approve a review gate |
| `POST` | `/tasks/:id/ask` | Park a question for a human or overseer |
| `GET` | `/tasks/:id/ask/:askId`, `/tasks/:id/guide`, `/tasks/:id/deps` | Ask status, worker guide, and dependencies |
| `POST` | `/tasks/:id/ask/:askId/reply` | Answer a parked question |
| `GET` | `/asks/pending` | Pending human questions |
| `POST` | `/tasks/plan` | Start asynchronous mission planning |
| `GET`, `POST` | `/plan/:jobId`, `/plan/:jobId/submit` | Read or submit a plan job |
| `POST` | `/tasks/:epicId/phases` | Add planned phases to an epic |
| `GET` | `/usage/by-model`, `/usage/by-day` | Aggregated task and caller chat usage |
| `POST` | `/usage/reset` | Administrator usage reset |
| `POST` | `/admin/cleanup` | Administrator cleanup of operational task state |

Task creation and updates use the schemas in `src/api/schemas/tasks.ts`.
Agent-scoped tokens can only perform their restricted worker workflow, even
inside an otherwise accessible project.

### Missions

| Method | Path | Purpose |
| --- | --- | --- |
| `GET`, `POST` | `/missions` | List live or pending-PR missions; engage a mission |
| `GET`, `PATCH`, `DELETE` | `/missions/:id` | Read, pause/resume, or disengage a mission |
| `GET` | `/missions/:id/changed-files` | Aggregate phase change summary |
| `POST` | `/missions/:id/pr`, `/missions/:id/merge-pr` | Open or merge a PR-native mission |
| `GET`, `POST` | `/missions/:id/overseer/next`, `/missions/:id/overseer/decide` | Overseer decision protocol |

### Sessions and terminal transport

| Method | Path | Purpose |
| --- | --- | --- |
| `GET`, `POST` | `/sessions` | List or create a session |
| `GET`, `DELETE` | `/sessions/:name` | Session state or termination |
| `POST` | `/sessions/:name/keys`, `/sessions/:name/input`, `/sessions/:name/resize` | Send terminal input or resize |
| `GET` | `/sessions/:name/pane`, `/sessions/:name/stream` | Snapshot or SSE terminal stream |
| `POST` | `/sessions/:name/ws-ticket` | Mint a single-use PTY WebSocket ticket |

The ticket is consumed by `GET /ws/terminal?ticket=…`; clients should prefer
the supported terminal components rather than treating that transport as a
general-purpose public API.

### Projects and repository files

| Method | Path | Purpose |
| --- | --- | --- |
| `GET`, `POST` | `/projects` | List or register projects |
| `PATCH`, `DELETE` | `/projects/:id` | Edit or remove a project |
| `GET` | `/fs/dirs` | Discover permitted directories |
| `GET` | `/projects/:id/git`, `/projects/:id/files`, `/projects/:id/file` | Git, tree, or file content |
| `PUT` | `/projects/:id/file` | Save a file |
| `GET` | `/projects/:id/raw`, `/projects/:id/head` | Raw or HEAD file content |
| `POST` | `/projects/:id/new-file`, `/projects/:id/dir`, `/projects/:id/rename`, `/projects/:id/copy` | File-system operations |
| `DELETE` | `/projects/:id/entry` | Remove a file-system entry |
| `GET` | `/projects/:id/diff`, `/projects/:id/changed`, `/projects/:id/changes` | Current change information |
| `GET` | `/projects/:id/commits`, `/projects/:id/commit/:hash` | Commit history and detail |
| `GET` | `/projects/:id/commit/:hash/diff` | Commit file diff |

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
| `GET`, `POST` | `/brain/lsp`, `/brain/lsp/install`, `/brain/lsp/uninstall` | Language-server controls |
| `POST` | `/brain/providers/probe`, `/brain/test` | Provider discovery and test call |
| `GET` | `/brain/images/:file`, `/brain/stream` | Stored image and SSE chat stream |

### Plugins, memory, personality, and integrations

| Family | Route prefix | Purpose |
| --- | --- | --- |
| Plugins | `/plugins` | Discovery, install/update, configuration, runtime contributions, plugin data, logs, hooks, cron, skills, Discord, WhatsApp, and MCP server controls |
| Memory | `/memory` | Entries, categories, events, merge/trash/purge, retrieval, categorization, and embedding configuration/test |
| Personality | `/personality/profiles` | CRUD and activation of personality profiles |
| Activity | `/activity`, `/notes` | Event history and project/mission notes |
| Integrations | `/integrations/cli-status`, `/integrations/github-status` | Local integration readiness |
| OAuth models | `/brain/oauth` | Status, catalog, interactive flow, and disconnect for supported providers |

For exact method/path pairs in these broader families, see the matching route
modules: `plugins.ts`, `memory.ts`, `personality.ts`, `activity.ts`, and
`integrations.ts` in `src/api/routes/`.

## Error responses

All handled failures return a JSON body with an `error` string. Typical status
codes are 400 (invalid input), 401 (missing or invalid token), 403 (policy or
project access), 404 (unknown resource), 409 (conflicting runtime state), and
422 (an external workflow could not complete). Clients should branch on the
HTTP status and treat the error text as human-readable diagnostics, not a
stable enum.
