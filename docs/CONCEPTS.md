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

A task that matches, for example, `/\bpayout\b/i` would trigger the `payments` guardrail.

### Clearance

Guardrails are cleared per-mission via `cleared_guardrails` — a comma-separated string in the missions table. Example: `"schema,migration"` allows schema-related tasks but blocks payments and destructive operations.

### Enforcement

```
triggered = detectGuardrails(task.title + task.labels)
permitted = autonomy >= L2 && isCleared(triggered, mission.cleared_guardrails)
```

If not permitted, the task is skipped during the engine tick. It remains `open` and can be spawned manually via the API.

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
|---|---|
| `claude-code` | `cd <project> && claude --model <model> '<prompt>'` |
| `opencode` | `cd <project> && opencode --model <model> --prompt '<prompt>'` |
| `codex` | `cd <project> && codex --dangerously-bypass-approvals-and-sandbox --model <model> '<prompt>'` |

The prompt instructs the agent to close the task with `jt close <taskId>` when done.

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

Names are generated by `uniqueName.ts`:
```
<adjective><noun><counter>
SwiftLake0, CalmRidge1, BrightGrove2, ...
```

Adjectives: `[Swift, Calm, Bright, Bold, Keen, Wise, Far, Deep]`
Nouns: `[Lake, Ridge, Grove, Coast, Peak, Vale, Cove, Mesa]`

This produces 64 unique combinations before the counter wraps — enough for concurrent sessions.

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
