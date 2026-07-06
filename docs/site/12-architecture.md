---
title: Architecture
slug: architecture
order: 12
eyebrow: Reference
---

# Architecture

Orca is a personal AI agent you chat with — it reasons, calls tools, edits files,
runs commands, and manages tasks across the web, the CLI, and chat platforms. This
page is for when you want to look under the hood and see how that agent is built.

The design follows Orca's fourth pillar: a **lightweight app with professional-grade
code**. The whole system is a single Node.js daemon plus a separate Next.js web
process, both backed by one SQLite file. It is small enough to self-host on a modest
box, and clean enough to read end to end. The dashboards, kanban, timeline, and
terminal sessions you use every day are all just windows onto this core — ways to
**observe and steer** the agent, never a separate product.

## System overview

```
┌──────────┐     ┌──────────────┐     ┌───────────┐
│  Browser │────▶│  Web (4500)  │────▶│  Daemon   │
│  (PWA)   │     │  Next.js BFF │     │  :4400    │
└──────────┘     └──────────────┘     │  REST API │
                                      │  SSE      │
┌──────────┐     ┌──────────────┐     │  MCP      │
│  CLI     │────▶│  orca client │────▶│  WS/PTY   │
│  chat    │     │  (dist/cli)  │     └────┬──────┘
└──────────┘     └──────────────┘          │
                                     ┌─────┴──────┐
                                     │  SQLite DB │
                                     │  orca.db   │
                                     └────────────┘
```

There are two long-running processes:

- **The daemon** is the agent core. It is a single Node.js process that exposes the
  REST API, the SSE event stream, a built-in MCP server, and WebSocket/PTY terminal
  streaming — all on port **:4400**. This is where tasks are scheduled, agents are
  spawned, the brain runs, and every state change originates. See
  [Configuration](configuration) for how to point it at a different port or database.
- **The web UI** is a separate Next.js process on port **:4500**. It never talks to
  the database directly. Instead it proxies every request through a same-origin BFF
  (backend-for-frontend), so the browser only ever sees `:4500` and the daemon stays
  private. This keeps the security boundary clean and the front end lightweight.

The `orca` CLI is a thin client over the same REST API, with daemon autostart built
in — the first command you run brings the daemon up if it is not already listening.
See [Install](install) for how the two processes are wired at startup.

## Module structure

The daemon's source is organized by responsibility, one directory per concern:

```
src/
├── api/              Hono REST router + SSE event bus
├── cli/              CLI client with daemon autostart
├── daemon/           Bootstrap, DI wiring, timer loops
├── deriver/          Agent terminal polling (5s)
├── inference/        LLM inference relay
├── advisor/          Brain assistant lifecycle
├── mcp/              Built-in MCP server
├── terminal/         Real-PTY WebSocket streaming
├── integrations/     Project files, CLI detection
├── overseer/         Mission engine, routing, planner, scheduler
├── prompts/          Prompt template system
├── shared/           Utilities, clock, executor metadata
├── spawn/            Agent launcher + resume strategies
├── store/            SQLite data layer
└── tmux/             Tmux abstraction
```

A few of these deserve a note:

- **`api`** hosts the Hono REST router and the SSE event bus that every surface
  subscribes to. When the dashboard updates live, it is reading from here.
- **`overseer`** is the mission engine: it plans work, routes tasks to executors, and
  runs the scheduler. This is the machinery behind [autonomy levels L0–L3](agents-autonomy).
- **`advisor`** manages the brain — the embedded agent core you actually chat with.
- **`spawn`** and **`tmux`** launch coding-agent CLIs (Claude Code, OpenCode, Codex,
  Kilo Code) in isolated terminal sessions and resume them.
- **`store`** is the single data layer over SQLite. Everything persists through here —
  there is no second database and no parallel store.

## Timer loops

Much of the agent's autonomous behaviour is driven by periodic loops in the daemon.
Each runs on a fixed interval:

| Loop | Interval | Purpose |
|------|----------|---------|
| **Overseer tick** | 90 s | Tick active missions, spawn ready tasks |
| **Scheduler** | 30 s | Launch due scheduled/autostart tasks |
| **Janitor** | 60 s | Kill zombie tmux sessions for closed tasks |
| **Stuck detector** | 60 s | Revert tasks whose agent died without closing |
| **Deriver** | 5 s | Poll tmux panes, detect agent state |
| **Overseer watchdog** | 60 s | Re-park missing overseers + liveness sweep |
| **Decision sweep** | 30 s | Sweep panic/check decisions on paused missions |
| **Token purge** | 1 h | Delete expired auth tokens |
| **Event purge** | 1 h | Drop events past retention |
| **Ticket sweep** | 60 s | Sweep expired terminal WS tickets |
| **PR feedback** | 60 s | Poll open PRs for review feedback |
| **Embed queue** | 30 s | Process background embedding jobs |
| **Brain worker watchdog** | 60 s | Recover stalled brain chat workers |

These loops are why the agent keeps working while you are away: missions advance,
scheduled prompts fire, dead sessions get cleaned up, and stalled workers recover —
all without a human clicking anything.

## Data flow

### Task lifecycle

A task is the atomic unit of work. From creation to cleanup it flows through the
daemon like this:

```
POST /tasks → store.create() → SSE 'task' event
  → Scheduler tick (30s) → spawn agent → tmux session
  → Deriver poll (5s) → detect state → SSE 'signal'
  → Agent closes → PATCH /tasks/:id → snapshot changes → SSE 'task'
  → Janitor (60s) → kill session
```

Every arrow that emits an SSE event is something you see live in the UI — the moment a
task is created it appears on the [Kanban](web-ui) board, and its output streams into
the task detail view as the agent works.

### Deriver signal flow

The deriver is what lets the agent run coding CLIs unattended. It polls each tmux pane
every 5 seconds, reads what the agent printed, and decides what to do about any prompt
it finds:

```
Agent output → Deriver poll → detect prompt
  → autoAccept? → send keys directly
  → needs overseer? → enqueue decision
  → approved? → send accept keys
  → rejected? → SSE 'needs_input' → UI shows Allow/Reject
```

The `needs_input` branch is the human-in-the-loop gate: when the agent hits something
it is not allowed to auto-approve, it surfaces on the Escalations screen for you to
Allow or Reject. How much the deriver may auto-approve is exactly what the
[autonomy levels L0–L3](agents-autonomy) control.

## SSE event bus

Every state change in the daemon flows through one Server-Sent Events stream at
`GET /events`. This single bus is what keeps every surface — dashboard, kanban,
timeline, task detail — in sync without polling:

| Event | When | Payload |
|-------|------|---------|
| `task` | Created, status changed, deleted | task ID + new status |
| `mission` | Engaged, paused, resumed, stalled | mission ID + new state |
| `signal` | Deriver detected state change | session name + signal type |
| `plan` | Plan job status | job ID + status (planning/done/failed) |
| `review` | Review decision | task ID + verdict |

Because the web UI subscribes through the BFF proxy, this real-time feed is what
delivers the clarity pillar: you always see what the agent is doing, the instant it
does it.

## Database

All state lives in one SQLite database running in WAL mode. The schema is a single
file, `src/store/schema.sql` — there is no migration framework to learn and no second
datastore to keep in sync (the single-source-of-truth principle, applied to storage).

### Tables

| Table | Purpose |
|-------|---------|
| `projects` | Project config (slug, path, notes) |
| `tasks` | Tasks, epics, phases |
| `task_deps` | Task dependencies |
| `agents` | Agent registry |
| `missions` | Mission state |
| `settings` | Runtime config (JSON blob) |
| `users` | User accounts and roles |
| `auth_tokens` | Bearer tokens |
| `events` | Activity timeline |
| `notes` | Inter-agent handoff |
| `task_usage` | Token/cost usage |
| `user_projects` | User ↔ project assignments |
| `mission_pr` | PR workflow state |
| `user_push_subscriptions` | PWA push endpoints |

The RBAC model lives across three of these tables: `users` holds each account's role
(admin or member) plus its per-user tool and executor grants, and `user_projects`
scopes which projects a given user can see and act on. That is how one user can have
the terminal and files tools while another has only chat — a different set of tools and
permissions per person, enforced at the data layer. See
[Account & Security](account-security) for the full model.

Default path: `~/.config/orca/orca.db`. Override it with the `ORCA_DB` environment
variable — see [Configuration](configuration) for the full list of environment
settings.

[Back to start](getting-started)
