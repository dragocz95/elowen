---
title: Architecture
slug: architecture
order: 12
eyebrow: Reference
---

# Architecture

Orca is a self-hosted AI agent orchestration daemon. It manages tasks, spawns
agents in isolated tmux sessions, runs a brain for chat and automation, and
exposes a REST API with a real-time web UI.

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

The daemon is a single Node.js process. The web UI is a separate Next.js
process that talks to the daemon through a same-origin BFF proxy.

## Module structure

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
├── integrations/     Hermes, project files, CLI detection
├── overseer/         Mission engine, routing, planner, scheduler
├── prompts/          Prompt template system
├── shared/           Utilities, clock, executor metadata
├── spawn/            Agent launcher + resume strategies
├── store/            SQLite data layer
└── tmux/             Tmux abstraction
```

## Timer loops

Much of the daemon runs on periodic intervals:

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
| **Event purge** | 1 h | Drop events past 30-day retention |
| **Ticket sweep** | 60 s | Sweep expired terminal WS tickets |
| **PR feedback** | 60 s | Poll open PRs for review feedback |
| **Embed queue** | 30 s | Process background embedding jobs |
| **Brain worker watchdog** | 60 s | Recover stalled brain chat workers |

## Data flow

### Task lifecycle (data flow)

```
POST /tasks → store.create() → SSE 'task' event
  → Scheduler tick (30s) → spawn agent → tmux session
  → Deriver poll (5s) → detect state → SSE 'signal'
  → Agent closes → PATCH /tasks/:id → snapshot changes → SSE 'task'
  → Janitor (60s) → kill session
```

### Deriver signal flow

```
Agent output → Deriver poll → detect prompt
  → autoAccept? → send keys directly
  → needs overseer? → enqueue decision
  → approved? → send accept keys
  → rejected? → SSE 'needs_input' → UI shows Allow/Reject
```

### SSE event bus

All state changes flow through the SSE event bus at `GET /events`:

| Event | When | Payload |
|-------|------|---------|
| `task` | Created, status changed, deleted | task ID + new status |
| `mission` | Engaged, paused, resumed, stalled | mission ID + new state |
| `signal` | Deriver detected state change | session name + signal type |
| `plan` | Plan job status | job ID + status (planning/done/failed) |
| `review` | Review decision | task ID + verdict |

## Database

SQLite with WAL mode. Schema in `src/store/schema.sql`.

### Tables

| Table | Purpose |
|-------|---------|
| `projects` | Project config (slug, path, notes) |
| `tasks` | Tasks, epics, phases |
| `task_deps` | Task dependencies |
| `agents` | Agent registry |
| `missions` | Mission state |
| `settings` | Runtime config (JSON blob) |
| `users` | User accounts |
| `auth_tokens` | Bearer tokens |
| `events` | Activity timeline |
| `notes` | Inter-agent handoff |
| `task_usage` | Token/cost usage |
| `user_projects` | User ↔ project assignments |
| `mission_pr` | PR workflow state |
| `user_push_subscriptions` | PWA push endpoints |

Default path: `~/.config/orca/orca.db`. Configure with `ORCA_DB`.

[Back to start](getting-started)
