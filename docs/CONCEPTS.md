# Concepts

## Tasks

A **task** is a unit of work. Tasks form a tree via `parent_id` — an epic (root task) contains sub-tasks. Tasks can also declare dependencies (`task_deps` table) that must be closed before the task becomes ready.

### Task lifecycle

```
open → in_progress → closed
  ↓                    ↑
blocked ───────────────┘ (retry)
  ↓
cancelled
```

| Status | Meaning |
|---|---|
| `open` | Waiting to be picked up |
| `in_progress` | Assigned to an agent session |
| `blocked` | Waiting on external input or dependency |
| `closed` | Completed successfully |
| `cancelled` | Abandoned |

### Labels

Tasks carry string labels used for routing and guardrail detection:

- `exec:<program>` — route to a specific agent executor (e.g., `exec:sonnet`, `exec:opencode:ollama/deepseek-v4-flash`)
- Other labels are scanned by guardrail patterns

### Readiness

A task is **ready** when all its dependencies (`task_deps`) have status `closed` or `cancelled`. The `Readiness` service computes this at query time from the DAG.

---

## Missions

A **mission** groups tasks under an epic for autonomous execution. The mission engine (`MissionEngine`) ticks active missions, picks ready tasks, checks guardrails, and spawns agents.

### Mission lifecycle

```
engage → active ⇄ paused → disengaged
```

| State | Meaning |
|---|---|
| `active` | Engine processes this mission on each tick |
| `paused` | Skipped by the engine, sessions stay alive |
| `disengaged` | All sessions killed, mission complete |

### Mission config

| Field | Description |
|---|---|
| `epic_id` | Root task ID that owns this mission |
| `autonomy` | L0–L3 autonomy level |
| `max_sessions` | Max concurrent agent sessions |
| `cleared_guardrails` | Guardrails exempted from blocking |

### Engine tick

The tick loop (every 90 seconds):

1. Load active missions
2. For each mission:
   - Check all child tasks are closed → auto-disengage
   - Count running `orca-*` sessions
   - For each ready task belonging to this epic:
     - Run guardrail detection
     - Skip if autonomy doesn't permit or guardrails not cleared
     - Route to the correct agent executor
     - Spawn agent in tmux

---

## Autonomy levels

| Level | Name | Behavior |
|---|---|---|
| L0 | Manual | Agent pauses for confirmation on every action |
| L1 | Semi-autonomous | Agent proceeds with routine ops, pauses for risky ones |
| L2 | Autonomous | Agent operates within cleared guardrails without confirmation |
| L3 | Full autonomy | Agent operates without any oversight |

In the current implementation, L0–L1 and L2–L3 differ only in guardrail handling:

- **L0–L1**: Guardrail-triggering tasks are blocked regardless of `cleared_guardrails`
- **L2–L3**: Guardrail-triggering tasks are permitted if the guardrail is in `cleared_guardrails`

---

## Guardrails

Guardrails are safety patterns that prevent agents from performing sensitive operations without explicit clearance.

### Detection

`guardrails.ts` scans task title + labels against regex patterns:

```typescript
schema:     /\bschema\b/i
migration:  /\bmigrat/i
auth:       /\b(auth|login|password|token)\b/i
payments:   /\b(payment|billing|stripe|invoice)\b/i
destructive:/\b(delete|drop|truncate|rm -rf|destroy)\b/i
```

A task matching, for example, `/\binvoice\b/i` would trigger the `payments` guardrail.

### Clearance

Guardrails are cleared per-mission via `cleared_guardrails` — a comma-separated string in the missions table. Example: `"schema,migration"` allows schema-related tasks but blocks payments and destructive operations.

### Enforcement

```
triggered = detectGuardrails(task.title + task.labels)
permitted = autonomy >= L2 && isCleared(triggered, mission.cleared_guardrails)
```

If not permitted, the task is skipped during the engine tick. It remains `open` and can be spawned manually via the API.

---

## Authentication & authorization

The daemon supports optional token-based authentication. When a `UserStore` is configured, all endpoints except `/health` and `POST /auth/login` require a bearer token.

### Token flow

```
login (username + password) → receive token → pass as Authorization: Bearer <token>
```

Tokens are:
- Issued via `POST /auth/login` (scrypt password verification)
- Stored in the `auth_tokens` table
- Revocable via `POST /auth/logout`
- Passable as query param `?token=<value>` (for SSE EventSource which can't set headers)

### Password storage

Passwords are hashed with scrypt (random 16-byte salt, 64-byte hash). No plaintext storage.

### Users

The `users` table stores username + password hash. The `UserStore` provides:
- `verify(username, password)` — authentication
- `issueToken(userId)` — creates a session token
- `userForToken(token)` — resolves token to user
- `revokeToken(token)` — logout
- `create / list / delete` — user management

### Enforcement

The `authMiddleware` in `src/api/auth.ts` checks every request:
1. Is the path public? (health, login) → allow
2. Is there a valid token? (Authorization header or query param) → allow
3. Otherwise → 401

The middleware is only active when `d.users` is provided to the server factory.

---

## AI planning

The `POST /tasks/plan` endpoint uses an LLM to decompose a high-level goal into ordered implementation phases.

### How it works

1. **Prompt construction** — `planPrompt(goal)` builds a system prompt asking for 3–7 JSON phases
2. **LLM call** — `decompose(inf, goal)` sends the prompt via the configured autopilot inference client
3. **Parse** — `parsePhases(text)` extracts the JSON array, validates each phase has a title and valid type
4. **Task creation** — each phase becomes a `task` child of an `epic` task, chained sequentially via `task_deps`
5. **Optional engage** — if `engage: true`, creates and starts a mission immediately

### Phase types

| Type | Purpose |
|---|---|
| `task` | General implementation work |
| `feature` | New feature addition |
| `bug` | Bug fix |
| `chore` | Maintenance, refactoring, tooling |

### Requirements

- Autopilot API key must be configured in daemon settings
- LLM must return valid JSON (no markdown fences, no prose)
- On parse failure, returns 502 with `"plan_parse_failed"`

---

## Activity log / event store

All state changes are recorded in SQLite `events` table (`src/store/eventStore.ts`):

| Event type | Example |
|---|---|
| `task` | Task created, status changed, deleted |
| `mission` | Mission engaged, paused, resumed, disengaged |
| `signal` | Deriver detected working/needs_input/complete |

### EventStore API

```typescript
class EventStore {
  record(event: { type: string; target: string; detail: string }): void
  list(opts?: { limit?: number; type?: string }): ActivityEvent[]
  deleteForTarget(target: string): void
}
```

The log is queryable via `GET /activity` with optional `type` and `limit` filters. Used by the Timeline page in the web UI. Events are grouped in the UI: identical events within 5 minutes collapse into `×N` to prevent flood from repeated deriver signals.

---

## Inference client

The inference layer (`src/inference/types.ts`) defines a minimal interface for LLM backends:

```typescript
interface InferenceClient {
  decide(prompt: string): Promise<{ text: string }>;
}

interface RelayConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}
```

### Implementations

| Implementation | File | Purpose |
|---|---|---|
| `RelayClient` | `src/inference/client.ts` | Production — relays to MIMO/OpenAI-compatible API |
| `FakeInference` | `src/inference/client.ts` | Tests — returns predictable responses |

### Consumers

- **Planner** (`src/overseer/planner.ts`): goal decomposition for `POST /tasks/plan`
- **Decision engine** (`src/overseer/decision.ts`): agent prompt approval

### Adding a custom backend

Implement the `InferenceClient` interface and inject via the `makeInference` factory in server options.

---

## Agent routing

Tasks specify which AI agent should execute them via the `exec:<program>` label.

### Executor resolution

`resolveExecutor()` in `src/overseer/routing.ts`:

- `exec:sonnet` → `{ program: 'claude-code', model: 'sonnet' }`
- `exec:opencode:model` → `{ program: 'opencode', model: 'model' }`
- `exec:codex:model` → `{ program: 'codex', model: 'model' }`
- `exec:ollama/deepseek-v4-flash` → `{ program: 'opencode', model: 'ollama/deepseek-v4-flash' }`
- No label → uses the configured fallback (default: `claude-code` / `sonnet`)

### Agent commands

| Program | Command pattern |
|---|---|---|
| `claude-code` | `cd <project> && claude --model <model> '<prompt>'` |
| `opencode` | `cd <project> && opencode run --model <model> '<prompt>'` |
| `codex` | `cd <project> && codex --dangerously-bypass-approvals-and-sandbox --model <model> '<prompt>'` |

The prompt instructs the agent to close the task with `orca close <taskId>` when done. The agent receives the orca CLI path, daemon URL, and a service token via environment variables so it can reach back to the daemon.

### Allowed executors

The daemon configuration (`allowedExecs`) controls which executors are permitted via the API. Unknown executors return 400. The CLI and web UI enforce this on the daemon side.

---

## Deriver

The **deriver** monitors agent sessions in real time. It polls tmux every 5 seconds and detects agent state by examining the pane output.

### Poll loop

```
tick():
  for each orca-* session:
    get program type (claude/opencode/codex)
    get associated task
    if task closed → emit 'complete'
    capture pane (last 60 lines)
    run detectAgentPrompt(program, output)
    if auto-approvable prompt → send keys + emit 'working'
    if needs input → emit 'needs_input' with question/options
    else → emit 'working'
```

### Detected states

| Signal | Meaning |
|---|---|
| `working` | Agent is progressing normally |
| `needs_input` | Agent is waiting for user input (prompt detected) |
| `complete` | Task is closed |

### Prompt detection

Currently implemented for **OpenCode** permission prompts:

- Detects "Permission required" title + accept/reject options
- For known patterns: auto-sends `[Enter]` to approve (auto-approve)
- For unknown patterns: emits `needs_input` for manual handling

### Deduplication

Each detected prompt is hashed (question + context) to avoid re-emitting the same signal on consecutive polls. The hash is stored per-session in a `last` map.

---

## Event bus

The `EventBus` decouples services and provides real-time updates to the web UI:

| Event | Trigger | Payload |
|---|---|---|
| `task` | Status change | `{ taskId, status }` |
| `mission` | State change | `{ missionId, state }` |
| `signal` | Deriver output | `{ session, signal }` |

The event bus:
- Serves SSE streams at `GET /events`
- Invalidates React Query caches in the web UI
- Is implemented as an in-memory pub/sub (`Set<() => void>`)

---

## tmux sessions

Each agent runs in an isolated tmux session named `orca-<agentName>`.

### Agent naming

Names are generated by `uniqueName.ts` from a curated set:
```
Nova, Atlas, Iris, Felix, Juno, Orion, Luna, Cyrus,
Vera, Milo, Nora, Hugo, Ada, Leo, Mira, Theo,
Ivy, Kai, Zara, Otis, Lena, Cleo, Remy, Soren
```

The counter cycles through the list; after exhausting all names it wraps with a numeric suffix: `Nova2`, `Atlas2`, ...

### tmux driver

The `RealTmuxDriver` wraps common tmux operations:

| Method | tmux command |
|---|---|
| `spawn` | `tmux new-session -d -s <name> -c <cwd>` + `send-keys <command> Enter` |
| `sendKeys` | `tmux send-keys -t <name> <keys>` |
| `capturePane` | `tmux capture-pane -p -t <name> -S -<N>` |
| `capturePaneAnsi` | `tmux capture-pane -e -p -t <name> -S -<N>` (includes ANSI escapes) |
| `list` | `tmux list-sessions -F '#{session_name}'` |
| `kill` | `tmux kill-session -t <name>` |

An `FakeTmuxDriver` implementation exists for tests with in-memory session simulation.
