# API Reference

The Orca daemon exposes a REST API on port `4400`. All endpoints return JSON.
CORS is enabled for the web frontend.

**Base URL:** `http://localhost:4400`

---

## Authentication & access control

### Auth header

Every route except `GET /health` and `POST /auth/login` requires:

```
Authorization: Bearer <token>
```

The web UI uses the same-origin `/api` BFF proxy with an httpOnly session
cookie — the token never reaches browser JS.

### Token scopes

| Scope | Purpose |
|-------|---------|
| `full` | Interactive user sessions — full access |
| `agent` | Spawned agents — restricted allow-list (close tasks, submit plans) |
| `advisor` | Per-user assistant — mapped to `full` rights |

### Multi-tenancy gates

With multi-user mode (user projects store):

1. **Global gate** — non-admin must be assigned to the home project
2. **Per-project gate** — users only see assigned projects
3. **Per-user exec allowlist** — restricts which executors a non-admin may use

### Executor validation

Every `exec` string must be in `config.allowedExecs`. Non-admin users may
be further restricted by their own `allowed_execs`.

---

## Endpoints by group

### Health & setup

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/health` | No | Daemon health check |
| `GET` | `/setup` | No | Setup/install status |
| `GET` | `/cli-status` | No | CLI tool detection status |

```
GET /health → 200 { "ok": true }
GET /setup  → 200 { "freshInstall": { "noConfigPersisted": true, … } }
```

### Auth

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/auth/login` | No | Login, returns bearer token |
| `POST` | `/auth/logout` | Yes | Revoke current token |
| `GET` | `/auth/me` | Yes | Current user profile |
| `PATCH` | `/auth/me` | Yes | Update profile (name, email, default_exec) |
| `POST` | `/auth/me/password` | Yes | Change password |
| `POST` | `/auth/me/avatar` | Yes | Upload avatar image |
| `PATCH` | `/auth/me/cli-settings` | Yes | Update brain CLI settings |

```http
POST /auth/login
Content-Type: application/json
{ "username": "admin", "password": "test99" }
→ 200 { "token": "abc123…", "user": { "id": 1, "username": "admin", … } }

POST /auth/me/password
Content-Type: application/json
{ "currentPassword": "old", "newPassword": "new-secure-pass" }
→ 200 { "ok": true }
```

Rate-limited: 10 attempts / 5 min / IP (prefers `x-real-ip`).

### Tasks

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/tasks` | List tasks |
| `GET` | `/tasks/:id` | Get task detail |
| `POST` | `/tasks` | Create task |
| `PATCH` | `/tasks/:id` | Update task (close, status, exec) |
| `PATCH` | `/tasks/:id/approve-gate` | Approve review gate |
| `DELETE` | `/tasks/:id` | Delete task |
| `GET` | `/tasks/:id/changed/diff` | Get file diff for closed task |
| `POST` | `/tasks/plan` | Autopilot plan decomposition |
| `POST` | `/tasks/:epicId/phases` | Replan — add phases mid-mission |

```http
GET /tasks?project_id=1&status=open → 200 [ { "id": "task-abc", … } ]

POST /tasks
Content-Type: application/json
{ "title": "Fix login bug", "labels": ["exec:sonnet"], "project_id": 1 }
→ 201 { "id": "task-abc", "title": "Fix login bug", … }

PATCH /tasks/orca-abc123
Content-Type: application/json
{ "status": "closed", "outcome": "ok", "summary": "Fixed the issue" }
→ 200 { "id": "orca-abc123", "status": "closed", … }

POST /tasks/plan
Content-Type: application/json
{ "goal": "Add a dark mode toggle", "project_id": 1, "engage": true }
→ 202 { "jobId": "plan-job-xyz" }

POST /tasks/orca-epic123/phases
Content-Type: application/json
{ "goal": "Add tests for dark mode" }
→ 201 { "tasks": [ … ] }
```

### Missions

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/missions` | List missions |
| `GET` | `/missions/:id` | Get mission detail |
| `PATCH` | `/missions/:id` | Update mission |
| `PATCH` | `/missions/:id/state` | Engage / pause / resume / disengage |
| `DELETE` | `/missions/:id` | Delete mission |

```http
PATCH /missions/m-abc123/state
Content-Type: application/json
{ "state": "paused" }
→ 200 { "id": "m-abc123", "state": "paused", … }
```

### Sessions

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/sessions` | List live sessions |
| `GET` | `/sessions/:name/pane` | Get session terminal content |
| `POST` | `/sessions/:name/keys` | Send keystrokes |
| `DELETE` | `/sessions/:name` | Kill session |
| `GET` | `/sessions/:name/stream` | SSE stream (terminal content) |
| `POST` | `/sessions/:name/ws-ticket` | Mint WebSocket ticket for PTY |


```http
POST /sessions/orca-Agent42/keys
Content-Type: application/json
{ "keys": ["C-c"] }
→ 200 { "ok": true }
```

### Projects

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/projects` | List projects |
| `POST` | `/projects` | Create project |
| `PATCH` | `/projects/:id` | Update project |
| `DELETE` | `/projects/:id` | Delete project |
| `GET` | `/projects/:id/files` | List files |
| `GET` | `/projects/:id/files/:path` | Get file content |
| `PUT` | `/projects/:id/files/:path` | Write file |
| `GET` | `/projects/:id/git` | Git status |
| `GET` | `/projects/:id/changed` | Changed files |
| `GET` | `/projects/:id/changes` | Working diff |
| `GET` | `/projects/:id/head` | HEAD file content |
| `GET` | `/projects/:id/commits` | Recent commits |
| `GET` | `/projects/:id/commits/:hash` | Commit detail |
| `GET` | `/projects/:id/commits/:hash/diff/:path` | Commit file diff |
| `POST` | `/projects/:id/files` | Create file/directory |
| `PATCH` | `/projects/:id/files` | Rename/copy file |
| `DELETE` | `/projects/:id/files/:path` | Delete file |
| `GET` | `/projects/:id/branches` | List branches |

### Config

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/config` | Get runtime config (API keys omitted) |
| `PUT` | `/config` | Update runtime config |

```http
PUT /config
Content-Type: application/json
{ "allowedExecs": ["sonnet", "opencode:deepseek-v4-flash"], … }
→ 200 { "allowedExecs": ["sonnet", …], … }
```

### Brain

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/brain/stream` | SSE chat stream |
| `GET` | `/brain/messages` | Past messages for session |
| `GET` | `/brain/sessions` | List brain sessions |
| `POST` | `/brain/sessions` | Create new session |
| `DELETE` | `/brain/sessions/:id` | Delete session |
| `GET` | `/brain/search` | Fulltext search conversations |
| `GET` | `/brain/models` | Aggregated model catalog |
| `POST` | `/brain/providers/probe` | Probe provider endpoint for models |
| `GET` | `/brain/oauth/status` | OAuth connection status |
| `GET` | `/brain/oauth/:type/catalog` | OAuth provider model catalog |
| `POST` | `/brain/oauth/:type/start` | Start OAuth connect flow |
| `GET` | `/brain/oauth/flow/:id` | Poll OAuth flow status |
| `POST` | `/brain/oauth/flow/:id/input` | Submit OAuth code |
| `DELETE` | `/brain/oauth/:type` | Disconnect OAuth account |

### Advisor (assistant)

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/advisor/start` | Start assistant |
| `POST` | `/advisor/stop` | Stop assistant |
| `GET` | `/advisor/status` | Get assistant status |

### Plugins

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/plugins` | List all plugins |
| `PATCH` | `/plugins/:name/toggle` | Enable/disable plugin |
| `GET` | `/plugins/:name/config` | Get plugin config |
| `PUT` | `/plugins/:name/config` | Update plugin config |
| `GET` | `/plugins/:name/logs` | Get plugin logs |
| `GET` | `/plugins/:name/data/:path` | Get plugin data file |
| `PUT` | `/plugins/:name/data/:path` | Write plugin data file |
| `GET` | `/plugins/runtime` | Runtime contributions report |
| `GET` | `/plugins/marketplace` | Plugin marketplace catalog |
| `GET` | `/plugins/marketplace/:name` | Marketplace plugin detail |

### Memory

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/memory` | List memories |
| `POST` | `/memory` | Store memory |
| `DELETE` | `/memory/:id` | Delete memory |
| `GET` | `/memory/search` | Search memories |
| `POST` | `/memory/reindex` | Reindex all memories |
| `GET` | `/memory/categories` | List categories |
| `POST` | `/memory/categories` | Create category |
| `PATCH` | `/memory/categories/:id` | Update category |
| `DELETE` | `/memory/categories/:id` | Delete category |
| `POST` | `/memory/:id/classify` | Reclassify memory |
| `GET` | `/memory/stats` | Memory statistics |
| `POST` | `/memory/test-embed` | Test embedding connection |

### Personality

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/personality/profiles` | List personalities |
| `POST` | `/personality/profiles` | Create personality |
| `PATCH` | `/personality/profiles/:id` | Update personality |
| `DELETE` | `/personality/profiles/:id` | Delete personality |
| `POST` | `/personality/profiles/:id/activate` | Activate personality |

### Users

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/users` | List users |
| `POST` | `/users` | Create user |
| `PATCH` | `/users/:id` | Update user |
| `DELETE` | `/users/:id` | Delete user |
| `GET` | `/users/:id/projects` | Get user project assignments |
| `POST` | `/users/:id/projects` | Assign project to user |
| `DELETE` | `/users/:id/projects/:projectId` | Remove project assignment |
| `GET` | `/users/:id/avatar/url` | Get avatar URL |

### Activity & events

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/events` | List events (activity timeline) |
| `GET` | `/activity` | Alias for events with optional type filter |

### Notes

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/notes` | List notes (by scope + target) |
| `POST` | `/notes` | Create note |

### System

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/system` | Version info, update status |
| `POST` | `/system/restart` | Restart daemon or web service |
| `POST` | `/system/update` | Trigger update check |

### Push notifications

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/push/vapid-public-key` | Get VAPID public key (no auth) |
| `POST` | `/push/subscribe` | Subscribe to push |
| `POST` | `/push/unsubscribe` | Unsubscribe from push |

### MCP

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/mcp` | MCP tool execution |

### Usage

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/usage/by-model` | Usage aggregated by model |
| `POST` | `/usage/reset` | Reset usage data (admin) |

### Integrations

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/integrations/cli-status` | Detect installed CLIs |
| `GET` | `/integrations/github-status` | GitHub CLI auth status |

---

## SSE events

Connect to `GET /events` for real-time updates:

```
GET /events
Authorization: Bearer <token>

event: task
data: {"type":"task","target":"orca-abc123","detail":"closed"}

event: mission
data: {"type":"mission","target":"m-abc123","detail":"engaged"}

event: signal
data: {"type":"signal","target":"orca-Agent42","detail":"needs_input"}

event: plan
data: {"type":"plan","target":"plan-job-xyz","detail":"done"}

event: review
data: {"type":"review","target":"orca-abc123","detail":"approved"}

event: decision
data: {"type":"decision","taskId":"orca-abc123","kind":"prompt","outcome":"approved","rationale":"Safe operation","confidence":0.92}
```

Two SSE connections are used by the web UI:

1. **Event bus** (`/events`) — global state changes
2. **Pane stream** (`/sessions/:name/stream`) — per-session terminal content

---

## Error responses

```json
{ "error": "unauthorized" }           // 401
{ "error": "forbidden" }              // 403
{ "error": "exec not allowed" }       // 400
{ "error": "checkout busy" }          // 409
{ "error": "autopilot_key_missing" }  // 400
```

All errors return a JSON body with an `error` string field.
