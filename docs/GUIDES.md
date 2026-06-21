# Guides

Collection of advanced architecture patterns, internal mechanisms, and integration knowledge.

---

## Task ↔ session binding

Tasks don't store a direct reference to their tmux session. The binding is inferred from task labels via the `agent:<name>` convention.

### How it works

1. Task gets an `agent:<name>` label when spawned (e.g., `agent:SwiftLake0`)
2. The tmux session is named `orca-<name>` (e.g., `orca-SwiftLake0`)
3. To find a task's session: extract `agent:<name>` from labels → prepend `orca-`
4. To find a session's task: strip `orca-` prefix → look up agent name in `agents` table → find associated task

Labels are set by `taskStore.setAgent(taskId, agentName)` in `src/store/taskStore.ts` — both the mission engine and the scheduler call it before marking the task `in_progress`, so the binding is always in place before the session exists.

### Session lifecycle

```
spawn → create agent row (name, program, model, project_id) → create tmux session
  → task is in_progress → agent finishes → task closed/cancelled
  → janitor kills session → agent row stays for audit
```

The **janitor** (`src/overseer/janitor.ts:17`) reaps finished agents' leftover tmux sessions every 60s — it kills any `orca-*` session whose associated task is already `closed` or `cancelled`. Agent rows are never deleted; they stay for audit and token-usage history.

### Live session detection

The web UI checks if a session is actually alive (not just `in_progress` status):

```typescript
// SessionCard reads live tmux session list, compares with task's agent label
const isLive = liveSessions.includes(`orca-${agentName}`);
```

This prevents showing "Running" for tasks whose agent process crashed but status wasn't updated — the stuck detector handles that case.

### Manual binding

If you know the agent name, you can interact directly:

```bash
curl -X POST http://localhost:4400/sessions/orca-SwiftLake0/keys \
  -H "Content-Type: application/json" \
  -d '{"keys": ["C-c"]}'
```

---

## Goal decomposition (autopilot planning)

The `POST /tasks/plan` endpoint decomposes a goal into ordered phases, creating an epic with sequentially chained child tasks.

### Planning modes

#### Relay backend (API key configured)

Default path. The planner model (configured via `config.autopilot.model`) receives the prompt template from `prompts/planner.md` (or a user-saved custom template) and returns a JSON array of 3–7 phases:

1. Prompt template with `{{goal}}` and `{{project}}` placeholders is rendered
2. LLM returns JSON array of phases — each with `title`, `type`, optional `agent` name, and `details`
3. Each phase becomes a task, sequentially chained via `task_deps` (phase n depends on n-1)
4. An epic task titled with the goal wraps all phases
5. Optionally engages a mission

Requires an API key; returns `autopilot_key_missing` (400) without one.

**Prompt rules:**
- Phases must be concrete, independently implementable units
- No meta-steps like "specify", "research", "plan", "set up environment"
- Each phase gets an optional unique friendly agent name (Atlas, Iris, Nova, …)
- Phases ordered so each builds on the previous

#### Pilot backend (CLI Agent)

When `config.autopilot.pilotExec` is set, a **Pilot agent** spawns in the project repo. The Pilot:
- Reads the codebase, project context notes, and stored planning template
- Decomposes the goal using the prompt from `prompts/pilot.md`
- Submits structured phases via `orca plan submit --phases '<json>'`

The Pilot is a regular CLI agent (`pilot-<name>` session prefix), but its only side effect is the `orca plan submit` call — it must not implement anything or spawn agents.

Returns `202 Accepted` with a `jobId`. The web UI polls `GET /plan/:jobId` (every 1s while `planning` status) and receives a `plan` SSE event on completion.

#### Manual mode (no LLM)

Pass `phases: [{title, type?}]` directly — no LLM, no API key needed. Synchronous `201` response.

### Phase types

| Type | Meaning |
|---|---|
| `task` | General implementation |
| `feature` | New feature |
| `bug` | Bug fix |
| `chore` | Maintenance, refactoring |

### Replanning mid-mission

`POST /tasks/:epicId/phases` with a `goal` decomposes a residual goal into new phases that append after the epic's current chain. An active mission picks up the freshly-ready phase on the next engine tick. Works with both relay and agent (Pilot) backends.

### Plan prompt storage

Project notes (set in the Projects page) are fed to the planner and Pilot as **project context** via the `{{project}}` placeholder. This lets you seed domain knowledge (tech stack, conventions, constraints) that every plan for that project picks up automatically.

---

## Overseer (decision gate)

The overseer vets actions before they execute. Two decision paths, controlled by `config.autopilot.overseerExec`:

### Relay path (default)

`overseerExec` is empty → decisions go through `RelayClient` using `config.autopilot.overseerModel`. When the LLM is unavailable, responses default to blanket reject (conservative).

Relay decisions are synchronous from the caller's perspective — the engine/deriver awaits the verdict inline.

### Agent path (parked overseer)

`overseerExec` is set (e.g., `sonnet`) → on mission engage, one **Overseer agent** is parked per active mission. It runs a long-poll loop:
1. `orca overseer poll` — CLI loop absorbs heartbeats, surfaces real decisions
2. Judge the request using the prompt from `prompts/overseer.md`
3. `orca overseer decide --id <id> --approve --confidence 0.85 --rationale "..."` — submits the verdict

The agent path is fully async — the engine/deriver enqueues a decision and awaits the verdict from the parked overseer (or a 120s timeout).

### DecisionQueue

Per-mission FIFO in `src/overseer/decisionQueue.ts` with three decision kinds:

| Kind | Enqueued by | Context |
|---|---|---|
| `task` | Mission engine tick | Task title, description, labels, triggered guardrails |
| `prompt` | Deriver | Permission prompt question, context, options |
| `review` | PATCH close handler (post-done) | Task title, outcome, summary |

Every enqueued decision is **guaranteed to settle**: by the agent, by a 120s timeout (conservative escalate), or by `drain()` when the mission disengages (all pending decisions escalate).

### Centralized gate

`gateVerdict()` in `src/overseer/decision.ts:28` applies `MIN_CONFIDENCE` (0.6) centrally for both task and prompt decisions — neither the relay path nor the parked overseer can override the threshold. The local destructive heuristic (`isDestructive()`, applied at enqueue time) is **always authoritative**: even if the overseer approves, a destructive verdict cannot be overridden.

---

## Async planning jobs

When `POST /tasks/plan` uses the autopilot relay or Pilot backend, planning is asynchronous:

1. Returns `202 Accepted` with a `jobId`
2. A `plan` SSE event is emitted immediately: `{jobId, status:'planning'}`
3. The web UI polls `GET /plan/:jobId` (every 1s while status is `planning`)
4. On success, `finalizePlanJob()` persists the epic + phases, emits a `plan` SSE event: `{jobId, status:'done', epicId, phases}`
5. On failure, emits `{jobId, status:'failed', error}` — the UI shows the error
6. The Pilot agent path: spawns `pilot-<name>` in the repo → reads codebase → calls `POST /plan/:jobId/submit` → the route calls `parsePhases()` using the same validator as the relay path (DRY) → `finalizePlanJob()`

Job storage is in-memory (`PlanJobStore` in `src/overseer/planJob.ts`). Jobs are scoped to the project of the requesting user and access-gated. The Pilot agent has its own ungessable job ID and `agent` token scope — it never needs project-level access beyond its assigned job.

`GET /plan/:jobId` is accessible to:
- Interactive users (project access gate)
- The Pilot agent (via `tokenScope === 'agent'`)

---

## Deriver: prompt detection & resolution

The deriver (`src/deriver/deriver.ts`) polls every live `orca-*` tmux pane every 5s, detecting agent state changes from terminal output.

### Prompt detection (`src/deriver/shellPatterns.ts`)

| Program | Gate detected | Trigger text | Action |
|---|---|---|---|
| OpenCode | Permission required | `Permission required` + Allow/Reject buttons | L2/L3: overseer decides; L0/L1: escalate |
| Claude Code | Workspace trust | `Yes, I trust this folder` | **Auto-accepted** (autoAccept) — orca only spawns into registered projects |
| Claude Code | Permission | `Do you want to proceed?` | L2/L3: overseer decides; L0/L1: escalate |
| Codex | Command approval | `Allow command?` / `Approve this command?` | L2/L3: overseer decides; L0/L1: escalate |

`autoAccept` prompts are cleared directly by the deriver under L2+ autonomy without an overseer round-trip — workspace-trust gates just block startup and don't represent a real action risk.

### Resolution flow

For L2/L3 (and manual, mission-less) sessions:
1. Detect prompt via `detectAgentPrompt(output, program)`
2. If `autoAccept`: send `acceptKeys` (e.g., Enter) directly
3. Otherwise: send through overseer gate (`decideApproval`):
   - Agent path: enqueue `prompt` decision → parked overseer judges → settle
   - Relay path: `decidePrompt()` inline via relay LLM → gate through `gateVerdict()`
4. On approve + non-destructive: send `acceptKeys`; mark status `working`
5. On deny or destructive: emit `needs_input` signal → human must approve in UI

For L0/L1: always escalate to human (`needs_input` signal).

### Signal bus

The deriver emits derived signals to the SSE event bus:

| Signal | Meaning |
|---|---|
| `working` | Agent is active, no prompt detected |
| `needs_input` | Agent is paused on a prompt, needs human intervention |
| `complete` | Agent's task is closed — final signal before janitor cleanup |

### Deduplication

Each prompt is hashed (question + context) and tracked per session in a `last` Map. Identical prompts from sequential polls are skipped to avoid redundant overseer calls.

---

## Guardrails

Guardrails are regex-based safety checks that prevent sensitive tasks from auto-running without oversight.

### Guardrail categories

| Guardrail | Pattern |
|---|---|
| `schema` | `\bschema\b` |
| `migration` | `\bmigrat` |
| `auth` | `\b(auth\|login\|password\|token)\b` |
| `payments` | `\b(payment\|billing\|stripe\|invoice)\b` |
| `destructive` | `\b(delete\|drop\|truncate\|rm -rf\|destroy)\b` |

### How guardrails are triggered

1. **Mission engine tick**: `detectGuardrails(`${task.title} ${task.labels.join(' ')}`)` — checks task title + labels
2. **Scheduler tick**: `detectGuardrails(task.title)` — checks task title only
3. Result: array of triggered guardrail names (e.g., `['schema', 'migration']`)

### Clearance

A task passes when all triggered guardrails are in the mission's `cleared_guardrails` list (`isCleared()`). The clearance check happens before the overseer LLM gate:

1. Guardrails detected → check `isCleared()`
2. If cleared + L2/L3 → task is permitted to spawn
3. If the mission has a `decideTask` wired (overseer relay/agent) → extra LLM gate
4. LLM denial or destructive verdict → task set `blocked`

In the scheduler path (no mission, no autonomy), guardrailed tasks are **skipped entirely** — they stay open and their schedule is not consumed. A human must launch them manually.

### Separate destructive check

The overseer decision engine has its own, broader destructive heuristic (`DESTRUCTIVE` regex in `src/overseer/decision.ts:42`) that catches `rm -rf`, `DROP TABLE`, `DELETE FROM`, `TRUNCATE`, `git push -f`, `chmod 777`, `curl | sh`, `eval`, `exec(`, and more. This is applied at decision enqueue time and is authoritative — neither the relay LLM nor the parked overseer can override it.

---

## Scheduled task launch

Tasks can be scheduled for future execution via the `scheduled_at` ISO-8601 field combined with `autostart`.

### Flow

1. Task created with `scheduled_at: "2026-06-20T10:00:00Z"` and `autostart: 1`
2. `Scheduler.tick()` runs every 30s, finds due tasks across all projects
3. Schedule is consumed (set to `null`) so it fires exactly once
4. The schedule is restored on spawn failure so the next tick retries

### Guardrails gate

Unlike the mission engine, the scheduler has no autonomy level and no overseer in the loop. To prevent unattended sensitive tasks from auto-running, tasks whose title trips a guardrail are **skipped** — they stay `open` and their schedule is not consumed. A human must launch them manually.

### Per-project burst cap

The scheduler caps launches to `maxPerProjectPerTick` (default 5) per project per tick. This prevents a burst of co-scheduled tasks (e.g., 50 due at the same minute) from spawning 50 parallel agents at once and exhausting API quota/resources. Remaining due tasks fire on the next tick.

### Conflict detection

The web UI warns when two tasks are scheduled within 10 minutes of each other.

---

## Stuck detector

The stuck detector (`src/overseer/stuckDetector.ts`) sweeps every 60s for `in_progress` tasks whose agent tmux session is no longer live — the agent exited or crashed without calling `orca close`.

### Flow

1. Collect all `in_progress` tasks
2. Find those with no live `orca-<agent>` session (or missing `agent:` label)
3. Apply a grace period (120s by default) — freshly spawned agents are not immediately reaped
4. `bumpStuck()` counts relaunch attempts with a `stuck:<n>` label
5. If `n <= maxRelaunch` (2): revert to `open` so the mission/scheduler re-spawns it
6. If `n > maxRelaunch`: escalate to `blocked` to avoid an infinite crash loop — a human must unblock

### Zombie reconcile at startup

The same logic (`deadAgentTasks()`) runs once at daemon startup to clean up any zombie `in_progress` tasks left over from a crash. Tasks without a live session are reverted to `open`.

---

## Post-done review

When `config.autopilot.reviewOnDone` is `true` **and** an agent overseer is configured (`overseerExec` is set), closing a mission phase triggers a **post-done review** via the decision queue.

### Flow

1. The PATCH close handler (`src/api/server.ts:674`) detects a child task closing inside an epic
2. Enqueues a `review`-kind decision with the task's title, outcome, and summary
3. The parked overseer for this mission judges the result
4. If the verdict is negative (not approved or destructive), all **dependent** phases (those with `task_deps` pointing to this task) are set `blocked`

### Characteristics

- **Non-blocking** — `void`-ed, never delays the agent's close response
- **Opt-in** — off by default, requires both `reviewOnDone` and an overseer agent
- **Recovery** — a human un-blocks the stalled phases to resume the mission

---

## Event store / activity feed

All state changes are recorded in SQLite `events` table (`src/store/eventStore.ts`).

### Events recorded

| Event type | When triggered | Payload |
|---|---|---|
| `task` | Created, status changed, deleted | task ID + new status |
| `mission` | Engaged, paused, resumed, disengaged, stalled | mission ID + new state |
| `signal` | Deriver detected state change | session name + signal type |
| `plan` | Plan job status (planning, done, failed) | job ID + status |

### EventStore API

```typescript
class EventStore {
  record(event: { type: string; target: string; detail: string }): void
  list(opts?: { limit?: number; type?: string }): ActivityEvent[]
  deleteForTarget(target: string): void
}
```

### Activity timeline

The web UI Timeline page queries `GET /activity?limit=50` and renders three views: axis (horizontal dot plot), swimlanes (per-target tracks), and feed (collapsible per-target groups). Events within 5 minutes of same type/detail/target collapse into `×N` groups.

---

## Task executor in labels

Tasks store their executor as an `exec:<spec>` label rather than a dedicated DB column.

### Resolution order (`src/overseer/routing.ts`)

1. Extract `exec:<spec>` from task labels
2. Match known program prefix: `codex:<model>` → program `codex`, `opencode:<model>` → program `opencode`, `claude:<model>` → program `claude-code`
3. If spec contains `/` (provider/model shape) → program `opencode`
4. Otherwise → program `claude-code` with spec as model name

### Why labels?

- Labels are a general-purpose key-value store on tasks
- Avoids schema migration for each new attribute
- Frontend and backend use the same resolution logic
- Multiple labels can coexist (exec + agent + guardrail triggers + stuck counter)

### Single source of truth: `src/shared/execs.ts`

Executor metadata — program prefixes (`codex:`, `opencode:`, `claude:`), known execs, and validation — is defined once in `src/shared/execs.ts` and consumed by both `overseer/routing.ts` (resolution) and `store/configStore.ts` (allow-listing). Adding or changing an executor is a one-line edit in this file.

### allowedExecs validation

Every chosen exec must be present in `config.allowedExecs` or match a known prefix/slash shape — the API rejects unknown execs with `exec not allowed` (400). Per-user model allow-lists further restrict which execs a non-admin may use.

---

## Inference client interface

The inference layer (`src/inference/types.ts`) defines a minimal interface for LLM backends:

```typescript
interface InferenceClient {
  decide(prompt: string): Promise<{ text: string }>;
}
```

### Implementations

| Implementation | Purpose |
|---|---|
| `RelayClient` (`src/inference/client.ts`) | Production — relays to an OpenAI-compatible API (`config.autopilot.apiUrl`) |
| `FakeInference` | Tests — returns predictable responses |

### Usage

The interface is consumed by:
- **Planner** (`src/overseer/planner.ts`): goal decomposition (`decompose()`)
- **Overseer decision engine** (`src/overseer/decision.ts`): `decidePrompt()` and `decideTask()`

### Configuration

| Config field | Purpose |
|---|---|
| `autopilot.model` | Planner model (e.g., `claude-opus-4-8`) |
| `autopilot.overseerModel` | Overseer model (falls back to planner model when blank) |
| `autopilot.apiUrl` | Relay base URL |
| `autopilot.apiKeySet` | Whether an API key has been set (read-only, key is never served) |

### Adding a new backend

Implement the `InferenceClient` interface and inject it via the `makeInference` factory in server bootstrap.
