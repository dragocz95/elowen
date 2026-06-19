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

## Tech stack

| Layer | Technology |
|---|---|
| Runtime | Node.js ≥22 (ESM) |
| API | Hono + `@hono/node-server` |
| Database | SQLite via `better-sqlite3` (WAL mode) |
| Terminal | tmux (session management, pane capture) |
| Frontend | Next.js 16, React 19, Tailwind CSS 4, i18n (CS/EN) |
| Integration | Hermes agent plugin (Python, orca toolset) |
| Tests | Vitest |
| CLI | Native Node CLI (`bin/orca`) |

## Project structure

```
src/
├── api/          # Hono REST router + SSE event bus
├── cli/          # orca CLI client
├── daemon/       # Entrypoint + DI bootstrap
├── deriver/      # Agent terminal monitoring
├── inference/    # LLM inference relay (reserved)
├── overseer/     # Mission engine, guardrails, routing
├── shared/       # Utilities (Clock abstraction)
├── spawn/        # Agent launcher (tmux)
├── store/        # SQLite data layer
└── tmux/         # tmux driver (real + fake)
tests/            # Mirrors src/ structure
web/              # Next.js frontend
docs/             # Design docs, specs, follow-ups
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
| `POST` | `/auth/login` | Login (username + password) |
| `POST` | `/auth/logout` | Revoke token |
| `GET` | `/auth/me` | Current user |
| `GET` | `/users` | List users |
| `POST` | `/users` | Create user |
| `DELETE` | `/users/:id` | Delete user |
| `GET` | `/projects` | List projects |
| `POST` | `/projects` | Create project |
| `GET` | `/projects/:id/git` | Git info for project |
| `GET` | `/tasks` | List tasks |
| `POST` | `/tasks` | Create task |
| `GET` | `/tasks/ready` | Tasks with all deps met |
| `GET` | `/tasks/deps` | All task dependencies |
| `PATCH` | `/tasks/:id` | Update task (status, title, deps, exec) |
| `DELETE` | `/tasks/:id` | Delete task |
| `GET` | `/tasks/:id/deps` | Dependencies for a task |
| `POST` | `/tasks/plan` | AI goal decomposition |
| `POST` | `/tasks/:epicId/phases` | Insert/replan phases on an epic |
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
| `DELETE` | `/missions/:id` | Disengage mission |
| `GET` | `/activity` | Activity event log |
| `GET` | `/config` | Get daemon config |
| `PUT` | `/config` | Update daemon config |
| `GET` | `/integrations/hermes/status` | Hermes plugin status |
| `POST` | `/integrations/hermes/install` | Install Hermes plugin |
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
- **Mission control** — create and monitor missions

```bash
cd web && npm install && npm run dev
```

## Docs

| Document | Contents |
|---|---|
| [CONCEPTS.md](docs/CONCEPTS.md) | Domain model — tasks, missions, autonomy, guardrails, deriver, routing |
| [API.md](docs/API.md) | Full REST API reference with request/response examples |
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | Module descriptions, data flow, guardrails, autonomy levels |
| [DEVELOPMENT.md](docs/DEVELOPMENT.md) | Setup, conventions, project structure, configuration |
| [DEPLOYMENT.md](docs/DEPLOYMENT.md) | Production deployment, systemd, Docker, reverse proxy |
| [CLI.md](docs/CLI.md) | CLI commands, autostart, environment variables |
| [WEB.md](docs/WEB.md) | Web UI pages, components, patterns, real-time updates |
| [TESTING.md](docs/TESTING.md) | Test architecture, fakes, writing tests, CI |
| [SECURITY.md](docs/SECURITY.md) | Auth model, guardrails, decision engine, infrastructure security |
| [GUIDES.md](docs/GUIDES.md) | Advanced patterns — task binding, autopilot planning, events, ANSI, calendar, toast |
| [FOLLOWUPS.md](docs/FOLLOWUPS.md) | Deferred features and known limitations |

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
