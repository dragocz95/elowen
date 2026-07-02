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

1. Prompt template with `{{goal}}`, `{{project}}`, and `{{models}}` placeholders is rendered
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

**Auto-model per-phase picking:**
When `autoModel: true` is passed, the `{{models}}` placeholder is replaced with a block listing
every enabled model that has a non-empty `modelNotes` description. The planner is instructed to
pick the best model per phase and include an `exec` field on each phase object. The `modelsBlock()`
helper in `src/overseer/planner.ts:44` renders the block — only models in `allowedExecs` with a
non-empty note are listed. When no models qualify, the block is empty and phases fall back to the
configured default exec. Both relay and Pilot backends support `autoModel`.

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

Per-mission FIFO in `src/overseer/decisionQueue.ts` with four decision kinds:

| Kind | Enqueued by | Context |
| `task` | Mission engine tick | Task title, description, labels |
| `prompt` | Deriver | Permission prompt question, context, options |
| `review` | PATCH close handler (post-done) | Task title, outcome, summary |
| `question` | Deriver | Multiple-choice question with options |

Every enqueued decision is **guaranteed to settle**: by the agent, by a 120s timeout (conservative escalate), or by `drain()` when the mission disengages (all pending decisions escalate).

### Centralized gate

`gateVerdict()` in `src/overseer/decision.ts:28` applies a configurable confidence threshold (default 0.6) centrally for both task and prompt decisions — neither the relay path nor the parked overseer can override the threshold. The threshold is per-autonomy: L1 (Assist) passes `minConfidence: 0.85` via `minConfidenceFor()`, L2/L3 use the default 0.6. The local destructive heuristic (`isDestructive()`, applied at enqueue time) is **always authoritative**: even if the overseer approves, a destructive verdict cannot be overridden.

---

## Async planning jobs

When `POST /tasks/plan` uses the autopilot relay or Pilot backend, planning is asynchronous:

1. Returns `202 Accepted` with a `jobId`
2. A `plan` SSE event is emitted immediately: `{jobId, status:'planning'}`
3. The web UI polls `GET /plan/:jobId` (every 1s while status is `planning`)
4. On success, `finalizePlanJob()` persists the epic + phases, emits a `plan` SSE event: `{jobId, status:'done', epicId, phases}`
5. On failure, emits `{jobId, status:'failed', error}` — the UI shows the error
6. The Pilot agent path: spawns `pilot-<name>` in the repo → reads codebase → calls `POST /plan/:jobId/submit` → the route calls `parsePhases()` using the same validator as the relay path (DRY) → `finalizePlanJob()`

When `autoModel: true` is set on the plan job, the `{{models}}` block is injected into both the
relay planner prompt and the Pilot agent prompt. Each phase may carry a per-phase `exec` field
that the planner chose. On persist, the daemon validates the picked exec against `allowedExecs`
and silently drops hallucinated models so the task falls back to the configured default.

Job storage is in-memory (`PlanJobStore` in `src/overseer/planJob.ts`). Jobs are scoped to the project of the requesting user and access-gated. The Pilot agent has its own ungessable job ID and `agent` token scope — it never needs project-level access beyond its assigned job.

`GET /plan/:jobId` is accessible to:
- Interactive users (project access gate)
- The Pilot agent (via `tokenScope === 'agent'`)

### Live pilot preview (agent-mode only)

After spawning the Pilot, `makePilot` calls `planJobs.setSession(job.id, session)` to record the tmux session name on the `PlanJob` (`src/overseer/pilotAgent.ts`). This requires `planJobs: PlanJobStore` as a dependency, injected in `bootstrap.ts`.

`GET /plan/:jobId` now includes `sessionName` in its response, so `usePlanJob` populates the field. The SSE `plan` handler in `useOrcaEvents` merges it carefully:

```typescript
sessionName: data.sessionName ?? prev?.sessionName,
```

A `planning` SSE event carries no `sessionName` (it fires before the Pilot is even spawned); the fallback keeps whatever was written by a prior GET poll. This prevents the live-preview pane from disappearing mid-session.

When `planJob.data?.sessionName` is set, `TaskModal` renders a `LiveTail` component below the planning spinner — the user watches the planner think instead of staring at a static loader. Relay-mode planning is synchronous and has no tmux session, so the pane stays hidden there.

---

## Deriver: prompt detection & resolution

The deriver (`src/deriver/deriver.ts`) polls every live `orca-*` tmux pane every 5s, detecting agent state changes from terminal output.

### Prompt detection (`src/deriver/shellPatterns.ts`)

| Program | Gate detected | Trigger text | Action |
|---|---|---|---|---|
| OpenCode | Permission required | `Permission required` + Allow/Reject buttons | L1–L3: overseer decides (L1 at 0.85 bar, L2/L3 at 0.6); L0: escalate |
| Claude Code | Workspace trust | `Yes, I trust this folder` | **Auto-accepted** (autoAccept) — orca only spawns into registered projects |
| Claude Code | Permission | `Do you want to proceed?` | L1–L3: overseer decides (L1 at 0.85 bar, L2/L3 at 0.6); L0: escalate |
| Codex | Command approval | `Allow command?` / `Approve this command?` | L1–L3: overseer decides (L1 at 0.85 bar, L2/L3 at 0.6); L0: escalate |

`autoAccept` prompts are cleared directly by the deriver under L1+ autonomy without an overseer round-trip — workspace-trust gates just block startup and don't represent a real action risk.

### Resolution flow

For L1–L3 (and manual, mission-less) sessions:
1. Detect prompt via `detectAgentPrompt(output, program)`
2. If `autoAccept`: send `acceptKeys` (e.g., Enter) directly
3. Otherwise: send through overseer gate (`decideApproval`) with the autonomy level:
   - Agent path: enqueue `prompt` decision → parked overseer judges → settle
   - Relay path: `decidePrompt()` inline via relay LLM → gate through `gateVerdict()` with per-autonomy `minConfidence`
4. On approve + non-destructive: send `acceptKeys`; mark status `working`
5. On deny or destructive: emit `needs_input` signal → human must approve in UI

The confidence threshold is per-autonomy: L1 (Assist) requires 0.85, L2/L3 use 0.6. This is the single behavioral difference between L1 and L2 — both auto-spawn and both route prompts through the overseer, but L1 holds the bar higher so only clearly-safe steps auto-clear.

For L0: always escalate to human (`needs_input` signal).

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

Guardrails were removed in v1.1.1. The regex-based safety check system (`detectGuardrails`, `isCleared`, `cleared_guardrails`) was eliminated because it caused missions to stall silently when descriptive phase titles triggered false-positive matches. The `cleared_guardrails` column remains in the schema for backward compatibility but is no longer enforced.

The **overseer decision gate** (relay LLM or parked agent) still provides a safety layer for permission prompts and task dispatch. The decision engine's local destructive heuristic (`isDestructive()`) catches dangerous operations (rm -rf, DROP TABLE, curl | sh, eval, etc.) at enqueue time and is authoritative.

### Separate destructive check

The overseer decision engine has its own destructive heuristic (`DESTRUCTIVE` regex in `src/overseer/decision.ts:42`) that catches `rm -rf`, `DROP TABLE`, `DELETE FROM`, `TRUNCATE`, `git push -f`, `chmod 777`, `curl | sh`, `eval`, `exec(`, and more. This is applied at decision enqueue time and is authoritative — neither the relay LLM nor the parked overseer can override it.

---

## Scheduled task launch

Tasks can be scheduled for future execution via the `scheduled_at` ISO-8601 field combined with `autostart`.

### Flow

1. Task created with `scheduled_at: "2026-06-20T10:00:00Z"` and `autostart: 1`
2. `Scheduler.tick()` runs every 30s, finds due tasks across all projects
3. Schedule is consumed (set to `null`) so it fires exactly once
4. The schedule is restored on spawn failure so the next tick retries

### Autonomy gate

Unlike the mission engine, the scheduler has no autonomy level and no overseer in the loop. Tasks are launched directly when their schedule is due.

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
- Multiple labels can coexist (exec + agent + stuck counter)

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

---

## Inter-agent handoff notes

Agents working on the same mission can leave free-form handoff notes for later phases. This is the primary mechanism for passing context between sequential agents — each phase's agent reads what the previous one left and writes its own findings for the next.

### CLI usage

```bash
# Leave a note for the next phase
orca note add orca-294192e5 "I set up the KeyedMutex in src/shared/keyedMutex.ts — reuse it for any per-checkout serialization."

# Read all notes left by earlier phases (oldest-first)
orca note ls orca-294192e5
```

The target is the epic ID (or mission ID with `m-` prefix — both work). Notes are scoped to `mission` by default.

### API

```http
GET /notes?scope=mission&target=<epicId>
Authorization: Bearer <token>
```

```http
POST /notes
Authorization: Bearer <token>
Content-Type: application/json

{
  "scope": "mission",
  "target": "<epicId>",
  "body": "Key files to watch: src/overseer/checkout.ts, src/shared/keyedMutex.ts",
  "author": "Nova"
}
```

### Limits

| Limit | Value | Rationale |
|---|---|---|
| Body size | 8 000 characters | A handoff note is a hint, not a document dump |
| Notes per target | 200 | Bounds the per-mission log so a looping agent can't inflate the DB |

### Access control

Notes are access-gated by the target epic's project. An agent can only read/write notes for a mission in a project it is actively working in. An orphaned note (epic deleted) can never be read — the target must resolve and be allowed, or the endpoint returns `404`.

### Purging

Notes are purged when the epic is deleted (`DELETE /tasks/:id`). This prevents orphan notes from outliving their access-control anchor.

### Agent prompt integration

The worker prompt templates instruct agents to:
1. Read existing notes with `orca note ls <missionId>` at the start of a phase
2. Leave a handoff note with `orca note add <missionId> "<key findings>"` before closing

This is the standard pattern for sequential mission phases — each agent builds on the previous one's context.

---

## Per-task change snapshots

When a task closes, the daemon freezes the list of files the task's agent committed. This gives you a permanent record of what each phase changed, viewable in the web UI and queryable via the API.

### How it works

1. **At spawn**: the mission engine stamps a `base:<sha>` label on the task — the current `HEAD` in the agent's checkout. This is done under the `KeyedMutex` so it lands after any in-flight commit from a just-closed phase.
2. **At close**: `snapshotTaskChanges()` reads the new `HEAD` and computes `git diff base..HEAD --name-only`. The file list, `base_sha`, and `head_sha` are stored on the task row.
3. **Viewing**: `GET /tasks/:id/changed/diff?path=<file>` returns the diff of a single file from the frozen range.

### API

```http
GET /tasks/orca-abc123/changed/diff?path=src/overseer/checkout.ts
Authorization: Bearer <token>
```

Response:
```json
{ "diff": "diff --git a/src/overseer/checkout.ts b/src/overseer/checkout.ts\n..." }
```

Empty `{ "diff": "" }` when:
- The task has no snapshot (hand-closed, no baseline)
- The file isn't in the change list
- The refs were GC'd by a later squash or rebase

### Close paths

Snapshots are taken on three code paths in the `PATCH /tasks/:id` handler:

| Path | When | Locking |
|---|---|---|
| Review gate | `reviewOnDone` + overseer → commit+snapshot on *approval* verdict | Under `gitLock.run()` |
| Direct close | Mission phase, no review gate → commit+snapshot immediately | Under `gitLock.run()` |
| Standalone task | No mission → snapshot only (no phase commit) | Under `gitLock.run()` |

The review path commits only on approval — a rejected phase never commits, so its snapshot is never taken.

### KeyedMutex serialization

All git operations on one checkout are serialized through a `KeyedMutex` (`src/shared/keyedMutex.ts`). The baseline read at spawn and the commit+snapshot at close must not interleave across agents sharing a working tree, or a task's frozen change range could straddle another's commit. The mutex is per-checkout-path (FIFO), so different checkouts run concurrently.

### Edge cases

- **No baseline** (`base:<sha>` label missing): the task was hand-closed or never spawned by the engine — no snapshot stored.
- **No commits** (`base == head`): the diff is empty — the task made no changes.
- **Non-repo / no HEAD**: `projectHead()` returns null → early return.
- **Git failure**: caught and logged; the close proceeds without a snapshot (best-effort).
- **GC'd refs**: a later squash or rebase may invalidate the stored SHAs — the diff endpoint returns `{ diff: '' }`.

---

## Session resume

When a provider's `resume` toggle is on (Settings → Providers), the daemon captures the agent's CLI session ID at close and splices a resume flag into the next spawn command. The agent reattaches to its prior conversation with full context instead of cold-starting.

### Provider configuration

In Settings → Providers, each program has a `resume` toggle (default on). When off, the daemon never captures or applies resume labels for that program — every spawn is a cold start.

### Label lifecycle

```
Task closes/cancelled
  → UsageRecorder calls captureResumeLabel()
    → detectSessionId() reads the CLI's local session store
    → stamps resume:<program>:<sessionId> label on the task

Task re-spawns (stuck detector revert, or next mission phase)
  → Mission engine calls parseResumeLabel(task.labels)
    → SpawnService validates: program matches + provider allows resume
      → buildAgentCommand() splices resume flag into launch command
```

### Per-program mechanisms

| Program | Flag | Placement | Example |
|---|---|---|---|
| `claude-code` | `--resume <id>` | `flag` (after bypass, alongside `--model`) | `claude --dangerously-skip-permissions --resume abc123 --model sonnet "..."` |
| `opencode` | `-s <id>` | `flag` (after binary, alongside `--model`) | `opencode -s abc123 --model deepseek-v4-pro --prompt "..."` |
| `codex` | `resume <id>` | `subcommand` (before bypass flag) | `codex resume abc123 --dangerously-bypass-approvals-and-sandbox --model gpt-5.5 "..."` |

The `placement` field controls where the resume tokens land:
- `subcommand` — immediately after the binary, before any flags.
- `flag` — after the binary/bypass flag, alongside `--model`.

### Resume prompt

A resumed agent receives a short continuation prompt (`worker-resume`) instead of the full worker preamble. It already holds the full goal and what it did — re-injecting the whole preamble would make it restart from scratch. The resume prompt tells it to pick up where it left off, fold in any new input, then close.

### Stuck detector integration

When the stuck detector reverts a dead agent to `open`, it calls `onReap(task)` before the revert. This callback runs `captureResumeLabel()` to stamp the dead agent's CLI session as the task's `resume:` label. The next spawn then resumes that session — the crash left a partial session on disk that still carries useful context. The capture is best-effort: a detection miss never blocks the reap.

### Adding a new resume provider

1. Create a module in `src/spawn/resume/` implementing `ResumeProvider`:
   ```typescript
   export const myCliResume: ResumeProvider = {
     program: 'my-cli',
     resumeArgs: (sessionId) => ({ args: ['--continue', sessionId], placement: 'flag' }),
   };
   ```
2. Register it in `src/spawn/resume/index.ts` under `RESUME_PROVIDERS`.
3. Add session-id detection next to the usage parser in `src/integrations/usage/`.

---

## Checkout serialization

A shared project checkout is single-writer: only one agent may edit it at a time. This keeps each task's committed delta cleanly attributable — `base..HEAD` never straddles another agent's commit, and `git add -A` never sweeps in a neighbour's edits.

### How it works

The mission engine's tick loop performs a **check-and-claim** for each ready task:

1. Resolve the task's working directory via `checkoutOf()` — a PR mission's isolated worktree, else the shared project path.
2. Read the occupied set **fresh** at each claim (not a tick-start snapshot) — the engine and scheduler tick concurrently.
3. Call `checkoutBusy()` synchronously, immediately before flipping the task to `in_progress`.
4. No `await` between the check and `setStatus(task.id, 'in_progress')` — the check-and-claim is atomic.

If the checkout is busy, the engine `break`s out of the ready-task loop — the phase stays `open` and retries on the next tick.

### 409 response

The API endpoint that spawns a standalone task also checks `checkoutBusy()`:

```json
{ "error": "checkout busy" }
```

HTTP status `409 Conflict`. The caller should retry later.

### PR worktree exclusion

PR-native missions run in isolated git worktrees (`<repo-parent>/.orca-worktrees/<slug>-<missionId>`). These are per-mission — a different mission or standalone task never collides with them. `busySharedCheckouts()` skips them entirely, so PR missions never block each other or the shared checkout.

### KeyedMutex

A `KeyedMutex` (`src/shared/keyedMutex.ts`) serializes git operations on one checkout:

```typescript
class KeyedMutex {
  run<T>(key: string, fn: () => Promise<T>): Promise<T>;
}
```

Calls sharing a key run strictly one-at-a-time (FIFO), while different keys run concurrently. Used to serialize:
- The baseline read at spawn (`markBase()`)
- The commit+snapshot at close (`commitPhase()` + `snapshotTaskChanges()`)

A throwing `fn` never wedges the chain — the next waiter still runs. Keys with no pending work are dropped so the map can't grow without bound.

### CheckoutResolver

The `CheckoutResolver` interface provides two functions that the engine uses to map tasks to checkouts:

```typescript
interface CheckoutResolver {
  projectPath: (projectId: number) => string;
  worktreeFor?: (missionId: string) => string | null | undefined;
}
```

`checkoutOf()` delegates to `usagePath()` — the same logic used for token-usage path resolution — so a task's working directory is always consistent between the spawn, the usage recorder, and the snapshot.

---

## Brain plugins (Discord, cron, memory, skills)

Orca's embedded **brain** — the in-process chat assistant behind the web dock and `orca chat` — is
extensible through a lightweight plugin system. Each plugin is a self-contained Node ESM module
under `plugins/<name>/`, hand-written with no build step, paired with an `orca-plugin.json`
manifest that declares a config schema and what the plugin `provides` (tools, chat platforms,
skills). Plugins are either **bundled** (ship with Orca) or **user-installed** (dropped into the
instance's own plugin directory); either way they're discovered by `discoverPlugins()` and
toggled per-instance in **Settings → Plugins**. Enabling/disabling or saving a plugin's config
calls `BrainService.reloadPlugins()`, which drops the memoized plugin registry and restarts every
live brain session — the change applies to running conversations immediately, no daemon restart.

A plugin's `register(ctx)` function gets a context exposing `ctx.registerTool()` (adds a tool to
the brain's toolset), `ctx.registerPlatform()` (adds a chat-platform adapter — see Discord below),
`ctx.registerSkill()`, `ctx.dataDir()` (a writable per-plugin data directory), `ctx.isAdminSession()`
and `ctx.currentIdentity()` (who's driving the current turn), and `ctx.config`/`ctx.logger`.

### Discord bot (`plugins/discord/`)

A dependency-free Discord Gateway client (Node's built-in `WebSocket` + `fetch`, no discord.js):
connects over the v10 gateway, resumes on reconnect, and answers channel messages by handing them
to the brain as a **channel session** (`brain-ch-<platform>-<channelId>`) — a conversation that
persists per channel/thread, separate from any user's own chat.

- **Slash commands** — `/model` (pick the AI model for this channel), `/thinking` (reasoning
  effort for this channel), `/new` (start a fresh conversation — bumps a per-channel generation
  counter so the session key changes), `/help`.
- **Operator-only pickers** — `/model` and `/thinking` change a setting **shared by everyone
  talking in that channel**, so both are gated to the operator: a member whose Discord role maps
  to a `rolePolicies` entry with `admin: true` (checked via `memberIsAdmin()`/`isAdminMember()`).
  Anyone else gets a "only the operator can change this here" reply. The choice persists in a
  small per-channel JSON store (`channel-state.json` in the plugin's data dir) and survives across
  gateway reconnects and daemon restarts — it is *not* reset by `/new` (only the conversation
  generation is).
- **Runtime footer** — `footerLine()` appends a Hermes-style `-# model · NN %` subtext under the
  final reply, sourced from the turn's `idle` event (model id + context-window fill). Config
  `runtimeFooter` (default on) opts out.
- **History backfill** — config `historyLimit` (0–100, default off) loads that many recent channel
  messages as context, but **only** the first time a brand-new conversation starts (`fetchHistory()`
  is called lazily via `src.history()`); an ongoing conversation never re-fetches. The block is
  hard-framed as untrusted background data the brain must never treat as instructions, guarding
  against a planted `"SYSTEM: …"` line in channel history steering a privileged session.
- **Vision model** — config `visionModel`: an image-bearing turn is steered to this model
  regardless of the channel's normal pick (a channel's default model may be text-only).
- **Service language** — config `language` (`en` default, or `cs`): only affects the bot's own
  service texts (slash-command replies, "thinking…" placeholders) — the brain's actual answers
  are always in whatever language the user wrote in.
- **`discord_api` tool** — raw Discord REST access (any method/path) for server management
  (delete/purge messages, manage roles, edit channels). Gated to the true **owner** (`identity.owner
  === true`), not merely `admin: true` — a foreign member holding an admin-mapped role must never
  reach the raw bot token.
- **Role policies** (`rolePolicies` config, structured editor in Settings) — each row maps a
  Discord role id to a name, the Orca `projectIds` it may touch, an extra system-prompt fragment
  (`rolePrompt()` — the Hermes role-instructions pattern), an optional tool allowlist, and the
  `admin` flag. The **first matching role wins**; a sender with no mapped role (and any DM, which
  carries no roles at all) is silently ignored — no REST/CDN work is spent on strangers.
- Also handles: live streaming replies (edit-in-place with a tool-call trace, throttled to
  Discord's ~5-edits/5s limit), status reactions (👀 → ✅/❌), image attachments (downloaded +
  base64 for vision, capped at 4 images / 5 MB each), generated-image uploads (tool-produced PNGs
  become real Discord file attachments, not dead relative links), and a thread allowlist
  (`threadIds` config) to scope the bot to specific threads only.

### Cron plugin (`plugins/cronjob/`)

Recurring or one-shot prompts for the brain — the Hermes cronjob-tools idea sized for Orca. Jobs
persist in the plugin's own `jobs.json`; a scheduler adapter ticks every 30 s and, when a job is
due, feeds its prompt back into the brain with `admin: true` access (only an admin session can
create a job in the first place, via the `cron_add`/`schedule_wakeup` tools).

- **Schedule formats** — recurring: `"every <N>m"`, `"every <N>h"`, `"daily HH:MM"`,
  `"weekly <mon..sun> HH:MM"`. One-shot wake-up: `"in <N>m"`, `"in <N>h"`, `"at HH:MM"` — the job
  removes itself after firing once.
- **Active-hours window** — an optional `"H-H"` guard (e.g. `"5-21"`, supports an overnight
  wrap like `"22-5"`) that keeps a recurring job quiet outside those hours.
- **Per-job model** — an optional model override; the job's channel session respawns on it
  instead of the brain's configured default.
- **Target channel** — `notifyChannelId` routes a job's result to a specific Discord
  channel/thread instead of the plugin's configured default notification channel.
- **Silent jobs** — a job whose reply is exactly `NOTHING_TO_REPORT` (or the Hermes-era
  `[SILENT]`, leniently matched even wrapped in backticks/bold) is treated as "nothing to say" and
  never posted — so a routine check-in job doesn't spam the channel every time there's no news.
- **Live editing** — Settings → Plugins → cronjob (`CronJobsEditor`) edits the whole job list as
  one auto-saved `PUT /plugins/cronjob/jobs`; the scheduler re-reads the file every tick, so
  changes apply live. The editor whitelists persisted fields and preserves `lastRun`/`lastResult`
  from disk (never trusts the client's stale snapshot), and arms a job that just became enabled
  from the save moment — so it waits for its next natural slot instead of firing immediately.
  Model and destination are clickable pills (first N shown, "+N more" expander); the channel
  picker excludes forum-post threads (only real text channels and their threads are valid
  destinations). A job's `lastResult` (its last reply, truncated) shows once it has fired.

### Memory (`plugins/memory/`)

Durable, cross-conversation memory backed by a self-hosted **mem0** REST server (the same shape
Hermes uses) — the brain decides *what* to remember via `add_memory`/`search_memory`; the plugin
only ferries the calls.

- **Per-user identity** — `memoryUser()` resolves the mem0 `user_id` for the current turn: the
  **operator** (the true owner, not merely an `admin`-flagged role) keeps the configured owner id
  (continuity with any pre-Orca memory store, config `userId`, default `orca`). Everyone else gets
  their **own namespaced store** so they can never read or pollute the operator's memory: a sender
  whose platform account is linked to an Orca account gets `orca:<username>`; an unlinked sender
  gets `<platform>:<id>` (e.g. `discord:123456789012345678`).
- **Linking a Discord account** — set your Discord user id in **Account → CLI** (`discordUserId`).
  Once linked, the brain resolves your Discord messages to your Orca account (`resolvePlatformUser()`),
  giving your Discord turns a verified identity line and routing your memory through your own
  `orca:<username>` store instead of an anonymous `discord:<id>` one.

### Skills (`plugins/skills/`)

A bundled reference plugin exposing Markdown skills to the brain — hand-written ESM with no build
step, so it also doubles as the canonical example plugin format. It loads `.md` skills from its
own `skills/` directory (bundled) plus the instance's writable plugin data dir (user-created), and
registers each so the brain's system prompt advertises it.

- **Bundled vs user** — bundled skills ship with the plugin and are read-only; user skills are
  created via the `create_skill` tool (admin-only) or the **Settings → Plugins → skills** editor,
  and can be deleted (bundled ones cannot). A user skill name may not shadow a bundled one.
- **Format** — a skill is one Markdown file with a small YAML-ish frontmatter (`name`,
  `description`) followed by the instruction body.
- **Applying changes** — creating/deleting a skill hot-reloads the plugin registry, so **new**
  conversations pick it up immediately; a conversation already in progress keeps its original
  system prompt until it restarts.
