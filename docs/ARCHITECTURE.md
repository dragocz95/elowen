# Architecture

## Overview

Orca is a self-hosted AI agent orchestration daemon. It manages a queue of tasks, spawns AI coding agents (Claude Code, OpenCode, Codex) in isolated tmux sessions, and monitors their progress. A **Next.js dashboard** (`web/`) drives everything over the HTTP API. Daemon code is plain TypeScript (Hono + `better-sqlite3`), no framework magic.

## Core runtime

```
bootstrap → open DB → instantiate stores/services → create Hono server → startup reconcile → start loops
```

The daemon starts a set of independent timer loops:

| Loop | Interval | Purpose |
|---|---|---|
| Overseer (engine tick) | 90 s | Tick active missions: pick ready tasks, spawn agents |
| Scheduler | 30 s | Launch due scheduled/autostart tasks |
| Janitor | 60 s | Kill zombie tmux sessions whose task is already closed/cancelled |
| Stuck detector | 60 s | Revert tasks whose agent died without `orca close` (bounded), escalate after 2 relaunch attempts |
| Deriver | 5 s | Poll tmux panes, detect agent state (working, needs_input, complete), auto-approve known prompts |
| Overseer watchdog | 60 s | Re-park missing overseer agents for active/stalled missions (crash recovery) |
| Token purge | 1 h | Delete expired auth tokens (TTL from `config.security.tokenTtlDays`) |
| Event purge | 1 h | Drop `events` rows past the 30-day retention window (`eventStore.purgeOlderThan()`) |
| Ticket sweep | 60 s | Sweep expired terminal-WS single-use tickets |
| PR feedback | 60 s | Poll open PRs for fresh actionable review feedback, re-engage mission with fix phases |

Token purge and Event purge also run once on startup, then every hour.

### Startup reconcile

On boot the daemon runs two one-shot recovery passes before the loops start:

1. **Zombie reconcile** — tasks left `in_progress` whose tmux session is gone are reverted to `open` so they can be picked up again. No grace or relaunch counter: a restart isn't an agent death, so it shouldn't spend the budget.

2. **Overseer reconcile** — when an agent overseer is configured, re-park one per active mission (their tmux sessions died with the daemon) and kill orphan overseer sessions whose mission is no longer active.

### VAPID keypair generation

On every boot, `ensureVapidKeys(config)` in `bootstrap.ts` checks for an existing web-push VAPID keypair in the config store. If none exists (first boot), it generates one via `webpush.generateVAPIDKeys()` and persists the public + private keys. The public key is exposed at `GET /push/vapid-public-key` for browser subscription; the private key stays in the config store, never served via the API.

### Event-bus subscribers (push + usage)

Two `EventBus` subscribers are wired at boot:

- **PushDispatcher** (`src/push/pushDispatcher.ts`) — maps lifecycle events (review escalation, `needs_input` signal, stall, completion, blocked task) to web-push notifications for the mission's owner + admins.
- **UsageRecorder** (`src/integrations/usage/recorder.ts`) — snapshots each task's token/cost usage into `task_usage` the moment it settles (closed/cancelled), so the stats page reads DB aggregates instead of re-scanning CLI session stores.

## Request / spawn flow

```
HTTP request
  → api/server.ts (route handler, auth via Bearer token)
  → overseer/missionEngine.ts (mission tick: pick ready tasks)  OR  overseer/scheduler.ts (scheduled/autostart)
  → spawn/spawn.ts  SpawnService.launch()
  → spawn/commandBuilder.ts  buildAgentCommand()  (cd + env + cli + prompt)
  → tmux/driver.ts  spawn()  →  tmux new-session  (session = orca-<agentName>)
```

The agent works in the tmux pane, then calls `node <cli> close <taskId> …` back to the daemon (`PATCH`/close path) to mark its task done.

## Modules

### `src/daemon/` — Entry point

- `index.ts` — starts HTTP server on port 4400
- `bootstrap.ts` — DI container: opens DB, instantiates all services, wires them together, starts timer loops
- `uniqueName.ts` — generates agent session names from a curated list (Nova, Atlas, Iris, …), cycles with numeric suffix on wrap

### `src/api/` — REST API (Hono)

- `server.ts` — route definitions (1,598 lines, 91 routes in one file): tasks, missions, sessions, projects, users, auth, config, integrations, file editor, git surface, planner, plan jobs, overseer decision routes, web push subscriptions, usage stats, system info
- `sse.ts` — `EventBus` for real-time SSE notifications (terminal output, task state changes, plan job status)
- `auth.ts` — Bearer token middleware, also accepts `?token=` query param for SSE. `/ws/terminal` is public here — the terminal-WS ticket is its capability

### `src/terminal/` — Real-PTY terminal streaming

Streams a true PTY (a `tmux attach` via `node-pty`) over a WebSocket to the browser's xterm, for the assistant dock, the enlarged-modal terminals, and the pop-out terminal window (grid previews stay on the snapshot mirror). The WS reaches the daemon directly (nginx `/ws/` → :4400), so it carries no session cookie — a short-lived single-use ticket is the capability.

- `ticketStore.ts` — in-memory single-use tickets (issue/consume/TTL sweep)
- `ptyLoader.ts` — lazy, cached `import('node-pty')` with availability detection; null → snapshot fallback (`node-pty` is an **optional dependency**)
- `ptySession.ts` — `tmux attach -t <session>` PTY client (fully interactive — the ownership gate is enforced at ticket-mint time)
- `bridge.ts` — pure full-duplex PTY↔WS logic (PTY out → ws.send; ws messages → input bytes / `{type:'resize'}` control frame)
- `wsHandler.ts` — `@hono/node-ws` upgrade handler: consume ticket → load pty → attach → bridge → kill on close. Closes with code `4001` when unsupported
- On a client resize, the daemon resizes both the PTY **and** the tmux *window* (`tmux resize-window`) — the advisor session is created `window-size manual`, so the PTY size alone would be ignored and the content wouldn't reflow to fill the panel

The ticket is minted by the authenticated `POST /sessions/:name/ws-ticket` (ownership-gated by the same session access check) and shared with the daemon's `/ws/terminal` handler via the `ticketStore`. node-ws injects into the same http server (`injectWebSocket` after `serve()` in `daemon/index.ts`).

### `src/advisor/` — Per-user Assistant lifecycle

The assistant is a persistent, per-user agent session (`orca-advisor-<userId>`) that drives Orca on the user's behalf with a full-scope token. The module is opt-in: when the daemon's DB is `:memory:` (tests), `AdvisorService` is not instantiated and the `/advisor/*` routes degrade gracefully.

- `service.ts` — `AdvisorService`: start/stop/status/ensureOnLogin. Resolves executor, mints the advisor token (`ensureAdvisorToken`), writes the per-program MCP config, and spawns via `SpawnService` with the user's own token overriding the daemon's agent service token
- `mcpConfig.ts` — writes a per-program MCP config into the advisor's cwd so the spawned CLI auto-connects to Orca's MCP server: claude reads `.mcp.json`, opencode reads `opencode.json`, codex reads `.codex-mcp.toml`. Config files are locked to the daemon user (0600)

### `src/mcp/` — Built-in MCP server

A stateless MCP server (`/mcp` endpoint) exposing Orca's toolset to the assistant (and any other MCP-capable client). Built on `@modelcontextprotocol/sdk`.

- `server.ts` — `handleMcpRequest(req, deps)`: a fresh `McpServer` + `WebStandardStreamableHTTPServerTransport` per request, bound to the request's bearer token, so each connection acts with exactly its user's rights
- `tools.ts` — `makeOrcaTools(d)`: `orca_request` (generic escape hatch — any REST endpoint), plus typed helpers `orca_tasks`, `orca_create_task`, `orca_plan`, `orca_sessions`. All delegate to the shared `callOrcaApi` core, so a new REST endpoint works with zero edits here

### `src/overseer/` — Orchestration logic

- `missionEngine.ts` — tick loop, session counting, task-to-agent dispatch, engage/pause/resume/disengage, stalled detection

- `routing.ts` — maps `exec:<spec>` labels to agent programs (claude-code, opencode, codex) via `resolveExecutor()`; imports executor metadata from `shared/execs.ts`
- `scheduler.ts` — launches due scheduled tasks across all projects (30s poll); uses `Date.parse()` epoch comparison
- `janitor.ts` — sweeps zombie sessions whose task is closed/cancelled (60s)
- `stuckDetector.ts` — reverts tasks whose agent died without closing, bounded relaunch (`stuck:<n>` label), escalates to blocked after maxRelaunch (60s)
- `decision.ts` — LLM-based prompt and task approval overseer; centralized `gateVerdict()` applies `MIN_CONFIDENCE` threshold; broadened DESTRUCTIVE regex (curl/wget pipes, python/node/perl -e, netcat, eval, os.system, subprocess)
- `decisionQueue.ts` — per-mission FIFO: engine/deriver enqueue decisions, parked overseer polls and resolves; timeout escalates conservatively
- `overseerAgent.ts` — lifecycle of the parked per-mission overseer agent (long-poll loop)
- `pilotAgent.ts` — spawns the planning agent for agent-mode plan jobs (reads repo, submits plan via `orca plan submit`)
- `planner.ts` — AI goal decomposition for `POST /tasks/plan` (relay backend); prompt from `prompts/planner.md`
- `planJob.ts` — async planning job registry (shared state between relay and agent backends)
- `llmParse.ts` — `extractJson()` shared helper for robust LLM JSON output extraction (used by planner + decision)
- `sessionInfo.ts` — `classifySession()` maps every `orca-*` session to structured `SessionInfo` (role + agent name + optional missionId)

### `src/spawn/` — Agent spawning

- `spawn.ts` — `SpawnService` creates tmux sessions with agent commands; nudges Enter at 4s/8s/13s for OpenCode TUI
- `commandBuilder.ts` — builds the shell command per agent type (claude-code, opencode TUI, codex)

### `src/deriver/` — Agent monitoring

- `deriver.ts` — polls tmux panes every 5s, interprets output with `shellPatterns.ts`, detects agent state (working, needs_input, complete), auto-approves known prompts for L1–L3 missions (L1 uses a stricter confidence threshold of 0.85 vs 0.6 for L2/L3)
- `shellPatterns.ts` — regex patterns for detecting permission prompts per program
- `types.ts` — `DerivedSignal` type definitions

### `src/tmux/` — tmux abstraction

- `types.ts` — `TmuxDriver` interface
- `driver.ts` — `RealTmuxDriver` wrapping tmux CLI commands (spawn, sendKeys, capturePane, capturePaneAnsi, list, kill, resize)
- `fakeDriver.ts` — `FakeTmuxDriver` for tests (in-memory session simulation)

### `src/store/` — Data layer

SQLite with WAL mode (`better-sqlite3`). Tables:

| Table | Purpose |
|---|---|
| `projects` | Registered projects |
| `tasks` | Task queue (tree structure via `parent_id`) |
| `task_deps` | Task dependencies (DAG) |
| `agents` | Agent session registry (per-project unique names) |
| `missions` | Mission definitions, autonomy level |
| `settings` | Daemon configuration (JSON blob) |
| `users` | User accounts (scrypt password hashes, admin flag, per-user exec allow-list, advisor exec + autostart flag) |
| `auth_tokens` | Session tokens for bearer auth (scope: full / agent / advisor) |
| `events` | Activity event log (state changes, signals) |
| `task_usage` | Persisted per-task token/cost snapshots (written once when a task settles, so the stats page never re-scans CLI session stores) |
| `user_push_subscriptions` | Per-user web-push device subscriptions (endpoint + VAPID keys) |
| `mission_pr` | PR-native workflow state (branch, worktree, PR number, review feedback, fix rounds) |
| `user_projects` | User ↔ project assignments (RBAC many-to-many) |

Store modules: `db.ts`, `taskStore.ts`, `missionStore.ts`, `agentStore.ts`, `eventStore.ts`, `configStore.ts`, `userStore.ts`, `projectStore.ts`, `userProjectStore.ts`, `readiness.ts`, `missionDetail.ts`, `schema.sql`, `types.ts`.

### `src/inference/` — LLM relay

- `client.ts` — `RelayClient` for OpenAI-compatible APIs, `FakeInference` for tests
- `types.ts` — `InferenceClient` interface and `RelayConfig`

### `src/git/` — Git integration

- `gitReader.ts` — reads git status, branches, and recent commits for project paths

### `src/integrations/` — External integrations

- `hermesInstall.ts` — registers orca as an MCP server in a same-host Hermes instance
- `projectFiles.ts` — safe file tree, read, write, and diff operations for the Monaco editor
- `cliDetection.ts` — detects installed agent CLIs (claude, opencode, codex) for the onboarding wizard
- `usage/` — reads token/cost usage from each executor CLI's local session storage (portable, no relay)

### `src/cli/` — CLI client

Commands: `orca ls`, `orca ready`, `orca sessions`, `orca close`, `orca plan submit`, `orca overseer poll`, `orca overseer decide`, plus the generic `orca api <METHOD> <path> [jsonBody]` REST passthrough. Lifecycle commands (`orca up`, `down`, `status`, `update`, `install`) manage the daemon itself. Auto-detects and starts the daemon if not running (except lifecycle commands).

### `src/shared/` — Utilities

- `clock.ts` — `Clock` interface with `SystemClock` (real) and `FakeClock` (test) implementations
- `execs.ts` — single source of truth for executor metadata: `PROGRAM_PREFIXES`, `KNOWN_EXECS`, `DEFAULT_BINS`, `isWellFormedExec`, `isAllowedExec` (formerly duplicated across `routing.ts` and `configStore.ts`)
- `apiClient.ts` — `callOrcaApi(method, path, body, opts)`: the single HTTP-forward core for reaching the Orca REST API with a bearer token. Shared by the `orca api` CLI verb and every MCP tool, so there is no duplicated request logic and a new REST endpoint works in both with zero edits

### `src/push/` — Web push notifications

Phone push notifications deliver mission events (review escalation, `needs_input`, stall, completion) to subscribed devices via the Web Push API (VAPID). The module is wired as an `EventBus` subscriber in `bootstrap.ts`.

- `vapid.ts` — `ensureVapidKeys(config)`: generates a VAPID keypair on first boot via `web-push.generateVAPIDKeys()`; persists it in the config store and reuses it across restarts (rotation would invalidate every stored push subscription). The private key never leaves the daemon.
- `pushSender.ts` — `PushSender`: delivers web-push payloads to a set of users' devices via `web-push`. Prunes dead endpoints (404/410) so they aren't retried forever.
- `pushDispatcher.ts` — `PushDispatcher`: the single `EventBus` subscriber that maps Orca lifecycle events to push payloads. Handles `review` (escalation), `signal`/`needs_input` (agent waiting), `mission`/`stalled`, `mission`/`disengaged` (completion), and `task`/`blocked`. Resolves recipients for the owning mission via `recipientsForMission()`.
- `recipients.ts` — `recipientsForMission()`: resolves the mission's owner (`created_by` column) plus all admins. Deduped; a mission with no owner falls back to admins only.
- `messages.ts` — notification payload builders with Czech user-facing text and inline action buttons (Approve/Reject, Allow/Reject, Open).

### `src/prompts/` — Prompt template system

- `index.ts` — `render(name, vars)` loads `.md` templates and substitutes `{{placeholder}}` variables; `rawTemplate()` for the editable planner default; templates cache until `_resetPromptCache()`

Templates live in the repo-root `prompts/` directory (copied to `dist/prompts/` during build):
`planner.md`, `planner-fallback.md`, `pilot.md`, `overseer.md`, `worker.md`, `worker-phase.md`, `worker-epic-close.md`, `decision-header.md`, `decision-prompt.md`

## Autonomy levels

| Level | Name | Auto-spawn | Prompt gate | Confidence bar |
|---|---|---|---|---|
| L0 | Recommend | Never | Always escalate to human | — |
| L1 | Assist | Yes | Overseer gate (stricter) | 0.85 |
| L2 | Pilot | Yes | Overseer gate (standard) | 0.6 |
| L3 | Auto | Yes | Overseer gate (standard) | 0.6 |

L1 differs from L2 not in whether prompts are gated (both route through the overseer), but in the **confidence threshold**: L1 requires 0.85 confidence to auto-clear a prompt, L2/L3 use 0.6. L3 additionally waves non-destructive prompts through when no overseer is configured at all.

## Autopilot modes

`POST /tasks/plan` supports two backends:

1. **Relay backend** (default) — the planner LLM (`config.autopilot.model`) decomposes the goal via `RelayClient`. Requires an API key.

2. **Agent backend** — when `config.autopilot.pilotExec` is set, spawns a **Pilot** agent in the repo. The Pilot reads the codebase and submits its plan via `orca plan submit`. No API key needed for planning (the agent brings its own model).

A **parked Overseer agent** (`config.autopilot.overseerExec`) can replace the relay-based decision backend: one long-polling agent per active mission answers task/prompt/review decisions through the `decisionQueue`.

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
              ┌───────────────────────┼───────────────────────┐
              ▼                       ▼                       ▼
      ┌──────────────┐      ┌──────────────────┐     ┌──────────────┐
      │  TaskStore   │      │  MissionEngine   │     │   EventBus   │
      │  (CRUD)      │      │  (90s tick)      │     │  (SSE push)  │
      └──────┬───────┘      └──────┬───────────┘     └──────────────┘
             │                     │
              │            ┌────────▼────────┐
              │            │    Routing      │
              │            │ (resolveExecutor)│
              │            └────────┬────────┘
             │                     │
             │            ┌────────▼────────┐
             │            │  SpawnService   │
             │            │  (tmux launch)  │
             │            └────────┬────────┘
             │                     │
             │            ┌────────▼────────┐
             │            │    Deriver      │
             │            │  (5s poll loop) │
             │            └────────┬────────┘
             │                     │
             ▼                     ▼
      ┌──────────────────────────────────────┐
      │           SQLite (WAL)               │
      │  tasks / missions / agents / users   │
      └──────────────────────────────────────┘
```

Additional parallel loops (not pictured in the diagram above, see the timer loop table at the top):
- **Deriver** (5s) — polls tmux panes, detects worker/overseer/pilot state
- **Scheduler** (30s) — reads tasks directly from TaskStore, spawns due scheduled/autostart tasks
- **Janitor** (60s) — reaps zombie tmux sessions whose task is already closed/cancelled
- **Stuck detector** (60s) — reverts tasks whose agent died without `orca close` (bounded relaunch, escalates to `blocked`)
- **Overseer watchdog** (60s) — re-parks missing overseer agents for active/stalled missions (crash recovery)
- **Token purge** (1h) — deletes expired auth tokens
- **Event purge** (1h) — drops `events` rows past the 30-day retention window

## Access control / multi-tenancy

Three token scopes govern what an API caller may do:

| Scope | Purpose |
|---|---|
| `full` | Interactive user session (login via web/CLI). Bounded by the user's role and project assignments. |
| `agent` | Spawned agent (worker, overseer, pilot). Restricted to a narrow allow-list of verbs: `PATCH /tasks/:id` (close), `POST /plan/:jobId/submit`, `GET /plan/:jobId`, `GET /tasks`, `GET /tasks/ready`, `GET /sessions`, `GET /missions/:id/overseer/next`, `POST /missions/:id/overseer/decide`. Confined to its live working set via `agentProjects()` — never the admin bypass. |
| `advisor` | Per-user assistant session (`orca-advisor-<userId>`). Mapped to `full` at the guard so it has the user's own rights, but isolated from login tokens so rotating/stopping the advisor never touches `full` tokens. |

With a `userProjects` store present (multi-user mode):

- A global middleware rejects non-admins not assigned to the daemon's project on the tasks/missions/sessions/activity/events/usage surface (403).
- Per-route `canAccessProject` / `accessibleProjects` / `resolveTarget` / `missionAccessible` filter list endpoints and gate item operations + project file/git endpoints.
- Per-user model allow-list (`allowed_execs`) restricts which exec a non-admin may use.
- Admins and open/single-user mode (no `userProjects`) pass everything unrestricted.
- The agent scope's `agentProjects()` helper confines access to projects with live `agent:`-labelled tasks or active missions. Overseers keep access to the project of every active mission's epic. Final-phase agents retain access until their epic actually closes.

## Testing

Tests use Vitest with fake implementations:

- `FakeTmuxDriver` — in-memory session simulation
- `FakeClock` — deterministic time control
- `FakeInference` — predictable LLM responses

This allows full integration-style tests without real tmux or network dependencies.

Daemon tests: ~823 `it`/`test` cases across 108 test files in `tests/`. Web tests: ~433 cases in `web/tests/` (Vitest + React Testing Library).
