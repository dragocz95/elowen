# Architecture

## Overview

Orca is an AI agent orchestrator. It manages a queue of tasks, spawns AI coding agents (Claude Code, OpenCode, Codex) in isolated tmux sessions, monitors their progress, and enforces safety guardrails.

## Core loop

```
boot → bootstrap DI → start HTTP server → start deriver → start mission engine tick loop
```

The mission engine ticks every 90 seconds:

1. Load active missions
2. For each mission: check if `running_sessions < max_sessions`
3. Query ready tasks (all deps fulfilled) for the mission's epic
4. Run guardrail checks on task title/labels
5. Route task to the appropriate agent program (`exec:<program>` label)
6. Spawn agent in a new tmux session
7. Deriver monitors sessions every 5 seconds, detecting states: `working`, `needs_input`, `complete`

## Modules

### `src/daemon/` — Entry point

- `index.ts` — starts HTTP server on port 4400
- `bootstrap.ts` — DI container: opens DB, instantiates all services, wires them together

### `src/api/` — REST API (Hono)

- `server.ts` — route definitions
- `sse.ts` — `EventBus` for real-time SSE notifications (terminal output, task state changes)

### `src/overseer/` — Orchestration logic

- `missionEngine.ts` — tick loop, session counting, task-to-agent dispatch
- `guardrails.ts` — regex-based detection of sensitive operations
- `routing.ts` — maps task labels to agent programs (claude-code, opencode, codex)
- `scheduler.ts` — launches due scheduled tasks (30s poll)
- `janitor.ts` — sweeps zombie sessions whose task is closed
- `decision.ts` — LLM-based prompt approval overseer
- `planner.ts` — AI goal decomposition for `POST /tasks/plan`

### `src/spawn/` — Agent spawning

- `spawn.ts` — `SpawnService` creates tmux sessions with agent commands
- `commandBuilder.ts` — builds the CLI command per agent type

### `src/deriver/` — Agent monitoring

- `deriver.ts` — polls tmux panes every 5s, interprets output to detect agent state (working, blocked, complete, needs_input), emits events

### `src/tmux/` — tmux abstraction

- `types.ts` — `TmuxDriver` interface
- `driver.ts` — `RealTmuxDriver` wrapping tmux CLI commands
- Fake implementation available for testing

### `src/store/` — Data layer

SQLite with WAL mode. Tables:

| Table | Purpose |
|---|---|---|
| `projects` | Registered projects |
| `tasks` | Task queue (tree structure via `parent_id`) |
| `task_deps` | Task dependencies (DAG) |
| `agents` | Agent session registry |
| `missions` | Mission definitions, autonomy level, guardrail config |
| `settings` | Daemon configuration (JSON blob) |
| `users` | User accounts (scrypt password hashes) |
| `auth_tokens` | Session tokens for bearer auth |
| `events` | Activity event log (state changes, signals) |

### `src/inference/` — LLM relay

- `client.ts` — `RelayClient` for OpenAI-compatible APIs, `FakeInference` for tests
- Used by the planner (`POST /tasks/plan`) and the deriver's overseer decision hook

### `src/git/` — Git integration

- `gitReader.ts` — reads git status, branches, and recent commits for project paths

### `src/cli/` — CLI client

Commands: `orca ls`, `orca ready`, `orca sessions`, `orca close`. Auto-detects and starts the daemon if not running.

### `src/shared/` — Utilities

- `clock.ts` — `Clock` interface with `SystemClock` (real) and `FakeClock` (test) implementations

## Guardrails

Tasks are blocked if their title or labels match sensitive patterns:

| Guardrail | Matched patterns |
|---|---|
| `schema` | `schema`, `migration`, `alter table`, `ddl`, ... |
| `auth` | `auth`, `login`, `password`, `oauth`, `session`, ... |
| `payments` | `payment`, `billing`, `charge`, `refund`, `invoice`, ... |
| `destructive` | `rm -rf`, `drop table`, `truncate`, `delete from`, `format`, ... |

Cleared per-mission via `cleared_guardrails` (comma-separated string).

## Autonomy levels

| Level | Behavior |
|---|---|
| L0 | Fully manual — agent waits for user confirmation on every action |
| L1 | Semi-autonomous — agent can proceed with routine operations |
| L2 | Autonomous — agent decides within cleared guardrails |
| L3 | Full autonomy — agent operates without oversight |

## Data flow

```
                                   ┌───────────┐
                                   │   Client   │
                                   │ (CLI/Web)  │
                                   └─────┬─────┘
                                         │ HTTP/SSE
                                         ▼
                              ┌──────────────────┐
                              │   Hono Server    │
                              │   port 4400      │
                              └──────┬───────────┘
                                     │
              ┌──────────────────────┼──────────────────────┐
              ▼                      ▼                      ▼
      ┌──────────────┐     ┌──────────────┐     ┌──────────────┐
      │  TaskStore   │     │ MissionEngine│     │   EventBus   │
      │  (CRUD)      │     │  (tick loop) │     │  (SSE push)  │
      └──────┬───────┘     └──────┬───────┘     └──────────────┘
             │                    │
             │           ┌────────▼────────┐
             │           │   Guardrails    │
             │           │   + Routing     │
             │           └────────┬────────┘
             │                    │
             │           ┌────────▼────────┐
             │           │  SpawnService   │
             │           │  (tmux launch)  │
             │           └────────┬────────┘
             │                    │
             │           ┌────────▼────────┐
             │           │    Deriver      │
             │           │  (5s poll loop) │
             │           └────────┬────────┘
             │                    │
             ▼                    ▼
      ┌─────────────────────────────────────┐
      │           SQLite (WAL)              │
      │  tasks / missions / agents          │
      └─────────────────────────────────────┘
```

## Testing

Tests use Vitest with fake implementations:

- `FakeTmuxDriver` — in-memory session simulation
- `FakeClock` — deterministic time control
- `FakeInference` — predictable LLM responses

This allows full integration-style tests without real tmux or network dependencies.
