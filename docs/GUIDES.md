# Guides

Collection of advanced architecture patterns, internal mechanisms, and
integration knowledge.

---

## Task ↔ session binding

Tasks don't store a direct reference to their tmux session. The binding is
inferred from task labels via the `agent:<name>` convention.

### How it works

1. Task gets an `agent:<name>` label when spawned (e.g. `agent:SwiftLake0`)
2. The tmux session is named `orca-<name>` (e.g. `orca-SwiftLake0`)
3. To find a task's session: extract `agent:<name>` from labels → prepend `orca-`
4. To find a session's task: strip `orca-` prefix → agent name → associated task

### Session lifecycle

```
spawn → create agent row (name, program, model, project_id) → create tmux session
  → task is in_progress → agent finishes → task closed/cancelled
  → janitor kills session → agent row stays for audit
```

### Live session detection

The web UI checks if a session is actually alive (not just `in_progress`):

```typescript
const isLive = liveSessions.includes(`orca-${agentName}`);
```

---

## Goal decomposition (autopilot planning)

`POST /tasks/plan` decomposes a goal into ordered phases, creating an epic
with sequentially chained child tasks.

### Planning modes

#### Relay backend (API key configured)

The planner model receives the prompt template and returns a JSON array of
3–7 phases. Each phase becomes a task, sequentially chained via `task_deps`.

Requires an API key. Returns `autopilot_key_missing` (400) without one.

#### Pilot backend (CLI Agent)

When `config.autopilot.pilotExec` is set, a **Pilot agent** spawns in the
project repo. The Pilot reads the codebase, decomposes the goal using the
prompt from `prompts/pilot.md`, and submits structured phases via
`orca plan submit --phases '<json>'`.

Returns `202 Accepted` with a `jobId`. The web UI polls `GET /plan/:jobId`.

#### Manual mode (no LLM)

Pass `phases: [{title, type?}]` directly — no LLM, no API key. Synchronous
`201` response.

### Auto-model per-phase picking

When `autoModel: true` is passed, the planner picks the best model per phase
from model descriptions (`config.modelNotes[exec]`). Each phase may carry a
per-phase `exec` field that is validated against `allowedExecs`.

### Replanning mid-mission

`POST /tasks/:epicId/phases` with a `goal` decomposes a residual goal into
new phases that append after the epic's current chain.

### Plan prompt storage

Project notes are fed to the planner and Pilot as project context via the
`{{project}}` placeholder.

---

## Overseer (decision gate)

The overseer vets actions before they execute. Two decision paths:

### Relay path (default)

`overseerExec` is empty → decisions go through `RelayClient` using
`config.autopilot.overseerModel`. When the LLM is unavailable, responses
default to blanket reject.

### Agent path (parked overseer)

`overseerExec` is set → one Overseer agent is parked per active mission. It
runs a long-poll loop:

1. `orca overseer poll` — absorb heartbeats, surface decisions
2. Judge the request using `prompts/overseer.md`
3. `orca overseer decide --id <id> --approve --confidence 0.85` — submit verdict

The agent path is fully async. A 120-second timeout escalates if the overseer
doesn't respond.

### DecisionQueue

Per-mission FIFO with four decision kinds:

| Kind | Enqueued by | Context |
| `task` | Mission engine tick | Task title, description, labels |
| `prompt` | Deriver | Permission prompt question |
| `review` | PATCH close handler (post-done) | Task title, outcome, summary |
| `question` | Deriver | Multiple-choice question |

Every decision is guaranteed to settle: by the agent, by 120s timeout, or by
`drain()` when the mission disengages.

### Centralized gate

`gateVerdict()` applies a configurable confidence threshold (default 0.6).
L1 (Assist) passes `minConfidence: 0.85`, L2/L3 use the default 0.6. The
destructive heuristic (`isDestructive()`) is always authoritative.

---

## Deriver: prompt detection & resolution

The deriver polls every live `orca-*` tmux pane every 5 seconds.

### Prompt detection

| Program | Detects | Trigger text |
|---------|---------|-------------|
| OpenCode | Permission required | `Permission required` + Allow/Reject |
| Claude Code | Workspace trust | `Yes, I trust this folder` (auto-accepted) |
| Claude Code | Permission | `Do you want to proceed?` |
| Codex | Command approval | `Allow command?` / `Approve this command?` |

### Resolution flow

1. Detect prompt via `detectAgentPrompt(output, program)`
2. If `autoAccept`: send accept keys directly
3. Otherwise: route through overseer gate with autonomy level
4. On approve + non-destructive: send accept keys
5. On deny or destructive: emit `needs_input` signal → human must approve

### Signals

| Signal | Meaning |
|--------|---------|
| `working` | Agent is active, no prompt detected |
| `needs_input` | Agent is paused, needs human intervention |
| `complete` | Task is closed |

---

## Guardrails

Guardrails (regex-based safety checks) were removed in v1.1.1. The overseer
decision gate provides the safety layer. The destructive heuristic in
`decision.ts` catches `rm -rf`, `DROP TABLE`, `git push -f`, `curl | sh`,
`eval`, and more — applied at enqueue time, authoritative.

---

## Scheduled task launch

Tasks with `scheduled_at` + `autostart` fire on the 30-second scheduler tick.
The schedule is consumed so it fires exactly once. A per-project burst cap
(default 5) prevents parallel agent floods.

---

## Stuck detector

Sweeps every 60s for `in_progress` tasks with no live agent session.
Grace period: 120s. Up to 2 relaunch attempts, then escalates to `blocked`.
Also runs at daemon startup to clean zombie tasks.

---

## Post-done review

When `config.autopilot.reviewOnDone` + `overseerExec` are set, closing a
mission phase triggers a review decision. If negative, dependent phases are
blocked. Non-blocking — the agent's close response is immediate.

---

## Checkout serialization

Only one agent may edit a shared project checkout at a time. The engine
checks and claims atomically (no `await` between check and status flip).
PR missions use isolated git worktrees, so they never block each other or the
shared checkout.

A `KeyedMutex` serializes git operations on one checkout (base read, commit,
snapshot). Different checkouts run concurrently.

---

## Change snapshots

When a task closes, the daemon freezes the list of files the agent committed:

1. At spawn: `base:<sha>` label stamped on the task
2. At close: `git diff base..HEAD --name-only` stored on the task
3. Viewing: `GET /tasks/:id/changed/diff?path=<file>` returns the diff

---

## Session resume

When resume is on per provider, the daemon captures the CLI session ID at
close and splices a resume flag into the next spawn command. Per-program:

| Program | Flag | Placement |
|---------|------|-----------|
| Claude Code | `--resume <id>` | After bypass, alongside `--model` |
| OpenCode | `-s <id>` | After binary, alongside `--model` |
| Codex | `resume <id>` | Before bypass flag |

---

## Event store

All state changes recorded in SQLite `events` table:

| Event | When | Payload |
|-------|------|---------|
| `task` | Created, status changed, deleted | task ID + new status |
| `mission` | Engaged, paused, resumed, disengaged, stalled | mission ID + state |
| `signal` | Deriver detected state change | session + signal type |
| `plan` | Plan job status | job ID + status |

Retention: 30 days. Purged hourly.

---

## Task executor in labels

Executors are stored as `exec:<spec>` labels rather than a DB column.
Resolution in `src/shared/execs.ts` — single source of truth for program
prefixes, known execs, and validation.

---

## Inference client interface

Minimal LLM backend interface:

```typescript
interface InferenceClient {
  decide(prompt: string): Promise<{ text: string }>;
}
```

Implementations:

| Implementation | Purpose |
|---------------|---------|
| `RelayClient` | Production — OpenAI-compatible API |
| `FakeInference` | Tests — predictable responses |

Consumed by: Planner (decompose), Overseer (decidePrompt, decideTask).

---

## Handoff notes

Agents working on the same mission leave notes for later phases:

```bash
orca note add <missionId> "Key findings from this phase..."
orca note ls <missionId>    # read all, oldest first
```

Limits: 8 000 chars per note, 200 notes per target.

---

## Brain plugins

Brain plugins extend Orca with tools, platforms, skills, and context
providers. See [PLUGIN_DEV.md](PLUGIN_DEV.md) for how to write them.

### Plugin lifecycle

1. **Discovery** — `discoverPlugins()` scans plugin directories
2. **Load** — manifest parsed, entry point imported
3. **Register** — `register(ctx)` called with the plugin context
4. **Use** — tools, platforms, skills registered with the brain
5. **Hot-reload** — toggle or config change → reload plugins, restart brain
   sessions

### Hook bus

Plugins can register capability-gated hooks:

- **Context hooks** — inject per-turn context (e.g. runtime-context plugin)
- **Execution hooks** — audit tool calls (bounded ring buffer)
- **Notification hooks** — proactive push (e.g. cron results to Discord)

### Per-plugin data

Each plugin gets a writable data directory (`ctx.dataDir()`) for persistent
state (e.g. cron jobs in `jobs.json`, Discord channel state).
