# API Reference

The Orca daemon exposes a REST API. All endpoints return JSON. CORS is enabled for the web frontend.

**Base URL:** `http://localhost:4400`

---

## Authentication & access control

### Auth header

Every route except `GET /health`, `GET /setup`, and `POST /auth/login` requires authentication:

```
Authorization: Bearer <token>
```

SSE endpoints accept the token as a query parameter (EventSource does not support custom headers):

```
GET /events?token=<token>
```

### Token scopes

There are two token scopes:

| Scope | Purpose |
|---|---|
| `full` | Interactive user sessions (web UI, CLI). Full access subject to project assignment. |
| `agent` | Issued to spawned agents (`--dangerously-skip-permissions`). Restricted to a narrow allow-list: `PATCH /tasks/:id` (close), `POST /plan/:jobId/submit`, `GET /plan/:jobId`, `GET /tasks`, `GET /tasks/ready`, `GET /sessions`, `GET /missions/:id/overseer/next`, `POST /missions/:id/overseer/decide`. All other routes return 403. |

Project ownership is still enforced per-row even within the agent allow-list — agents cannot cross tenancy.

### Executor validation

Config has a global `allowedExecs` list. If an `exec` string is passed on any request, it must be in
that list or the request is rejected with `400 { "error": "exec not allowed" }`.

Additionally, a **per-user allowlist** holds per-user `allowed_execs`. When a non-admin user has a
non-empty list, they may only use exec strings from that list. Violations return
`403 { "error": "exec not allowed for user" }`. Admins and users with an empty list are unrestricted
(subject only to the global `allowedExecs`).

### Multi-tenancy / access control

Single-user mode (no `userProjects` store) — all authenticated users see everything.

Multi-user mode (with `userProjects` store) adds three gates:

1. **Global gate** — a non-admin user must be assigned to the daemon's home project to access
   `/tasks`, `/missions`, `/sessions`, `/activity`, or `/events`. Unassigned users get a blanket
   `403 { "error": "forbidden" }` on those route families.

2. **Per-project gate** — even users who pass the global gate may only see/operate projects they
   are explicitly assigned to. The admin sees everything.

3. **Per-user exec allowlist** — the non-admin's `allowed_execs` restricts which exec strings they
   may use. An empty list (or an admin) means unrestricted (subject to the global `allowedExecs`).

Agent-scoped tokens are confined to their live working set: workers → projects whose `agent:`-labelled
tasks are in progress; overseers → projects of active missions' epics.

---

## Health & setup

### Health check

```http
GET /health
```

Public — no authentication required.

**Response `200`**
```json
{ "ok": true }
```

### Setup status

```http
GET /setup
```

Public — no authentication required. Returns whether the daemon has no users yet (onboarding mode).
Returns `false` when no user store is configured.

**Response `200`**
```json
{ "needsSetup": true }
```

---

## Authentication

### Login

```http
POST /auth/login
Content-Type: application/json

{ "username": "admin", "password": "secret" }
```

Returns a bearer token. Public — no auth required.

**Response `200`**
```json
{
  "token": "a1b2c3d4...",
  "user": { "id": 1, "username": "admin", "is_admin": true, "created_at": "2026-06-17 12:00:00" }
}
```

**Error `400`** — invalid JSON body:
```json
{ "error": "invalid JSON body" }
```

**Error `401`**
```json
{ "error": "invalid credentials" }
```

**Error `429`** — too many failed attempts (10 per 5 minutes per IP):
```json
{ "error": "too many login attempts, try again later" }
```

### Logout

```http
POST /auth/logout
```

Revokes the current bearer token.

**Response `200`**
```json
{ "ok": true }
```

### Current user

```http
GET /auth/me
```

Returns the authenticated user. Requires `full` token scope — agent-scoped tokens are blocked.

**Response `200`**
```json
{
  "user": { "id": 1, "username": "admin", "name": null, "email": null, "is_admin": true, "default_exec": null, "allowed_execs": [], "avatar": null, "created_at": "2026-06-17 12:00:00" }
}
```

### Update profile

```http
PATCH /auth/me
Content-Type: application/json

{
  "name": "My Name",
  "email": "me@example.com",
  "default_exec": "sonnet"
}
```

Updates the authenticated user's profile. The `default_exec` must be in the daemon's
`allowedExecs` and the user's own `allowed_execs`. All fields are optional — only provided
fields are updated. Returns the updated profile subset.

**Response `200`**
```json
{ "name": "My Name", "email": "me@example.com", "default_exec": "sonnet" }
```

**Error `400`**
```json
{ "error": "exec not allowed" }
```

### Upload avatar

```http
POST /auth/me/avatar
Content-Type: multipart/form-data

--boundary
Content-Disposition: form-data; name="avatar"; filename="photo.png"
Content-Type: image/png

<binary data>
--boundary--
```

Uploads a profile avatar. Supported types: PNG, JPEG, WebP, GIF (max 2 MB).
Stored as `<userId>.<ext>` under the configured avatars directory. Any prior avatar of a
different extension is removed so the user never keeps two files.

**Response `200`** — returns the updated user object with `avatar` field set (e.g. `"1.png"`).

**Error `400`**
```json
{ "error": "avatars unavailable" }
```
```json
{ "error": "avatar file required" }
```

**Error `413`**
```json
{ "error": "image too large (max 2MB)" }
```

**Error `415`**
```json
{ "error": "unsupported image type" }
```

### Mint signed avatar URL

```http
GET /users/:id/avatar/url
```

Mints a short-lived (5 minute) signed URL for a user's avatar. An `<img>` element cannot set
an `Authorization` header, so an authenticated caller mints a signed link here. The link carries
only an HMAC over `(id, exp)` that expires in 5 minutes — a leaked URL is near-worthless.

Requires `avatarsDir` and `avatarSecret` configured on the daemon.

**Response `200`**
```json
{ "url": "/users/1/avatar?exp=1718900000000&sig=abc123def456..." }
```

**Error `400`**
```json
{ "error": "avatars unavailable" }
```

**Error `404`**
```json
{ "error": "not found" }
```

### Get user avatar

```http
GET /users/:id/avatar
GET /users/:id/avatar?exp=<timestamp>&sig=<hmac>
```

Serves the avatar image bytes. Two auth paths:
- **Signed** — `exp` + `sig` query params (for `<img>` elements). Must pass HMAC validation.
- **Bearer** — standard `Authorization` header (for direct API use).

Returns raw image bytes with correct `content-type` and `cache-control: no-cache`.

**Response `200`** — binary image data with content-type header (image/png, image/jpeg, etc.).

**Error `403`** — signed URL expired or signature mismatch:
```json
{ "error": "forbidden" }
```

**Error `404`** — user not found, no avatar, avatars directory not configured, or file missing on disk:
```json
{ "error": "not found" }
```

---

## Users

All `/users` routes are admin-only. During setup (no users yet), `POST /users` is open to allow
creating the first admin. Once users exist, only the admin can manage them. Non-admin users get
`403`.

### List users

```http
GET /users
```

**Response `200`**
```json
[
  { "id": 1, "username": "admin", "is_admin": true, "created_at": "2026-06-17 12:00:00", ... }
]
```

### Create user

```http
POST /users
Content-Type: application/json

{ "username": "dev", "password": "secure-pass" }
```

**Response `201`**
```json
{ "id": 2, "username": "dev", "is_admin": false, "created_at": "2026-06-17 14:00:00" }
```

**Error `409`**
```json
{ "error": "username taken" }
```

### Edit user

```http
PATCH /users/:id
Content-Type: application/json

{
  "is_admin": true,
  "allowed_execs": ["sonnet", "codex:gpt-5.4"]
}
```

Admin-only. Toggles `is_admin` and/or updates the per-user model allow-list. Cannot demote the last
admin. `allowed_execs` items not in the global `allowedExecs` are silently dropped. Only specified
fields are updated.

**Response `200`** — the full updated user object.

**Error `400`**
```json
{ "error": "cannot demote the last admin" }
```

**Error `403`**
```json
{ "error": "forbidden" }
```

**Error `404`**
```json
{ "error": "user not found" }
```

### Delete user

```http
DELETE /users/:id
```

Cannot delete the last user or the admin (admin must be transferred first). Deleting the admin
would lock out assignment management and silently re-elect another admin on restart.

**Response `200`**
```json
{ "ok": true }
```

**Error `400`**
```json
{ "error": "cannot delete the last user" }
```
```json
{ "error": "cannot delete the admin" }
```

---

## User ↔ Project assignments (admin)

Assignments gate which projects a non-admin user may see/operate. The admin always has full access.
Only available when `userProjects` store is configured. Non-admin callers get `403`.

### List a user's projects

```http
GET /users/:id/projects
```

**Response `200`** — array of project IDs:
```json
[1, 3]
```

**Error `403`** — caller is not admin.

### Assign a project

```http
POST /users/:id/projects
Content-Type: application/json

{ "projectId": 3 }
```

**Response `200`**
```json
{ "ok": true }
```

**Error `400`**
```json
{ "error": "projectId required" }
```

### Unassign a project

```http
DELETE /users/:id/projects/:pid
```

**Response `200`**
```json
{ "ok": true }
```

---

## Projects

Multi-project mode. When `projectStore` is absent, only the daemon's home project exists.

### List projects

```http
GET /projects
```

In multi-user mode, non-admin users see only their assigned projects. Admin sees all.

**Response `200`**
```json
[
  { "id": 1, "slug": "my-project", "path": "/srv/my-project", "notes": null }
]
```

### Create project

```http
POST /projects
Content-Type: application/json

{
  "slug": "my-project",
  "path": "/srv/my-project",
  "notes": "Optional pilot info"
}
```

Admin-only when multi-user auth is on. Slug must be unique.

**Response `201`**
```json
{ "id": 1, "slug": "my-project", "path": "/srv/my-project", "notes": "Optional pilot info" }
```

**Error `400`**
```json
{ "error": "projects unavailable" }
```

**Error `403`**
```json
{ "error": "forbidden" }
```

**Error `409`**
```json
{ "error": "slug taken" }
```

### Edit project

```http
PATCH /projects/:id
Content-Type: application/json

{ "path": "/srv/my-project/updated-path", "notes": "Updated pilot notes" }
```

Admin-only (when multi-user mode). Updates the path and/or Pilot notes. Slug stays immutable.
Both fields are optional — only provided fields are updated.

**Response `200`** — the full updated project object.

**Error `400`**
```json
{ "error": "projects unavailable" }
```

**Error `403`**
```json
{ "error": "forbidden" }
```

**Error `404`**
```json
{ "error": "project not found" }
```

### Delete project

```http
DELETE /projects/:id
```

Admin-only. Cascades to the project's tasks, missions, agents, and access grants. Never touches
files on disk. The daemon's home project cannot be removed.

**Response `200`**
```json
{ "ok": true }
```

**Error `400`**
```json
{ "error": "projects unavailable" }
```
```json
{ "error": "cannot remove the home project" }
```

**Error `403`**
```json
{ "error": "forbidden" }
```

**Error `404`**
```json
{ "error": "project not found" }
```

### Git info

```http
GET /projects/:id/git
```

Returns git status, branches, and recent commits for the project path. Gated by `canAccessProject`.
Requires both `projectStore` and `gitReader` configured.

**Response `200`**
```json
{
  "isRepo": true,
  "status": {
    "branch": "main",
    "dirty": 2,
    "ahead": 1,
    "behind": 0
  },
  "branches": [
    { "name": "main", "current": true },
    { "name": "feature-x", "current": false }
  ],
  "commits": [
    { "hash": "abc123", "subject": "Fix header", "author": "dev", "relative": "2 hours ago" }
  ]
}
```

**Error `400`**
```json
{ "error": "projects unavailable" }
```

**Error `403`**
```json
{ "error": "forbidden" }
```

**Error `404`**
```json
{ "error": "project not found" }
```

---

## Project file editor

Browse, read, and write files in a project root, plus diffs. All paths are validated to stay inside
the project root (symlink-escape safe). Every endpoint gated by `canAccessProject`.

All endpoints return:
- `400` `{ "error": "projects unavailable" }` — project store not configured
- `403` `{ "error": "forbidden" }` — caller cannot access this project
- `404` `{ "error": "project not found" }` — unknown project id

### File tree

```http
GET /projects/:id/files
```

Flat list of files and directories, skipping `.git`, `node_modules`, `.next`, `dist`, etc.

**Response `200`**
```json
[
  { "path": "src", "type": "dir" },
  { "path": "src/index.ts", "type": "file" }
]
```

### Read a file

```http
GET /projects/:id/file?path=src/index.ts
```

Refused for files > 2 MB.

**Response `200`**
```json
{ "path": "src/index.ts", "content": "console.log('hello');\n" }
```

**Error `400`**
```json
{ "error": "path required" }
```
```json
{ "error": "invalid path" }
```

### Write a file

```http
PUT /projects/:id/file
Content-Type: application/json

{ "path": "src/index.ts", "content": "console.log('updated');\n" }
```

**Response `200`**
```json
{ "ok": true }
```

**Error `400`**
```json
{ "error": "path and content required" }
```
```json
{ "error": "invalid path" }
```

### Binary file (image preview)

```http
GET /projects/:id/raw?path=src/logo.png
```

Returns raw file bytes for binary previews. Content-type from extension. Supports PNG, JPEG, WebP,
GIF, SVG, ICO, BMP, AVIF.

**Response `200`** — binary image data with appropriate content-type header.

**Error `400`**
```json
{ "error": "path required" }
```

**Error `415`**
```json
{ "error": "not previewable" }
```

### Create file

```http
POST /projects/:id/new-file
Content-Type: application/json

{ "path": "src/new.ts" }
```

Creates an empty file.

**Response `200`**
```json
{ "ok": true }
```

**Error `400`**
```json
{ "error": "path required" }
```

### Create directory

```http
POST /projects/:id/dir
Content-Type: application/json

{ "path": "src/components" }
```

**Response `200`**
```json
{ "ok": true }
```

**Error `400`**
```json
{ "error": "path required" }
```

### Rename / move

```http
POST /projects/:id/rename
Content-Type: application/json

{ "from": "src/old.ts", "to": "src/new.ts" }
```

**Response `200`**
```json
{ "ok": true }
```

**Error `400`**
```json
{ "error": "from and to required" }
```

### Copy

```http
POST /projects/:id/copy
Content-Type: application/json

{ "from": "src/original.ts", "to": "src/backup.ts" }
```

**Response `200`**
```json
{ "ok": true }
```

**Error `400`**
```json
{ "error": "from and to required" }
```

### Delete entry

```http
DELETE /projects/:id/entry?path=src/old.ts
```

**Response `200`**
```json
{ "ok": true }
```

**Error `400`**
```json
{ "error": "path required" }
```

### Per-file working diff

```http
GET /projects/:id/diff?path=src/index.ts
```

**Response `200`**
```json
{ "diff": "diff --git a/src/index.ts b/src/index.ts\n…" }
```

**Error `400`**
```json
{ "error": "path required" }
```

### File at HEAD

```http
GET /projects/:id/head?path=src/index.ts
```

Content of a file as it exists in the latest commit (before working-tree changes).

**Response `200`**
```json
{ "content": "console.log('original');\n" }
```

**Error `400`**
```json
{ "error": "path required" }
```

### Changed files

```http
GET /projects/:id/changed
```

Returns the list of files changed in the working tree.

**Response `200`**
```json
{ "changed": ["src/index.ts", "README.md"] }
```

### Full working diff

```http
GET /projects/:id/changes
```

Combined diff of all unstaged changes.

**Response `200`**
```json
{ "diff": "diff --git a/…\n…" }
```

### Commit files + diff

```http
GET /projects/:id/commit/:hash
```

**Response `200`**
```json
{ "diff": "diff --git …", "files": ["src/index.ts"] }
```

### File diff in a commit

```http
GET /projects/:id/commit/:hash/diff?path=src/index.ts
```

**Response `200`**
```json
{ "diff": "diff --git …" }
```

**Error `400`**
```json
{ "error": "path required" }
```

---

## Tasks

The basic unit of work. Each task belongs to a project and has a `type`, `status`, `priority`, and
optional parent/child relationships (dependencies).

### List tasks

```http
GET /tasks
GET /tasks?project_id=1
```

In multi-user mode, returns only tasks belonging to the caller's accessible projects.
The optional `?project_id=N` parameter narrows the result to a single project (access-gated —
a non-admin cannot cross tenancy). Unknown or inaccessible project IDs return `[]`.

**Response `200`**
```json
[
  {
    "id": "my-project-a1b2c3d4",
    "project_id": 1,
    "title": "Implement login page",
    "type": "task",
    "status": "open",
    "priority": "P2",
    "labels": [],
    "parent_id": null,
    "description": "",
    "scheduled_at": null,
    "autostart": 0,
    "result_summary": null,
    "outcome": null,
    "closed_at": null,
    "started_at": null,
    "agent": null,
    "exec": null,
    "created_at": "2026-06-17 12:00:00"
  }
]
```

### Create task

```http
POST /tasks
Content-Type: application/json

{
  "title": "Add dark mode",
  "type": "task",
  "priority": "P3",
  "id": "my-project-custom-id",
  "description": "Add dark mode support to the app",
  "scheduled_at": "2026-06-20T10:00:00Z",
  "autostart": 1,
  "deps": ["other-task-id"],
  "project_id": 1
}
```

Only `title` is required. If `id` is omitted, one is generated as `<project-slug>-<random-hex>`.
`deps` optionally sets task dependencies immediately. `project_id` defaults to the caller's home
project; arbitrary projects require access. `scheduled_at` and `autostart` control scheduled
(auto-launch) behavior.

**Response `201`** — the full created task object.

**Error `403`**
```json
{ "error": "forbidden" }
```

**Error `404`**
```json
{ "error": "project not found" }
```

### Update task

```http
PATCH /tasks/:id
Content-Type: application/json

{ "status": "in_progress" }
```

Supports partial updates:
- `status` — triggers SSE event. Setting `"closed"` also accepts `result_summary` and `outcome`.
- `exec` — sets executor label. Not re-validated on PATCH (the label is informational).
- `title`, `type`, `priority`, `description` — updates metadata
- `scheduled_at` — schedule for future execution (pass `null` to clear)
- `autostart` — auto-launch when scheduled_at arrives
- `deps` — replace task dependencies with the given array

When a task with a parent (epic child) is closed and the config has `autopilot.reviewOnDone`
+ `autopilot.overseerExec`, a **post-done review** decision is enqueued for the parked Overseer
agent. If the verdict rejects the result (or flags it destructive), dependent phases are blocked
until a human intervenes.

**Response `200`** — the full updated task object.

**Error `404`**
```json
{ "error": "task not found" }
```

**Error `403`**
```json
{ "error": "forbidden" }
```

### Delete task

```http
DELETE /tasks/:id
DELETE /tasks/:id?subtree=1
```

Without `?subtree=1` — removes the single task, its dependency rows, and history from the database.
Publishes a `cancelled` SSE event and purges activity events for the deleted task.

With `?subtree=1` — removes the whole mission subtree: disengages the mission (stops its agents),
then deletes the epic, every child task, their dependency edges, the mission row, and purges all
related activity events. Only meaningful when the given id is an epic.

**Response `200`**
```json
{ "ok": true }
```

With `?subtree=1`:
```json
{ "ok": true, "tasks": 5 }
```

**Error `404`**
```json
{ "error": "task not found" }
```

**Error `403`**
```json
{ "error": "forbidden" }
```

### List ready tasks

```http
GET /tasks/ready
```

Returns tasks in the daemon's home project whose dependencies are all fulfilled.
Note: always filters by the daemon's home project (not per-user project scope).

**Response `200`**
```json
[
  { "id": "task-1", "title": "Fix header", "status": "open", ... }
]
```

### List all dependencies

```http
GET /tasks/deps
```

All task dependency edges across all projects.

**Response `200`**
```json
[
  { "task_id": "phase-b", "depends_on_id": "phase-a" }
]
```

### Get task dependencies

```http
GET /tasks/:id/deps
```

**Response `200`**
```json
["dependency-task-id-1", "dependency-task-id-2"]
```

### Task usage (tokens + cost)

```http
GET /tasks/:id/usage
```

Token/cost usage for the task's agent run, read from the executor CLI's local session storage
(opencode / claude / codex). Portable — no relay needed. Passes sibling tasks and the task's
own project path so usage can disambiguate concurrent agents by start-order.

**Response `200`**
```json
{
  "inputTokens": 12000,
  "outputTokens": 3400,
  "totalTokens": 15400,
  "costUsd": 0.045,
  "contextWindow": 200000,
  "model": "claude-sonnet-4-20250514"
}
```

`null` when no matching session is found.

**Error `404`**
```json
{ "error": "not found" }
```

**Error `403`**
```json
{ "error": "forbidden" }
```

---

## Planning (AI plan decomposition)

### Create plan (autopilot + manual)

```http
POST /tasks/plan
Content-Type: application/json

{
  "goal": "Build a login page with OAuth support",
  "exec": "sonnet",
  "autoModel": false,
  "autonomy": "L3",
  "maxSessions": 1,
  "engage": true,
  "phases": [],
  "dryRun": false,
  "prompt": "",
  "project_id": 1
}
```

Decomposes a goal into ordered implementation phases. Each phase becomes a task, chained
sequentially via dependencies. Optionally engages a mission immediately.

When `autoModel: true`, the planner picks the best model per phase from the configured
`modelNotes` descriptions — each phase gets its own `exec` field. When `autoModel: false`
(default), all phases use the uniform `exec` value. `autoModel` and `exec` are mutually
exclusive: if `autoModel` is true, `exec` is ignored.

**Manual mode** (`phases` array supplied, non-empty): bypasses the LLM entirely. Phases are
persisted synchronously and the endpoint returns `201` immediately. No API key needed.

**Autopilot mode** (no `phases` supplied): always asynchronous — returns a plan job (`202`).
Two backends:

- **Relay backend** (default): the planner LLM decomposes the goal inline. API key
  (`autopilot.apiKey`) must be set. If missing, returns `400 autopilot_key_missing`.
- **Agent backend** (`config.autopilot.pilotExec` set): the **Pilot** spawns as a repo-aware CLI
  agent that submits phases via `orca plan submit`. No API key needed.

`dryRun: true` returns phases as a preview without persisting (playground mode). `prompt`
overrides the saved autopilot prompt template. `project_id` targets a non-home project.

**Response `201`** (manual mode)
```json
{
  "epic": { "id": "my-project-a1b2c3d4", "title": "Build a login page...", "type": "epic", ... },
  "phases": [
    { "id": "my-project-b5c6d7e8", "title": "Set up OAuth provider", "status": "open", ... }
  ],
  "mission": { "id": "m-my-project-a1b2c3d4", "state": "active", ... }
}
```

`mission` is present only when `engage: true`.

**Response `202`** (autopilot — relay or agent backend)
```json
{
  "jobId": "pj-1a2b3c",
  "epicId": "my-project-a1b2c3d4"
}
```

When the relay backend is used, `epicId` is present immediately. For the agent backend it arrives
once the Pilot submits.

**Response `200`** (dryRun)
```json
{
  "phases": [
    { "title": "Set up OAuth provider", "type": "feature" }
  ]
}
```

**Error `400`**
```json
{ "error": "goal required" }
```
```json
{ "error": "exec not allowed" }
```
```json
{ "error": "autopilot_key_missing" }
```

**Error `403`**
```json
{ "error": "exec not allowed for user" }
```

**Error `502`**
```json
{ "jobId": "pj-1a2b3c", "error": "plan_parse_failed" }
```

### Poll plan job

```http
GET /plan/:jobId
```

Returns the current state of an async planning job. The job id acts as a capability — agent-scoped
tokens need no project access gate for their own job (the id is unguessable).

**Response `200`**
```json
{
  "id": "pj-1a2b3c",
  "epicId": "my-project-a1b2c3d4",
  "goal": "Build a login page with OAuth support",
  "status": "done",
  "phases": [
    { "title": "Set up OAuth provider", "type": "feature" }
  ]
}
```

`status` is `planning` | `done` | `failed`.

**Error `404`**
```json
{ "error": "not found" }
```

**Error `403`**
```json
{ "error": "forbidden" }
```

### Submit plan (Pilot agent)

```http
POST /plan/:jobId/submit
Content-Type: application/json

{
  "phases": [
    { "title": "Set up database", "type": "chore" },
    { "title": "Create endpoints", "type": "feature" }
  ]
}
```

Used by the **Pilot agent** to submit phases for an async planning job. The submitted phases are
parsed with the same validator as the relay planner output. On success, the plan is finalized
(persisted, optionally engaged, SSE broadcast).

**Response `200`** — the full updated plan job object.

**Error `400`**
```json
{ "error": "invalid phases" }
```

**Error `404`**
```json
{ "error": "not found" }
```

**Error `403`**
```json
{ "error": "forbidden" }
```

### Insert / replan phases on an existing epic

```http
POST /tasks/:epicId/phases
Content-Type: application/json

{
  "phases": [{ "title": "Add rate limiting", "type": "feature" }],
  "goal": "harden the auth flow",
  "exec": "sonnet",
  "autoModel": false,
  "prompt": ""
}
```

Appends new phases to an existing epic. Two modes:

- **Manual insert** (supply `phases` array): no LLM, no API key needed. Persisted synchronously.
  Returns `201`.
- **Replan** (supply `goal` string): the autopilot decomposes the residual goal. Async path —
  returns `202` with a `jobId` scoped to this epic. Supports both relay and agent Pilot backends.

New phases are chained to run **after** the epic's current tail phases (leaves that nothing else
depends on), then sequentially among themselves. If a mission is already active on the epic
(`m-<epicId>`), it is ticked immediately. `exec`, when given, is set on every new phase. When
`autoModel: true`, the planner picks the best model per phase from the configured `modelNotes`
descriptions — each phase gets its own `exec` field, and the uniform `exec` is ignored.

**Response `201`** (manual insert)
```json
{
  "epic": { "id": "my-project-a1b2c3d4", "type": "epic", ... },
  "phases": [
    { "id": "my-project-b5c6d7e8", "title": "Add rate limiting", "status": "open", ... }
  ]
}
```

**Response `202`** (replan — async)
```json
{ "jobId": "pj-1a2b3c", "epicId": "my-project-a1b2c3d4" }
```

**Error `404`**
```json
{ "error": "epic not found" }
```

**Error `400`**
```json
{ "error": "phases or goal required" }
```
```json
{ "error": "exec not allowed" }
```
```json
{ "error": "autopilot_key_missing" }
```

**Error `403`**
```json
{ "error": "exec not allowed for user" }
```
```json
{ "error": "forbidden" }
```

**Error `502`**
```json
{ "jobId": "pj-1a2b3c", "epicId": "my-project-a1b2c3d4", "error": "plan_parse_failed" }
```

---

## Admin

### Cleanup (wipe operational data)

```http
POST /admin/cleanup
```

Admin-only. Wipes ALL operational data — every task (including deps), every mission, and the
entire activity feed — and stops every live agent session. Projects, users, and config are kept.
**Irreversible.** Returns counts of removed data.

**Response `200`**
```json
{
  "ok": true,
  "tasks": 42,
  "missions": 3,
  "events": 156
}
```

**Error `403`**
```json
{ "error": "forbidden" }
```

---

## Sessions

Sessions correspond to tmux sessions running a single coding agent on a single task.
Every `orca-*` session is classified by role: `agent` (worker), `pilot` (planning), or
`overseer` (per-mission decision loop).

### List sessions

```http
GET /sessions
```

Returns classified live tmux sessions filtered to the `orca-` prefix.

**Response `200`**
```json
[
  { "name": "orca-SwiftLake0", "role": "agent", "agent": "SwiftLake0" },
  { "name": "orca-pilot-Patricita", "role": "pilot", "agent": "Patricita" },
  { "name": "orca-overseer-m-my-project-a1b2c3d4", "role": "overseer", "agent": "", "missionId": "m-my-project-a1b2c3d4" }
]
```

### Spawn session

```http
POST /sessions
Content-Type: application/json

{
  "taskId": "my-project-a1b2c3d4",
  "exec": "sonnet"
}
```

Creates a tmux session named `orca-<uniqueName>`, sets the task `in_progress`, records the
agent name, marks the started_at timestamp, and launches the agent in the task's own project
directory. `exec` is validated against the global `allowedExecs` and the per-user `allowed_execs`.
If the spawn fails, the task is immediately reverted to `open` (no stuck-detector delay).

**Response `201`**
```json
{ "session": "orca-SwiftLake0" }
```

**Error `400`**
```json
{ "error": "exec not allowed" }
```

**Error `403`**
```json
{ "error": "exec not allowed for user" }
```
```json
{ "error": "forbidden" }
```

**Error `404`**
```json
{ "error": "task not found" }
```

**Error `500`**
```json
{ "error": "spawn failed: <error message>" }
```

### Kill session

```http
DELETE /sessions/:name
```

Gated by session accessibility (caller must own the session's project). Kills the tmux session.

**Response `200`**
```json
{ "ok": true }
```

**Error `403`**
```json
{ "error": "forbidden" }
```

### Send keys

```http
POST /sessions/:name/keys
Content-Type: application/json

{ "keys": ["y", "Enter"] }
```

Sends keystrokes to the tmux session (e.g., approve agent prompts, interrupt with `["C-c"]`).
All key tokens are validated: must be a non-empty array of non-flag strings (keys starting with
`-` are rejected to prevent tmux flag injection).

**Response `200`**
```json
{ "ok": true }
```

**Error `400`**
```json
{ "error": "keys must be a non-empty array of non-flag strings" }
```

**Error `403`**
```json
{ "error": "forbidden" }
```

### Resize terminal

```http
POST /sessions/:name/resize
Content-Type: application/json

{ "cols": 120, "rows": 40 }
```

Resizes the tmux window. No hard clamping — the full dimensions are passed to tmux.

**Response `200`**
```json
{ "ok": true }
```

**Error `400`**
```json
{ "error": "cols and rows required" }
```

**Error `403`**
```json
{ "error": "forbidden" }
```

### Capture pane

```http
GET /sessions/:name/pane
GET /sessions/:name/pane?ansi=1
```

Returns the last 60 lines of the session's pane. When `?ansi=1`, ANSI escape codes are preserved
(otherwise stripped for plain text).

**Response `200`**
```json
{ "pane": "> orca ready\n1. Fix header\n2. Add footer\n" }
```

**Error `403`**
```json
{ "error": "forbidden" }
```

### Stream session output

```http
GET /sessions/:name/stream
```

Server-Sent Events stream of the tmux pane content (ANSI, last 200 lines, polled once per second).
First frame is delivered synchronously so clients render immediately.

```
event: pane
data: {"pane": "\u001b[0m\u001b[1m>\u001b[0m \u001b[32morca\u001b[0m ..."}
```

The stream stays alive even if the session dies (returns empty frames). After 5 consecutive write
errors (client disconnected), the stream stops. Authentication via session-level access gate.

**Error `403`**
```json
{ "error": "forbidden" }
```

### Mint a terminal-stream ticket

```http
POST /sessions/:name/ws-ticket
```

Issues a single-use, short-TTL ticket to open the real-PTY terminal WebSocket (below). Authenticated
(Bearer/cookie) and ownership-gated by the same session access gate. The resulting stream is fully
interactive (keystrokes reach the pane).

```json
{ "ticket": "a1b2c3…" }
```

**Error `403`** — `{ "error": "forbidden" }` when the caller can't access the session.

### Terminal PTY stream (WebSocket)

```http
GET /ws/terminal?ticket=<ticket>
```

WebSocket upgrade served by the **daemon directly** (nginx proxies its `/ws/` location to :4400; the
Next.js BFF can't proxy a WS upgrade). It carries no token — the single-use ticket is the capability,
redeemed at upgrade. The daemon then bridges a `tmux attach` PTY (`node-pty`) to the socket:

- **server → client:** raw terminal bytes (the PTY's stdout)
- **client → server:** raw input bytes, or a JSON control frame `{"type":"resize","cols":N,"rows":M}`

When the ticket is invalid or `node-pty` is unavailable, the socket is closed with application code
**`4001`** (and no data frame), signalling the browser to fall back to the snapshot `/stream` mirror.

---

## Missions

A mission drives an epic's child tasks through the autopilot loop — picking ready tasks, spawning
agents, and processing approvals. Missions are identified by `m-<epicId>`.

### List active missions

```http
GET /missions
```

In multi-user mode, filtered to the caller's accessible projects (missions whose epic's project
is accessible).

**Response `200`**
```json
[
  {
    "id": "m-my-project-a1b2c3d4",
    "epic_id": "my-project-a1b2c3d4",
    "autonomy": "L2",
    "max_sessions": 1,
    "state": "active",
    "started_at": "2026-06-17 12:00:00"
  }
]
```

### Get mission detail

```http
GET /missions/:id
```

Returns the mission with its epic, full task tree, dependencies, and progress breakdown.

**Response `200`**
```json
{
  "mission": { "id": "m-my-project-a1b2c3d4", "state": "active", "autonomy": "L2", "max_sessions": 1, "started_at": "2026-06-17 12:00:00" },
  "epic": { "id": "my-project-a1b2c3d4", "title": "Build login page", "type": "epic", "status": "in_progress", ... },
  "tasks": [
    { "id": "my-project-b5c6d7e8", "title": "Set up OAuth provider", "status": "closed", ... },
    { "id": "my-project-c9d0e1f2", "title": "Build login form", "status": "open", ... }
  ],
  "deps": [
    { "taskId": "my-project-c9d0e1f2", "dependsOnId": "my-project-b5c6d7e8" }
  ],
  "progress": { "total": 2, "open": 1, "inProgress": 0, "blocked": 0, "closed": 1, "cancelled": 0 }
}
```

**Error `404`**
```json
{ "error": "mission not found" }
```

**Error `403`**
```json
{ "error": "forbidden" }
```

### Create mission (engage)

```http
POST /missions
Content-Type: application/json

{
  "epicId": "my-project-a1b2c3d4",
  "autonomy": "L2",
  "maxSessions": 1
}
```

Triggers an immediate tick cycle — picks ready tasks and spawns agents up to `maxSessions`.
Validates the epic exists and is accessible. Defaults `autonomy` to `"L3"`, `maxSessions` to `1`.

**Response `201`** — the full mission object.

**Error `400`**
```json
{ "error": "epicId required" }
```

**Error `404`**
```json
{ "error": "epic not found" }
```

**Error `403`**
```json
{ "error": "forbidden" }
```

### Pause / Resume mission

```http
PATCH /missions/:id
Content-Type: application/json

{ "action": "pause" }
```

Actions: `pause` | `resume`

`pause` kills running agents and reverts their tasks to `open`, then marks the mission `paused`.
`resume` flips state to `active`, re-parks the overseer (if configured), then ticks immediately.

**Response `200`** — the full updated mission object.

**Error `404`**
```json
{ "error": "mission not found" }
```

**Error `403`**
```json
{ "error": "forbidden" }
```

### Disengage mission

```http
DELETE /missions/:id
```

Sets state to `disengaged` and kills all associated agent sessions.

**Response `200`**
```json
{ "ok": true }
```

**Error `404`**
```json
{ "error": "mission not found" }
```

**Error `403`**
```json
{ "error": "forbidden" }
```

### PR-native workflow (optional)

Active only when `config.autopilot.prEnabled` is set (see [CONCEPTS](CONCEPTS.md#pr-native-workflow-optional)). The mission's branch + PR metadata is attached to `GET /missions` and `GET /missions/:id` as a `pr` field (`{ branch, prNumber, prUrl, prState }`, or `null`).

```http
POST /missions/:id/pr
```

Manually open the PR for a PR-native mission (used when `prAutoOpen` is off). Runs the verify gate, pushes the branch and opens the PR via `gh`.

**Response `200`**
```json
{ "url": "https://github.com/owner/repo/pull/42", "number": 42 }
```

**Error `422`** — the verify command failed (`{ "error": "...", "output": "..." }`), the project has no GitHub remote, or `gh` is unavailable/unauthenticated. **Error `400`** when PR workflow isn't enabled; **`404`** unknown mission; **`403`** forbidden.

PR review feedback is ingested by a ~60 s daemon poller (`prFeedback`), not a request endpoint: fresh actionable feedback is routed through the pilot into 1..N fix phases (bounded by a 2-round fix budget), then the mission is re-engaged.

### Overseer long-poll (parked agent)

Used by the parked per-mission Overseer agent when `config.autopilot.overseerExec` is set. The agent
blocks on `next` until a decision is needed (or a heartbeat), then answers via `decide`. No model
output is parsed — the agent posts a structured verdict; the local destructive heuristic is
authoritative and applied at enqueue time.

```http
GET /missions/:id/overseer/next?timeoutMs=30000
```

Blocks until a decision is pending, then returns the decision request. Returns `{}` on a heartbeat
(nothing pending). `timeoutMs` caps the long-poll (max 30 000).

**Response `200`**
```json
{ "id": "d-abc", "kind": "task", "context": { "title": "...", "outcome": "ok", "summary": "..." } }
```

`kind` ∈ `task` | `prompt` | `review`.
`context` contains `title`, `outcome`, `summary` for `review` kind, task/prompt details for others.

**Heartbeat** (nothing pending after timeout):
```json
{}
```

**Error `403`**
```json
{ "error": "forbidden" }
```

```http
POST /missions/:id/overseer/decide
Content-Type: application/json

{ "id": "d-abc", "approve": true, "confidence": 0.8, "rationale": "looks safe" }
```

Resolves the awaiting decision. `confidence` is clamped to 0–1. `destructive` in the verdict
is always overwritten to `false` — the enqueue-time heuristic is authoritative, never trusted
from the agent.

**Response `200`**
```json
{ "ok": true }
```

**Error `400`**
```json
{ "error": "id required" }
```

**Error `403`**
```json
{ "error": "forbidden" }
```

**Error `404`**
```json
{ "error": "no such decision" }
```

---

## Assistant (per-user advisor)

The assistant is a persistent, per-user agent session that drives Orca on the user's behalf through
the built-in MCP server. Each user gets their own `orca-advisor-<userId>` tmux session. Full-scope
(non-`agent`) callers only — a spawned agent must not be able to start/stop a human's assistant.

### Assistant status

```http
GET /advisor/status
```

Returns the caller's advisor session state.

**Response `200`**
```json
{ "running": false, "exec": "sonnet", "session": null }
```

When `running`, `session` is the `orca-advisor-<userId>` tmux session name.

**Response `200`** — feature disabled (in-memory DB / tests):
```json
{ "running": false, "exec": "", "session": null }
```

### Start assistant

```http
POST /advisor/start
Content-Type: application/json

{ "exec": "sonnet" }
```

Starts the caller's advisor session with the chosen executor. The exec must be in the daemon's
`allowedExecs` and (for a restricted non-admin) the user's own `allowed_execs`. The chosen exec is
remembered on the user record for autostart on next login. Idempotent — a no-op if already running.

Internally: resolves the executor, mints a dedicated `advisor`-scoped token, writes a per-program
MCP config into the advisor's cwd, and spawns `orca-advisor-<userId>` via tmux with the user's own
token overriding the daemon's agent service token.

**Response `201`**
```json
{ "session": "orca-advisor-1" }
```

**Error `400`**
```json
{ "error": "exec not allowed" }
```

**Error `403`**
```json
{ "error": "exec not allowed for user" }
```

**Error `503`** — advisor feature unavailable (in-memory DB):
```json
{ "error": "advisor unavailable" }
```

### Stop assistant

```http
POST /advisor/stop
```

Kills the caller's advisor tmux session. The advisor token is untouched (reused across restarts).

**Response `200`**
```json
{ "ok": true }
```

---

## MCP server

The daemon exposes a built-in MCP server at `/mcp` so the assistant (and any other MCP-capable client)
can drive Orca with native tools. Each request is handled statelessly: a fresh `McpServer` + transport
bound to the request's bearer token, so every connection acts with exactly its user's rights.

```http
POST /mcp
Authorization: Bearer <token>
Content-Type: application/json

<JSON-RPC request body>
```

The endpoint accepts the standard MCP Streamable HTTP transport protocol. Tools exposed:

| Tool | Input | Purpose |
|---|---|---|
| `orca_request` | `method`, `path`, `body?` | Generic escape hatch — call any Orca REST endpoint |
| `orca_tasks` | — | List all tasks |
| `orca_create_task` | `title`, `project_id?`, `description?` | Create a task |
| `orca_plan` | `goal`, `project_id?` | Plan a goal into an epic with phases (autopilot) |
| `orca_sessions` | — | List live agent sessions |

Every tool delegates to the shared `callOrcaApi` core (`src/shared/apiClient.ts`) — the same forward
path as the `orca api` CLI verb, so a new REST endpoint works in both with zero edits.

**Response `200`** — JSON-RPC response with the tool result as MCP `text` content.

---

## Activity log

```http
GET /activity
```

Time-ordered event log.

| Query param | Description |
|---|---|
| `limit` | Max events to return (number) |
| `type` | Filter: `task`, `mission`, `signal`, `plan` |

**Response `200`**
```json
[
  { "id": 1, "type": "task", "target": "task-1", "detail": "created", "ts": "2026-06-17T12:00:00.000Z" },
  { "id": 2, "type": "signal", "target": "orca-SwiftLake0", "detail": "working", "ts": "2026-06-17T12:05:00.000Z" }
]
```

When no event store is configured, returns `[]`.

---

## Config

### Get config

```http
GET /config
```

Returns the full daemon configuration. API keys are never exposed — `apiKeySet` is a boolean flag.
The `prompt` field holds the raw custom planner template (empty = use built-in default).

**Response `200`**
```json
{
  "allowedExecs": ["sonnet", "opencode:deepseek-v4-flash", "codex:gpt-5.4"],
  "customModels": [],
  "hiddenPresets": [],
  "modelNotes": {
    "sonnet": "Fast, reliable everyday coder with strong tool use and instruction following.",
    "opus": "Most capable reasoner; best for hard architecture and tricky debugging."
  },
  "defaults": { "exec": "sonnet", "autonomy": "L3", "maxSessions": 1 },
  "autopilot": {
    "model": "claude-opus-4-8",
    "overseerModel": "",
    "pilotExec": "",
    "overseerExec": "",
    "reviewOnDone": false,
    "apiUrl": "https://relay.example/v1",
    "apiKeySet": false,
    "notes": "",
    "prompt": ""
  },
  "providers": {
    "claude-code": { "bin": "claude", "args": "" },
    "opencode": { "bin": "opencode", "args": "" },
    "codex": { "bin": "codex", "args": "" }
  },
  "security": { "tokenTtlDays": 30 }
}
```

`modelNotes` is a map of exec → capability description. Seeded from `src/shared/execs.ts` (`EXEC_NOTES`) on first install. User edits persist and merge *under* built-in defaults so known models always carry a description. Used by the autopilot model picker (`autoModel`) to let the planner choose the best model per phase.

Per-role reasoning backends:

| Field | Effect |
|---|---|
| `autopilot.pilotExec` | When set (e.g. `claude:opus`), the **Pilot** runs as a repo-aware CLI agent that submits its plan via `orca plan submit`. Empty → relay model decomposes inline. |
| `autopilot.overseerExec` | When set, the **Overseer** runs as a parked per-mission CLI agent that long-polls `GET /missions/:id/overseer/next`. Empty → decisions use the relay (`overseerModel` / `model`). |
| `autopilot.reviewOnDone` | When `true` (and `overseerExec` is set), each closed mission phase enqueues a post-done review for the Overseer. Default `false`. |
| `autopilot.model` | Planner model (for `POST /tasks/plan` relay backend). |
| `autopilot.overseerModel` | Overseer decision model (falls back to `model` when empty). |
| `autopilot.prompt` | Custom planner template (empty = built-in `planner.md`). |

### Update config

```http
PUT /config
Content-Type: application/json

{ "allowedExecs": ["sonnet"], "autopilot": { "apiKey": "sk-..." } }
```

Admin-only (when users exist). All fields are partial — only specified fields are updated. During
setup (no users yet) it is open so onboarding can save providers before the first admin exists.

**Response `200`**
```json
{ "ok": true }
```

**Error `403`**
```json
{ "error": "forbidden" }
```

---

## Events (SSE)

```http
GET /events?token=<token>
```

Server-Sent Events stream for real-time updates. Auth token as query parameter (EventSource
doesn't support custom headers). The stream stays alive indefinitely, sleeping 30s between
keep-alive cycles. Closes on client disconnect via `abort` signal.

### Event types

**task**
```
event: task
data: {"type": "task", "taskId": "my-project-a1b2c3d4", "status": "in_progress"}
```

**mission**
```
event: mission
data: {"type": "mission", "missionId": "m-my-project-a1b2c3d4", "state": "active"}
```

**signal** (from deriver)
```
event: signal
data: {"type": "signal", "session": "orca-Agent0", "signal": {"type": "working"}}
```

Signal types: `working`, `needs_input`, `complete`.

**plan** (async planning job)
```
event: plan
data: {"type": "plan", "jobId": "pj-1a2b3c", "status": "done", "epicId": "my-project-a1b2c3d4", "phases": [{"title": "...", "type": "feature"}]}
```

Emitted on `planning` (job created), `done` (plan finalized), `failed` (error). The `phases` array
is present on `done`.

---

## Integrations

### Hermes MCP status

```http
GET /integrations/hermes/status?home=~/.hermes
```

Reports whether Orca is registered as an MCP server (and enabled) in a same-host Hermes instance.
`home` override is constrained to live under the daemon's configured Hermes root
(`HERMES_HOME` env, default `~/.hermes`). Admin-only in multi-user mode.

**Response `200`**
```json
{
  "home": "~/.hermes",
  "exists": true,
  "registered": true,
  "enabled": true
}
```

**Error `400`**
```json
{ "error": "home must be under the Hermes root" }
```

**Error `403`**
```json
{ "error": "forbidden" }
```

### Register Orca MCP in Hermes

```http
POST /integrations/hermes/install
Content-Type: application/json

{
  "home": "~/.hermes",
  "url": "http://localhost:4400",
  "token": "a1b2c3d4..."
}
```

Writes the Orca bearer token into Hermes's `.env` (as `MCP_ORCA_API_KEY`) and adds an `orca` entry
under `mcp_servers:` in its `config.yaml` (pointing at `<url>/mcp` with a bearer auth header). Backs
up the config first. Admin-only (writes credentials into a host path).

**Response `201`**
```json
{
  "mcpUrl": "http://localhost:4400/mcp",
  "registered": true,
  "enabled": true,
  "envWritten": true,
  "backedUp": true,
  "status": { "home": "~/.hermes", "exists": true, "registered": true, "enabled": true }
}
```

**Error `400`**
```json
{ "error": "url and token required" }
```
```json
{ "error": "home must be under the Hermes root" }
```

**Error `403`**
```json
{ "error": "forbidden" }
```

### CLI detection

```http
GET /integrations/cli-status
```

Detects which agent CLIs (claude, opencode, codex) are installed and usable, and whether the daemon
has enough configuration to operate. Used by the onboarding wizard.

**Response `200`**
```json
{
  "clis": [
    { "name": "claude", "installed": true, "path": "/usr/local/bin/claude", "version": "1.2.3" },
    { "name": "opencode", "installed": false, "path": null, "version": null },
    { "name": "codex", "installed": true, "path": "/usr/bin/codex", "version": "0.5.0" }
  ],
  "ready": true,
  "missing": []
}
```

---

## Status codes

| Code | Meaning |
|---|---|
| `200` | Success |
| `201` | Created |
| `202` | Accepted (async plan job) |
| `400` | Bad request (invalid input, exec not allowed, missing fields, invalid JSON body) |
| `401` | Unauthorized (missing or invalid token) |
| `403` | Forbidden (not accessible for this user/project, exec not allowed for user, agent token capability limit) |
| `404` | Not found |
| `409` | Conflict (duplicate slug/username) |
| `413` | Payload too large (avatar exceeds 2 MB) |
| `429` | Too many requests (login rate limit: 10 per 5 minutes per IP) |
| `415` | Unsupported media type (avatar image type not accepted) |
| `502` | Bad gateway (AI plan parsing failed) |
| `500` | Internal error (includes spawn failures) |

## Error format

All errors follow the same shape:

```json
{ "error": "descriptive message" }
```

The `POST /tasks/plan` and `POST /tasks/:epicId/phases` error responses for plan_parse_failed
also include `jobId` and `epicId` where applicable:
```json
{ "jobId": "pj-1a2b3c", "epicId": "my-project-a1b2c3d4", "error": "plan_parse_failed" }
```

## Complete route index

| # | Method | Path | Auth | Section |
|---|---|---|---|---|
| 1 | `GET` | `/health` | Public | Health & setup |
| 2 | `GET` | `/setup` | Public | Health & setup |
| 3 | `POST` | `/auth/login` | Public | Authentication |
| 4 | `POST` | `/auth/logout` | Bearer | Authentication |
| 5 | `GET` | `/auth/me` | Bearer | Authentication |
| 6 | `PATCH` | `/auth/me` | Bearer | Authentication |
| 7 | `POST` | `/auth/me/avatar` | Bearer | Authentication |
| 8 | `GET` | `/users/:id/avatar/url` | Bearer | Authentication |
| 9 | `GET` | `/users/:id/avatar` | Bearer/signed | Authentication |
| 10 | `GET` | `/users` | Bearer (admin) | Users |
| 11 | `POST` | `/users` | Bearer (admin/open) | Users |
| 12 | `PATCH` | `/users/:id` | Bearer (admin) | Users |
| 13 | `DELETE` | `/users/:id` | Bearer (admin) | Users |
| 14 | `GET` | `/users/:id/projects` | Bearer (admin) | Assignments |
| 15 | `POST` | `/users/:id/projects` | Bearer (admin) | Assignments |
| 16 | `DELETE` | `/users/:id/projects/:pid` | Bearer (admin) | Assignments |
| 17 | `GET` | `/projects` | Bearer | Projects |
| 18 | `POST` | `/projects` | Bearer (admin) | Projects |
| 19 | `PATCH` | `/projects/:id` | Bearer (admin) | Projects |
| 20 | `DELETE` | `/projects/:id` | Bearer (admin) | Projects |
| 21 | `GET` | `/projects/:id/git` | Bearer | Projects |
| 22 | `GET` | `/projects/:id/files` | Bearer | File editor |
| 23 | `GET` | `/projects/:id/file` | Bearer | File editor |
| 24 | `PUT` | `/projects/:id/file` | Bearer | File editor |
| 25 | `GET` | `/projects/:id/raw` | Bearer | File editor |
| 26 | `POST` | `/projects/:id/new-file` | Bearer | File editor |
| 27 | `POST` | `/projects/:id/dir` | Bearer | File editor |
| 28 | `POST` | `/projects/:id/rename` | Bearer | File editor |
| 29 | `POST` | `/projects/:id/copy` | Bearer | File editor |
| 30 | `DELETE` | `/projects/:id/entry` | Bearer | File editor |
| 31 | `GET` | `/projects/:id/diff` | Bearer | File editor |
| 32 | `GET` | `/projects/:id/head` | Bearer | File editor |
| 33 | `GET` | `/projects/:id/commit/:hash` | Bearer | File editor |
| 34 | `GET` | `/projects/:id/commit/:hash/diff` | Bearer | File editor |
| 35 | `GET` | `/projects/:id/changed` | Bearer | File editor |
| 36 | `GET` | `/projects/:id/changes` | Bearer | File editor |
| 37 | `GET` | `/activity` | Bearer | Activity |
| 38 | `GET` | `/tasks` | Bearer (full + agent) | Tasks |
| 39 | `POST` | `/tasks` | Bearer | Tasks |
| 40 | `GET` | `/tasks/ready` | Bearer (full + agent) | Tasks |
| 41 | `GET` | `/tasks/deps` | Bearer | Tasks |
| 42 | `GET` | `/tasks/:id/usage` | Bearer | Tasks |
| 43 | `PATCH` | `/tasks/:id` | Bearer (full + agent) | Tasks |
| 44 | `GET` | `/tasks/:id/deps` | Bearer | Tasks |
| 45 | `DELETE` | `/tasks/:id` | Bearer | Tasks |
| 46 | `POST` | `/admin/cleanup` | Bearer (admin) | Admin |
| 47 | `POST` | `/tasks/plan` | Bearer | Planning |
| 48 | `GET` | `/plan/:jobId` | Bearer (full + agent) | Planning |
| 49 | `POST` | `/plan/:jobId/submit` | Bearer (full + agent) | Planning |
| 50 | `POST` | `/tasks/:epicId/phases` | Bearer | Planning |
| 51 | `GET` | `/integrations/hermes/status` | Bearer (admin) | Integrations |
| 52 | `POST` | `/integrations/hermes/install` | Bearer (admin) | Integrations |
| 53 | `GET` | `/integrations/cli-status` | Bearer | Integrations |
| 54 | `GET` | `/sessions` | Bearer (full + agent) | Sessions |
| 55 | `POST` | `/sessions` | Bearer | Sessions |
| 56 | `DELETE` | `/sessions/:name` | Bearer | Sessions |
| 57 | `POST` | `/sessions/:name/keys` | Bearer | Sessions |
| 58 | `POST` | `/sessions/:name/resize` | Bearer | Sessions |
| 59 | `GET` | `/sessions/:name/pane` | Bearer | Sessions |
| 60 | `GET` | `/sessions/:name/stream` | Bearer | Sessions |
| 61 | `GET` | `/missions` | Bearer | Missions |
| 62 | `GET` | `/missions/:id` | Bearer | Missions |
| 63 | `POST` | `/missions` | Bearer | Missions |
| 64 | `PATCH` | `/missions/:id` | Bearer | Missions |
| 65 | `DELETE` | `/missions/:id` | Bearer | Missions |
| 66 | `GET` | `/missions/:id/overseer/next` | Bearer (full + agent) | Missions |
| 67 | `POST` | `/missions/:id/overseer/decide` | Bearer (full + agent) | Missions |
| 68 | `GET` | `/config` | Bearer | Config |
| 69 | `PUT` | `/config` | Bearer (admin/setup) | Config |
| 70 | `GET` | `/advisor/status` | Bearer (full) | Assistant |
| 71 | `POST` | `/advisor/start` | Bearer (full) | Assistant |
| 72 | `POST` | `/advisor/stop` | Bearer (full) | Assistant |
| 73 | `POST` | `/mcp` | Bearer | MCP server |
| 74 | `GET` | `/events` | Bearer (?token) | Events |
