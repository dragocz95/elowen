# Concepts

## Tasks

A **task** is a unit of work. Tasks form a tree via `parent_id` — an epic (root task) contains sub-tasks. Tasks can also declare dependencies (`task_deps` table) that must be closed before the task becomes ready.

### Task lifecycle

```
open → in_progress → closed
  ↓                    ↑
blocked ───────────────┘ (retry via manual unblock)
  ↓
cancelled
```

| Status | Meaning |
|---|---|
| `open` | Waiting to be picked up |
| `in_progress` | Assigned to an agent session |
| `blocked` | Escalated to human: stuck detector exceeded relaunch budget, or dependency rejected by post-done review |
| `closed` | Completed successfully |
| `cancelled` | Abandoned |

Blocked tasks are excluded from `readiness.ready()` so the engine tick skips them. A human must manually unblock (set back to `open`) to retry.

### Labels

Tasks carry string labels used for routing and agent naming:

- `exec:<spec>` — route to a specific agent executor (e.g., `exec:sonnet`, `exec:opencode:ollama-cloud/deepseek-v4-flash`, `exec:codex:gpt-5.5`)
- `agent:<name>` — pin a specific agent name for this task's session (`orca-<name>`). Named agents let the deriver, janitor, and stuck detector resolve the task from a session without relying on first-in-progress fallback.
- `started:<epoch-ms>` — precise spawn timestamp for correct usage attribution under concurrency
- `stuck:<n>` — relaunch counter; incremented each time the stuck detector reverts this task, bounds re-spawns at `maxRelaunch` (2)

### Readiness

A task is **ready** when it is `open`, not an epic, and every one of its dependencies (`task_deps`) is `closed` or `cancelled`. The `Readiness` service computes this at query time with a single `NOT EXISTS` deps check — `ready(projectId)` across a project, or `readyForEpic(epicId)` scoped to one epic's direct children (used by the mission engine so parallel missions don't walk each other's tasks).

---

## Missions

A **mission** groups tasks under an epic for autonomous execution. The mission engine (`MissionEngine`) ticks active missions, picks each epic's ready tasks, and spawns agents up to `max_sessions`. The Overseer is not consulted at dispatch — it gates the agents' permission prompts (via the Deriver) and optional post-phase reviews; see the Overseer section below.

### Mission lifecycle

```
engage → active → disengaged
           ↓
        paused → active (resume)
           ↓
        stalled → active (blocked child unblocked or resumed)
```

| State | Meaning |
|---|---|
| `active` | Engine processes this mission on each tick |
| `paused` | Skipped by the engine; running agents killed, tasks reverted to open |
| `stalled` | Active but no agent running and a child is blocked — waiting for human intervention |
| `disengaged` | All children closed/cancelled; mission complete |

The `stalled` state is transitional: when the engine tick finds zero running sessions and at least one `blocked` child, it marks the mission `stalled` so the UI reads "needs attention." Once a blocked child is unblocked and work resumes, it flips back to `active`.

### Mission config

| Field | Description |
|---|---|
| `epic_id` | Root task ID that owns this mission |
| `autonomy` | L0–L3 autonomy level |
| `max_sessions` | Max concurrent agent sessions for this mission's children |
| `cleared_guardrails` | *(removed — no longer enforced)* |

### Engine tick

The tick loop (every 90 seconds, one tick per active mission):

1. Load the mission, its epic, and its project
2. If all children are `closed`/`cancelled` → auto-disengage
3. Count running = this epic's own `in_progress` children (not global sessions)
4. Walk `readiness.readyForEpic(epicId)` — the epic's direct, dependency-cleared children; for each, while `running < max_sessions`:
    - Skip if autonomy is L0 (Recommend — plan only, no spawn)
    - L1–L3: resolve executor from labels, pick an agent name, set `in_progress`, spawn via tmux
5. Detect stalled: zero running + any blocked child → mark `stalled`; if previously stalled and work resumed → mark `active`

---

## Autonomy levels

| Level | Name | Auto-spawn | Prompt gate | Confidence bar |
|---|---|---|---|---|
| L0 | Recommend | Never | Always escalate to human | — |
| L1 | Assist | Yes | Overseer gate (stricter) | 0.85 |
| L2 | Pilot | Yes | Overseer gate (standard) | 0.6 |
| L3 | Auto | Yes | Overseer gate (standard) | 0.6 |

In the current implementation:
- **L0**: The engine never auto-spawns. The deriver escalates all detected permission prompts to human (`needs_input`), never auto-approving.
- **L1**: The engine auto-spawns ready tasks. The deriver routes permission prompts through the overseer gate with a **stricter confidence threshold** (0.85 vs 0.6). Only clearly-safe steps auto-clear; anything below the bar escalates to human. This is the key difference from L2 — not whether prompts are gated, but how strictly.
- **L2/L3**: The engine auto-spawns ready tasks. The deriver routes permission prompts through the overseer gate with the standard confidence threshold (0.6). L3 additionally waves non-destructive prompts through when no overseer is configured at all (L2 escalates in that case).

---

## Guardrails

Guardrails were removed in v1.1.1. The regex-based safety check system (`detectGuardrails`, `isCleared`, `cleared_guardrails`) was eliminated because it caused missions to stall silently when descriptive phase titles triggered false-positive matches. The `cleared_guardrails` column remains in the schema for backward compatibility but is no longer enforced.

The **overseer decision gate** (relay LLM or parked agent) still provides a safety layer for permission prompts and task dispatch — see the Overseer section below. The decision engine's local destructive heuristic (`isDestructive()`) catches dangerous operations (rm -rf, DROP TABLE, curl | sh, eval, etc.) at enqueue time and is authoritative.

---

## Overseer (decision gate)

Two decision paths, controlled by `config.autopilot.overseerExec`:

### Relay path (default)

`overseerExec` is empty. Permission-prompt decisions go through `RelayClient` using `config.autopilot.overseerModel` (falls back to the planner model). When no relay is wired at all (no API key, no parked agent), the daemon applies `noOverseerFallback()`: **only L3 waves a non-destructive prompt through**; L0–L2 escalate to a human, and destructive prompts always escalate. There is no blanket auto-approve. Post-done reviews cannot run on the relay path — they require a parked overseer.

All decisions pass through the centralized `gateVerdict()` function in `decision.ts`, which applies the `MIN_CONFIDENCE` (0.6) threshold as a single source of truth — callers no longer re-implement the comparison.

### Agent path (parked overseer)

`overseerExec` is set (e.g., `sonnet`). On mission engage, one **Overseer agent** is parked per active mission. It runs a long-poll loop:
1. `orca overseer poll` — blocks until a decision is needed, returns `{id, kind, context}`
2. Judge the request
3. `orca overseer decide --id <id> --approve --confidence 0.85 --rationale "..."` — submits the verdict
4. Back to step 1

The local destructive heuristic (computed at enqueue time) is **always authoritative** — the agent cannot override it. A timeout (120s) or mission disengage conservatively escalates all pending decisions. The heuristic covers: rm -rf, DROP TABLE, DELETE FROM, TRUNCATE, migration, .env, secret/credential/password/private_key, force push, git reset --hard, chmod 777, curl/wget pipes to shell, python/node/perl -e/-c, netcat, bash -c, eval(), os.system, subprocess, and exec().

The decision queue (`DecisionQueue`) is a per-mission FIFO. `DecisionKind` is `'prompt' | 'review'` — task dispatch is **not** gated through the queue:

| Kind | Source | Context |
|---|---|---|
| `prompt` | Deriver | Permission prompt question, context, options |
| `review` | PATCH close handler (post-done) | Task title, outcome, summary |

Every enqueued decision is guaranteed to settle: by the agent's verdict, by the 120 s timeout, or by `drain()` on mission disengage. The `isDestructive()` flag captured at enqueue is OR'd into the agent's verdict on resolve, so an agent's `approve` can never dispatch a flagged-destructive action.

---

## Pilot Agent (AI planning)

When `config.autopilot.pilotExec` is set, `POST /tasks/plan` spawns a **Pilot** agent in the repository instead of using the relay-based planner. The Pilot:

1. Reads relevant files, AGENTS.md, CLAUDE.md, README for conventions
2. Decomposes the goal into 3–7 ordered phases
3. Submits the plan via `orca plan submit --phases '<json>'`
4. Stops — it must not implement anything or spawn agents

The `PlanJobStore` tracks the async planning job. Autopilot mode is **always async** — both the relay and the agent backend return `202 Accepted` with a `jobId` that the web UI polls via `GET /plan/:jobId`. Only manual `phases` mode is synchronous (`201`). Plan jobs are in-memory and ephemeral: a daemon restart drops in-flight jobs (surfaced as `failed`), and a finished job is pruned after a 10-minute TTL.

The Pilot prompt is stored in `prompts/pilot.md` and rendered at runtime via `src/prompts/index.ts` with `{{goal}}` and `{{projectNotes}}` substitution.

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

The `users` table stores username + password hash. Additional fields: `is_admin` flag, `allowed_execs` (per-user model allow-list), avatar, name, email, default_exec.

### Enforcement

The `authMiddleware` in `src/api/auth.ts` checks every request:
1. Is the path public? (health, login) → allow
2. Is there a valid token? (Authorization header or query param) → allow
3. Otherwise → 401

The middleware is only active when `d.users` is provided to the server factory. Setup mode (zero users) keeps the API open until onboarding creates the first admin.

---

## AI planning

The `POST /tasks/plan` endpoint decomposes a high-level goal into ordered implementation phases. Two backends:

### Relay backend (default)

1. **Prompt construction** — the template from `prompts/planner.md` (or user-saved custom via `PUT /config`) is rendered with `{{goal}}` and `{{project}}` substitution
2. **LLM call** — `decompose(inf, goal, template, opts)` sends the prompt via the configured autopilot inference client
3. **Parse** — `parsePhases(text)` extracts the JSON array via `extractJson()` (from `src/overseer/llmParse.ts`), validates each phase has a title and valid type
4. **Task creation** — `persistPlan(job, deps)` creates an epic + chained child tasks with sequential dependencies
5. **Optional engage** — if `engage: true`, creates and starts a mission immediately

### Agent backend

When `pilotExec` is configured, a Pilot agent is spawned in the repo (see Pilot Agent section above). The agent submits phases via `POST /plan/:jobId/submit`.

### Manual mode

Pass `phases: [{title, type?}]` — no LLM, no key needed. The daemon creates the epic and tasks synchronously (201 response).

### Phase types

| Type | Purpose |
|---|---|
| `epic` | Root goal (auto-created) |
| `task` | General implementation work |
| `feature` | New feature addition |
| `bug` | Bug fix |
| `chore` | Maintenance, refactoring, tooling |

### Requirements (relay path)

- Autopilot API key must be configured in daemon settings
- LLM must return valid JSON (no markdown fences, no prose)
- On parse failure, returns 502 with `"plan_parse_failed"`

### Per-model descriptions (modelNotes)

`config.modelNotes` is a map of exec → capability description, seeded from `src/shared/execs.ts`
(`EXEC_NOTES`). Every built-in exec ships with a default note describing its strengths (e.g.
"fast reliable everyday coder", "best for hard architecture"). User edits in Settings → Models
persist and merge *under* the built-in defaults so known models always carry a description.

### Auto-model per-phase picking

When `autoModel: true` is passed to `POST /tasks/plan`, the planner receives a `{{models}}` block
listing every enabled model that has a non-empty note. The planner is instructed to pick the best
model per phase and include an `exec` field on each phase object. The `modelsBlock()` helper in
`src/overseer/planner.ts` renders the block — only models in `allowedExecs` with a non-empty note
are listed. When no models qualify, the block is empty and phases fall back to the configured
default exec.

Both backends (relay and Pilot agent) support `autoModel`. The Pilot agent receives the same
`{{models}}` block in its prompt via `modelsBlock()`.

### Adding phases to an existing epic

`POST /tasks/:epicId/phases` — append manual phases after the current chain, or replan a residual `goal`. New phases depend on the epic's current leaf tasks. An active mission picks up the freshly-ready phase on the next tick (triggered immediately after creation).

---

## Activity log / event store

All state changes are recorded in SQLite `events` table (`src/store/eventStore.ts`):

| Event type | Example |
|---|---|
| `task` | Task created, status changed, deleted |
| `mission` | Mission engaged, paused, resumed, disengaged |
| `signal` | Deriver detected working/needs_input/complete |
| `plan` | Plan job status (planning, done, failed) |

The log is queryable via `GET /activity` with optional `type` and `limit` filters. Used by the Timeline page in the web UI. Events are grouped in the UI: identical events within 5 minutes collapse into `×N` to prevent flood from repeated deriver signals.

---

## Inference client

The inference layer (`src/inference/types.ts`) defines a minimal interface for LLM backends:

```typescript
interface InferenceClient {
  decide(prompt: string): Promise<{ text: string }>;
}
```

### Implementations

| Implementation | File | Purpose |
|---|---|---|
| `RelayClient` | `src/inference/client.ts` | Production — relays to an OpenAI-compatible API |
| `FakeInference` | `src/inference/client.ts` | Tests — returns predictable responses |

### Consumers

- **Planner** (`src/overseer/planner.ts`): goal decomposition for `POST /tasks/plan`
- **Decision engine** (`src/overseer/decision.ts`): prompt and task approval

---

## Agent routing

Tasks specify which AI agent should execute them via the `exec:<spec>` label.

### Executor resolution

`resolveExecutor()` in `src/overseer/routing.ts`:

- `exec:sonnet` → `{ program: 'claude-code', model: 'sonnet' }`
- `exec:opencode:model` → `{ program: 'opencode', model: 'model' }`
- `exec:codex:model` → `{ program: 'codex', model: 'model' }`
- `exec:claude:model` → `{ program: 'claude-code', model: 'model' }`
- `exec:ollama/deepseek-v4-flash` → `{ program: 'opencode', model: 'ollama/deepseek-v4-flash' }`
- `exec:deepseek/deepseek-v4-flash` → `{ program: 'opencode', model: 'deepseek/deepseek-v4-flash' }` (contains `/`)
- No label → uses the configured fallback (default: `claude-code` / `sonnet`)

The executor metadata (program prefixes, default binaries, known execs, well-formedness rules, and
default capability notes) is centralized in `src/shared/execs.ts`. Both `overseer/routing.ts`
(resolution) and `store/configStore.ts` (validation) import from there — adding or changing an
executor is a one-line edit in a single file. The `EXEC_NOTES` constant seeds `config.modelNotes`
on first install so every built-in model ships with a sensible autopilot description.

### Agent commands

| Program | Command pattern |
|---|---|
| `claude-code` | `cd <project> && export ORCA_URL=… ORCA_TOKEN=… && claude --dangerously-skip-permissions --model <model> <prompt>` |
| `opencode` | `cd <project> && export ORCA_URL=… ORCA_TOKEN=… && opencode --model <model> --prompt '<prompt>'` (interactive TUI; SpawnService nudges Enter at 4s/8s/13s to submit) |
| `codex` | `cd <project> && export ORCA_URL=… ORCA_TOKEN=… && codex --dangerously-bypass-approvals-and-sandbox --model <model> <prompt>` |

The prompt instructs the agent to close the task with `orca close <taskId>` when done. The agent receives the orca CLI path, daemon URL, and a service token via environment variables so it can reach back to the daemon.

### Allowed executors

The daemon configuration (`allowedExecs`) controls which executors are permitted via the API. Unknown executors return 400. A per-user model allow-list (`allowed_execs`) further restricts non-admin users. The CLI and web UI enforce this on the daemon side.

---

## Deriver

The **deriver** monitors agent sessions in real time. It polls tmux every 5 seconds and detects agent state by examining the pane output.

### Poll loop

```
tick():
  for each orca-* session:
    resolve agent program (from agent store)
    resolve associated task (via agent:<name> label)
    if task closed → emit 'complete'
    if task status not in_progress/open → skip
    capture pane (last 60 lines)
    detectAgentPrompt(program, output)
    if prompt detected and autonomy !== 'L0':
      autoAccept (workspace-trust) → send accept keys, emit 'working'
      else → consult overseer with autonomy level → approve? send accept keys + emit 'working'
              escalate? emit 'needs_input' with question/options
    elif prompt detected and L0:
      emit 'needs_input' (always escalate)
    else → emit 'working'
```

Each detected prompt is hashed to avoid re-emitting on consecutive polls.

### Detected states

| Signal | Meaning |
|---|---|
| `working` | Agent is progressing normally |
| `needs_input` | Agent is waiting for user input (prompt detected, escalated) |
| `complete` | Task is closed |

### Prompt detection

Implemented for all three supported agent programs (`shellPatterns.ts`):

- **OpenCode** — "Permission required" dialog with Allow/Reject options
- **Claude Code** — workspace-trust gate on first folder entry (auto-accepted directly, no overseer round-trip) and "Do you want to proceed?" permission gate
- **Codex** — "Allow command?" / "Approve this command?" approval gate

For L1–L3 missions and mission-less sessions: environmental gates (claude workspace-trust) are auto-accepted; other prompts go through the overseer gate — accept keys are sent on approval, else escalate to human. The overseer applies a **per-autonomy confidence threshold**: L1 (Assist) requires 0.85 confidence to auto-clear, L2/L3 use the standard 0.6. For L0: all prompts escalate to human.

### No-overseer fallback

When no overseer is configured at all (no relay LLM, no parked agent), the daemon applies a conservative fallback:
- **L3**: non-destructive prompts are waved through; destructive prompts escalate.
- **L0–L2**: all prompts escalate to human — no blanket approval.

### Deduplication

Each detected prompt is hashed (question + context) to avoid re-emitting the same signal on consecutive polls. The hash is stored per-session.

---

## Event bus

The `EventBus` decouples services and provides real-time updates to the web UI:

| Event | Trigger | Payload |
|---|---|---|
| `task` | Status change | `{ taskId, status }` |
| `mission` | State change | `{ missionId, state }` |
| `signal` | Deriver output | `{ session, signal }` |
| `plan` | Plan job status | `{ jobId, status, phases?, error? }` |

The event bus:
- Serves SSE streams at `GET /events`
- Invalidates React Query caches in the web UI
- Is implemented as an in-memory pub/sub (`Set<() => void>`)

---

## Session identity (daemon-classified)

The daemon classifies every live tmux session by its naming convention so the API and web UI know its role without reverse-engineering the raw name. `classifySession()` in `src/overseer/sessionInfo.ts` maps each `orca-*` session to a `SessionInfo`:

```typescript
type SessionRole = 'overseer' | 'pilot' | 'agent' | 'advisor';
interface SessionInfo { name: string; role: SessionRole; agent: string; missionId?: string }
```

| Prefix | Role | Example |
|--------|------|---------|
| `orca-overseer-<missionId>` | `overseer` | Parked per-mission decision agent |
| `orca-pilot-<name>` | `pilot` | Repo-aware planning agent |
| `orca-advisor-<userId>` | `advisor` | Per-user assistant session (see Assistant section) |
| `orca-<name>` | `agent` | Worker agent on a task |

`GET /sessions` returns classified sessions — clients see structured role + agent name + optional missionId, never parse the raw tmux name.

## Prompt template system

All LLM prompts are managed as Markdown templates in the repo-root `prompts/` directory and rendered via `src/prompts/index.ts`:

```typescript
import { render, rawTemplate } from '../prompts/index.js';

// Rendered with variable substitution
const prompt = render('planner', { goal: 'Add dark mode', project: 'My notes' });

// Raw template for the editable editor in settings
const raw = rawTemplate('planner');
```

The build copies `prompts/` into `dist/prompts/`. Templates are cached after first read; call `_resetPromptCache()` to force re-read (for tests or on-disk edits).

| Template | Used by | Placeholders |
|---------|---------|-------------|
| `planner.md` | Autopilot relay: goal → phases decomposition | `{{goal}}`, `{{project}}`, `{{models}}` |
| `planner-fallback.md` | Fallback when no custom template is saved | `{{goal}}`, `{{models}}` |
| `pilot.md` | Pilot agent: repo-aware CLI planning | `{{goal}}`, `{{notes}}`, `{{submit}}`, `{{jobId}}`, `{{models}}` |
| `overseer.md` | Parked overseer agent: per-mission decision loop | — |
| `advisor.md` | Per-user assistant agent: drives Orca on the user's behalf | `{{userName}}` |
| `worker.md` | Worker agent: general task execution | — |
| `worker-phase.md` | Phase agent: epic child task execution | — |
| `worker-epic-close.md` | Final phase: also closes parent epic | — |
| `decision-header.md` | Shared overseer decision header | — |
| `decision-prompt.md` | Overseer prompt-gate decision body | — |


## LLM JSON extraction

`src/overseer/llmParse.ts` provides a shared `extractJson()` function for robustly extracting JSON objects/arrays from LLM output — handling markdown fences, prose wrappers, and greedy bracket matching. Used by both `planner.ts` (phase array extraction) and `decision.ts` (verdict object extraction), replacing the previously duplicated regex-based approaches.

## Token-usage observability

The daemon reads per-task token consumption and cost from each executor CLI's local session storage — no relay or API key needed. `readTaskUsage()` in `src/integrations/usage/index.ts`:

1. Resolves the task's executor (program + model) from its `exec:` label
2. Reads the CLI's local usage DB (opencode, claude-code, or codex)
3. Matches the session by project directory + agent spawn time (`started:<ms>` label)
4. Disambiguates concurrent agents by start-order rank (parallel missions attribute correctly)

Exposed via `GET /tasks/:id/usage`:
```json
{ "inputTokens": 12000, "outputTokens": 3400, "totalTokens": 15400, "costUsd": 0.045, "contextWindow": 200000, "model": "claude-sonnet-4-20250514" }
```

Returns `null` when no matching CLI session is found. The web UI polls usage every 8 seconds for live tasks and displays it via `TaskUsageBadge` / `UsageBadge`.

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

Reasoning agents (Pilot, Overseer) use names like `orca-overseer-<missionId>`.

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
| `resize` | `tmux resize-pane -t <name> -x <cols> -y <rows>` (untested, expected to work) |

A `FakeTmuxDriver` implementation exists for tests with in-memory session simulation.

### Reasoning agents

Two special agent types use named tmux sessions outside the normal task→agent mapping:

- **Pilot**: `orca-<name>` (same pool). Spawned for agent-mode plan jobs. Own prompt, no `orca close` — submits plan via `orca plan submit` and its session idles until killed.
- **Overseer**: `orca-overseer-<missionId>`. One per active mission when `overseerExec` is configured. Long-polls `GET /missions/:id/overseer/next`, answers via `POST /missions/:id/overseer/decide`, never edits code.

---

## Stuck detector

The stuck detector (`src/overseer/stuckDetector.ts`) runs every 60 seconds with a 120-second grace period.

### Detection

An agent that exits or crashes without running `orca close` leaves its task `in_progress` with a dead tmux session. The stuck detector:

1. Lists live `orca-*` tmux sessions
2. Finds `in_progress` tasks whose agent session is gone (`deadAgentTasks`)
3. Skips tasks spawned less than `graceMs` (120s) ago
4. Increments the `stuck:<n>` label counter
5. If `count > maxRelaunch` (2): sets the task `blocked` (escalates to human)
6. Otherwise: reverts to `open` so the mission/scheduler re-spawns it

### Bounded relaunch

Each task instance carries a `stuck:<n>` label that counts total relaunches. This guarantees a flaky task eventually escalates rather than spinning forever.

### Zombie reconcile

On daemon startup, the same `deadAgentTasks` logic runs as a one-shot pass (no grace, no counter — a restart isn't an agent death, so it shouldn't spend the relaunch budget). In-progress tasks with no live tmux session are reverted to `open`.

---

## Post-done review (hard gate)

When `config.autopilot.reviewOnDone` is true and an agent overseer is configured, closing a mission phase triggers a **hard sequential gate** before the next phase may run:

1. **Gate closes synchronously**: the close handler immediately sets all open direct dependents to `blocked` — so no engine tick can spawn them while the review is pending. Only tasks gated by *this* review are tracked; a dependent blocked by a different cause is never touched.
2. **Review is enqueued**: a `review`-kind decision is sent to the parked overseer with the task's title, outcome, and result summary (plus the local `isDestructive()` verdict).
3. **Overseer judges**: the parked overseer (or relay fallback) responds with `approve`/`reject`.
4. **Gate opens on approval**: if the verdict approves and is non-destructive, the gated dependents are released back to `open` and `engine.tick()` fires immediately — so the next phase spawns without waiting for the 90-second interval. The release re-checks current status so a human's manual change is never overridden.
5. **Gate stays shut on reject**: a negative or destructive verdict leaves the dependents `blocked`, stalling the mission until a human manually unblocks them.

The review itself is fire-and-forget from the agent's perspective — the agent's `close` call returns immediately; the gating happens in a background promise that must never crash the daemon.

Default off. Requires `overseerExec` to be set (relay fallback cannot drive post-done reviews).

### Overseer watchdog

The mission engine calls `overseer.ensure()` on every tick. If the parked overseer session has exited mid-mission (full context, clean exit per its own prompt), `ensure()` re-parks it automatically — otherwise post-phase reviews and permission decisions would silently stop. The call is idempotent: it is a no-op while the session is still live or when no `overseerExec` is configured.

---

## Assistant (per-user advisor)

The **assistant** (UI label "Assistant", session role `advisor`) is a persistent, per-user agent session that drives Orca on the user's behalf. Each user gets their own `orca-advisor-<userId>` tmux session that runs a configured CLI agent (`advisor_exec`, remembered per user) with a **full-scope token** scoped to that user's rights.

### Lifecycle

- **Start** — `POST /advisor/start { exec }` (or the dock's start button). The `AdvisorService` (`src/advisor/service.ts`) resolves the executor, mints a dedicated `advisor`-scoped token (`ensureAdvisorToken`), writes a per-program MCP config into the advisor's cwd so the CLI auto-connects to Orca's MCP server, and spawns the session.
- **Auto-start on login** — when a user with a saved `advisor_exec` and `advisor_autostart: true` logs in, `ensureOnLogin()` brings the assistant back up fire-and-forget (never blocks the login response).
- **Stop** — `POST /advisor/stop` kills the `orca-advisor-<userId>` session. The token is untouched (reused across restarts).
- **Status** — `GET /advisor/status` returns `{ running, exec, session }`; polled by the dock every 5 s.

### MCP server

The advisor acts through Orca's built-in MCP server (`src/mcp/`), exposed at `POST /mcp`. Each request is handled statelessly with a fresh `McpServer` + transport bound to the caller's bearer token, so every advisor connection acts with exactly its user's rights. The toolset (`src/mcp/tools.ts`):

| Tool | Purpose |
|---|---|
| `orca_request` | Generic escape hatch — call any REST endpoint (method, path, body) |
| `orca_tasks` | List all tasks |
| `orca_create_task` | Create a task (title, project_id?, description?) |
| `orca_plan` | Plan a goal into an epic with phases (autopilot) |
| `orca_sessions` | List live agent sessions |

Every tool delegates to the shared `callOrcaApi` core (`src/shared/apiClient.ts`) — the same forward path as the `orca api` CLI verb, so a new REST endpoint works in both with zero edits.

### `orca api` CLI passthrough

Agents (including the assistant) can also drive Orca without MCP via `orca api <METHOD> <path> [jsonBody]`. It reads `ORCA_URL`/`ORCA_TOKEN` from the environment the daemon injects into every spawned agent, so it reaches any endpoint without a per-endpoint CLI command. The assistant prompt (`prompts/advisor.md`) advertises both paths.

### Access

The advisor session is per-user, not project-scoped: only its owner (or an admin) may reach it via the session routes, and a user need not be assigned to the daemon's project to reach their own advisor. The advisor's token is a fourth scope (`advisor`, stored alongside `full`/`agent`) — isolated so rotating/stopping the advisor never touches login tokens.
