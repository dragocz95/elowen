# Orca

**AI agent orchestration daemon** — spawns, monitors, and manages autonomous AI coding agents (Claude Code, OpenCode, Codex) in isolated tmux sessions. Features a REST API, CLI client, and real-time web UI.

## Quick start

```bash
npm install && npm run build
npm run serve
```

Starts the daemon on `http://localhost:4400`.

## Architecture overview

```
┌─────────────┐     ┌──────────────────┐     ┌─────────────┐
│  CLI client │────▶│   REST API (Hono) │◀────│  Web UI     │
│  orca ls    │     │   port 4400       │     │  Next.js     │
└─────────────┘     └────────┬─────────┘     └─────────────┘
                             │
                    ┌────────▼─────────┐
                    │   MissionEngine  │  — tick cycle, autonomy levels
                    │   Guardrails     │  — schema/auth/payment blocking
                    │   Routing        │  — task → agent assignment
                    └────────┬─────────┘
                             │
                    ┌────────▼─────────┐
                    │   SpawnService   │  — launches agents in tmux
                    │   Deriver        │  — monitors agent output
                    └────────┬─────────┘
                             │
                    ┌────────▼─────────┐
                    │   SQLite store   │  — tasks, missions, agents
                    └──────────────────┘
```

The daemon runs a tick loop every 90 seconds: checks ready tasks, evaluates guardrails, spawns agents up to `max_sessions`, and monitors their progress via tmux pane capture. A scheduler loop runs every 30 seconds for due tasks, and a janitor loop runs every 60 seconds to reap finished agent sessions.

Includes a bundled **Hermes agent plugin** (`hermes-plugin/`) — installable via Settings → Hermes in the web UI — giving a Hermes agent full CRUD tools for orca tasks, missions, and sessions.

The web UI ships a **Monaco-based code editor** in the Projects page — browse, edit, and save files, review per-file diffs, and inspect any git commit without leaving the browser. Multi-user deployments get **role-based access control**: the bootstrap admin sees everything; non-admin users only see projects they're explicitly assigned to.

## Tech stack

| Layer | Technology |
|---|---|
| Runtime | Node.js ≥22 (ESM) |
| API | Hono + `@hono/node-server` |
| Database | SQLite via `better-sqlite3` (WAL mode) |
| Terminal | tmux (session management, pane capture) |
| Frontend | Next.js 16, React 19, Tailwind CSS 4, i18n (CS/EN), Monaco editor |
| Integration | Hermes agent plugin (Python, orca toolset) |
| Tests | Vitest |
| CLI | Native Node CLI (`dist/cli/index.js`) |

## Project structure

```
src/
├── api/          # Hono REST router + SSE event bus + auth middleware
├── cli/          # orca CLI (ls, ready, sessions, close, plan, overseer)
├── daemon/       # Entrypoint + DI bootstrap
├── deriver/      # Agent terminal monitoring (5s poll)
├── git/          # Git integration (status, branches, commits)
├── inference/    # LLM inference relay (RelayClient + FakeInference)
├── integrations/ # External integrations (Hermes, CLI detection, project files, usage)
├── overseer/     # Mission engine, guardrails, routing, scheduler, planner,
│                 #   stuck detector, decision queue, pilot/overseer agents,
│                 #   llmParse, sessionInfo
├── prompts/      # Prompt template system (render + rawTemplate)
├── shared/       # Utilities (Clock abstraction, executor metadata)
├── spawn/        # Agent launcher (tmux)
├── store/        # SQLite data layer (tasks, missions, agents, users, projects, events)
└── tmux/         # tmux driver (real + fake)
tests/            # Mirrors src/ structure (~395 tests)
web/              # Next.js frontend (~270 tests)
docs/             # Documentation tree
```

## CLI

```bash
# List tasks
orca ls

# List ready tasks (dependencies fulfilled)
orca ready

# List active sessions
orca sessions

# Close a task with result summary
orca close <taskId> --summary "what was done" --outcome ok

# Submit a plan (used by the Pilot agent)
orca plan submit --phases '[...]'

# Overseer: long-poll for a pending decision
orca overseer poll

# Overseer: submit a verdict
orca overseer decide --id <id> --approve --confidence 0.85 --rationale "..."
```

The CLI auto-starts the daemon if it isn't already running.

### Auth

If the daemon has authentication enabled, use the API token:

```bash
export ORCA_TOKEN="your-token"
curl -H "Authorization: Bearer $ORCA_TOKEN" http://localhost:4400/tasks
```

## REST API

The daemon exposes a Hono server on port 4400:

| Method | Path | Description |
|---|---|---|---|
| `GET` | `/health` | Health check |
| `GET` | `/setup` | Setup status (onboarding vs login) |
| `POST` | `/auth/login` | Login (username + password) |
| `POST` | `/auth/logout` | Revoke token |
| `GET` | `/auth/me` | Current user |
| `PATCH` | `/auth/me` | Update profile (name, email, default_exec) |
| `POST` | `/auth/me/avatar` | Upload avatar image |
| `GET` | `/users` | List users |
| `POST` | `/users` | Create user |
| `PATCH` | `/users/:id` | Edit user (admin: is_admin, allowed_execs) |
| `DELETE` | `/users/:id` | Delete user |
| `GET` | `/users/:id/avatar` | User avatar image |
| `GET` | `/users/:id/projects` | User's assigned projects (admin) |
| `POST` | `/users/:id/projects` | Assign project to user (admin) |
| `DELETE` | `/users/:id/projects/:pid` | Unassign project (admin) |
| `GET` | `/projects` | List projects |
| `POST` | `/projects` | Create project |
| `PATCH` | `/projects/:id` | Edit project path/notes (admin) |
| `GET` | `/projects/:id/git` | Git info for project |
| `GET` | `/projects/:id/files` | Project file tree |
| `GET` | `/projects/:id/raw` | Binary file bytes (image preview) |
| `GET` | `/projects/:id/file` | Read a project file |
| `PUT` | `/projects/:id/file` | Write a project file |
| `POST` | `/projects/:id/new-file` | Create a file |
| `POST` | `/projects/:id/dir` | Create a directory |
| `POST` | `/projects/:id/rename` | Rename/move file or dir |
| `POST` | `/projects/:id/copy` | Copy file or dir |
| `DELETE` | `/projects/:id/entry` | Delete file or dir |
| `GET` | `/projects/:id/diff` | Per-file working diff |
| `GET` | `/projects/:id/head` | File content at HEAD |
| `GET` | `/projects/:id/changed` | Changed files list |
| `GET` | `/projects/:id/changes` | Full working diff |
| `GET` | `/projects/:id/commit/:hash` | Commit files + diff |
| `GET` | `/projects/:id/commit/:hash/diff` | File diff in a commit |
| `GET` | `/tasks` | List tasks |
| `POST` | `/tasks` | Create task |
| `GET` | `/tasks/ready` | Tasks with all deps met |
| `GET` | `/tasks/deps` | All task dependencies |
| `GET` | `/tasks/:id/deps` | Dependencies for a task |
| `GET` | `/tasks/:id/usage` | Token/cost usage |
| `PATCH` | `/tasks/:id` | Update task (status, title, deps, exec) |
| `DELETE` | `/tasks/:id` | Delete task |
| `POST` | `/tasks/plan` | AI goal decomposition |
| `GET` | `/plan/:jobId` | Poll async plan job |
| `POST` | `/plan/:jobId/submit` | Submit plan (Pilot agent) |
| `POST` | `/tasks/:epicId/phases` | Insert/replan phases |
| `POST` | `/sessions` | Spawn agent session |
| `GET` | `/sessions` | List active sessions |
| `GET` | `/sessions/:name/stream` | SSE terminal stream |
| `GET` | `/sessions/:name/pane` | Capture pane output |
| `POST` | `/sessions/:name/keys` | Send keystrokes |
| `POST` | `/sessions/:name/resize` | Resize terminal |
| `DELETE` | `/sessions/:name` | Kill session |
| `GET` | `/missions` | List missions |
| `POST` | `/missions` | Create mission |
| `GET` | `/missions/:id` | Mission detail |
| `PATCH` | `/missions/:id` | Pause / resume mission |
| `GET` | `/missions/:id/overseer/next` | Overseer long-poll |
| `POST` | `/missions/:id/overseer/decide` | Overseer verdict |
| `DELETE` | `/missions/:id` | Disengage mission |
| `GET` | `/activity` | Activity event log |
| `GET` | `/config` | Get daemon config |
| `PUT` | `/config` | Update daemon config |
| `GET` | `/integrations/hermes/status` | Hermes plugin status |
| `POST` | `/integrations/hermes/install` | Install Hermes plugin |
| `GET` | `/integrations/cli-status` | Detect installed agent CLIs |
| `GET` | `/events` | SSE event bus |

## Missions & guardrails

**Missions** group related tasks under an epic with a defined autonomy level (L0–L3) and `max_sessions` cap. The engine ticks active missions, spawns agents for ready tasks, and respects guardrails.

**Guardrails** block tasks that touch sensitive domains until explicitly cleared:

- `schema` — database schema changes
- `auth` — authentication/authorization
- `payments` — payment logic
- `destructive` — destructive operations (rm, drop, truncate)

Guardrails are regex-matched against task titles and labels. Cleared per-mission via the `cleared_guardrails` field.

## Frontend

Next.js web UI at `web/` with:

- **Dashboard** — task list, mission overview
- **Terminal** — real-time tmux stream via SSE + Xterm.js
- **Mission control** — create and monitor missions; live token/cost usage per agent
- **Projects** — git status/log plus a Monaco code editor (file tree, edit & save, per-file diff)
- **Users** — manage users and assign them to projects (admin only)

```bash
cd web && npm install && npm run dev
```

> **Access control:** users are assigned to projects (many-to-many); the bootstrap admin manages
> assignments and sees everything. A non-admin must be assigned to the daemon's project to use it.
> Project file/editor access is per-assignment. Per-project *task/mission* scoping (one daemon
> serving multiple projects' autopilots) is a planned follow-up — today a daemon drives one project.

## Docs

| Document | Contents |
|---|---|---|
| [docs/index.md](docs/index.md) | Entry point with full index and cross-links |
| [CONCEPTS.md](docs/CONCEPTS.md) | Domain model — tasks, missions, autonomy, guardrails, overseer, deriver, routing |
| [API.md](docs/API.md) | Full REST API reference with request/response examples |
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | Module descriptions, data flow, guardrails, autonomy levels |
| [DEVELOPMENT.md](docs/DEVELOPMENT.md) | Setup, conventions, project structure, configuration |
| [DEPLOYMENT.md](docs/DEPLOYMENT.md) | Production deployment, systemd, Docker, reverse proxy |
| [CLI.md](docs/CLI.md) | CLI commands, autostart, environment variables |
| [WEB.md](docs/WEB.md) | Web UI pages, components, patterns, real-time updates |
| [TESTING.md](docs/TESTING.md) | Test architecture, fakes, writing tests, CI |
| [SECURITY.md](docs/SECURITY.md) | Auth model, guardrails, decision engine, infrastructure security |
| [GUIDES.md](docs/GUIDES.md) | Advanced patterns — task binding, autopilot planning, events, ANSI, calendar, toast |

## Development

```bash
# Build daemon
npm run build

# Run tests
npm test

# Watch mode
npm run test:watch

# Run daemon directly (development)
npm run serve
```

### Dead code detection

[Knip](https://knip.dev) finds unused files, exports, types, and dependencies across both the daemon and web UI:

```bash
npm run deadcode
```

Configuration in [`knip.json`](knip.json) covers both `src/` (daemon) and `web/` (Next.js). Run before opening a PR to keep the codebase clean.

Test architecture uses fake implementations (`FakeTmuxDriver`, `FakeClock`) to avoid real tmux or LLM dependencies. See [DEVELOPMENT.md](docs/DEVELOPMENT.md) for full details.
