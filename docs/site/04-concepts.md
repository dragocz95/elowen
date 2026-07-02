---
title: Concepts
slug: concepts
order: 4
eyebrow: Domain model
---

# Concepts

The domain model behind Orca: tasks, missions, autonomy, the overseer gate, agent
routing, and the supporting systems that keep autonomous runs observable and safe.

## Tasks

A **task** is a unit of work. Tasks form a tree via `parent_id` — an epic (root task)
contains sub-tasks. Tasks can also declare dependencies (`task_deps`) that must be closed
before the task becomes ready.

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

Blocked tasks are excluded from readiness so the engine tick skips them. A human must
manually unblock (set back to `open`) to retry.

### Labels

Tasks carry string labels used for routing and bookkeeping:

- `exec:<spec>` — route to a specific agent executor (e.g. `exec:sonnet`, `exec:codex:gpt-5.5`).
- `agent:<name>` — pin a specific agent name for this task's session (`orca-<name>`).
- `started:<epoch-ms>` — precise spawn timestamp for correct usage attribution under concurrency.
- `stuck:<n>` — relaunch counter; bounds re-spawns and eventually escalates.
- `base:<sha>` / `head:<sha>` — the HEAD at spawn and at close; together they freeze the task's change list.
- `resume:<program>:<sessionId>` — lets the next spawn continue the agent's prior CLI session instead of cold-starting.

### Readiness

A task is **ready** when it is `open`, not an epic, and every one of its dependencies is
`closed` or `cancelled`. Readiness is computed at query time — across a project, or scoped
to one epic's direct children so parallel missions don't walk each other's tasks.

### Per-task change snapshots

When a task closes, the daemon freezes the list of files the task's agent committed. At
spawn the current `HEAD` is stamped as a `base:<sha>` label; at close it reads the new
`HEAD` and computes `git diff base..HEAD --name-only` in the agent's checkout (the mission
worktree in PR-native mode, else the shared project checkout). The file list is stored on
the task row and exposed for the per-task diff viewer. It is empty when the task has no
baseline (hand-closed), made no commits, or the refs were GC'd by a later squash.

### Session resume

When a provider's `resume` toggle is on, the usage recorder stamps a
`resume:<program>:<sessionId>` label at close. On the next spawn the resume flag is spliced
into the agent's launch command so it continues its prior conversation:

| Program | Resume mechanism |
|---|---|
| `claude-code` | `--resume <sessionId>` flag |
| `opencode` | `-s <sessionId>` flag |
| `codex` | `resume <sessionId>` subcommand |

The resume is applied only if the program still matches and the provider allows it. The
stuck detector also captures a dead agent's session before reverting a stuck task, so the
relaunch continues the crashed-but-persisted context. A resumed agent receives a short
continuation prompt instead of the full worker preamble.

### Inter-agent handoff notes

Agents working the same mission can leave free-form handoff notes for later phases via
`orca note add <missionId> "<text>"`. Notes are scoped to a mission (epic) and access-gated
by the epic's project; the next agent reads them with `orca note ls <missionId>`
(oldest-first). The body is capped and a target is capped at a fixed note count, and notes
are purged when the epic is deleted so they never outlive their access-control anchor.

## Missions

A **mission** groups tasks under an epic for autonomous execution. The mission engine ticks
active missions, picks each epic's ready tasks, and spawns agents up to `max_sessions`. The
Overseer is not consulted at dispatch — it gates the agents' permission prompts (via the
Deriver) and optional post-phase reviews.

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

### Engine tick

The tick loop runs every 90 seconds, one tick per active mission:

1. Load the mission, its epic, and its project.
2. If all children are `closed`/`cancelled` → auto-disengage.
3. Count running = this epic's own `in_progress` children.
4. Walk the epic's ready (dependency-cleared) children; for each, while `running < max_sessions`:
   - Skip if autonomy is L0 (Recommend — plan only, no spawn).
   - L1–L3: resolve the executor from labels, pick an agent name, set `in_progress`, spawn via tmux.
5. Detect stalled: zero running + any blocked child → mark `stalled`; resumed work → `active`.

## Autonomy levels

| Level | Name | Auto-spawn | Prompt gate | Confidence bar |
|---|---|---|---|---|
| L0 | Recommend | Never | Always escalate to human | — |
| L1 | Assist | Yes | Overseer gate (stricter) | 0.85 |
| L2 | Pilot | Yes | Overseer gate (standard) | 0.6 |
| L3 | Auto | Yes | Overseer gate (standard) | 0.6 |

- **L0** — the engine never auto-spawns; the deriver escalates every detected prompt to a human.
- **L1** — auto-spawns ready tasks; prompts route through the overseer with a **stricter** 0.85
  confidence threshold. This is the key difference from L2 — not *whether* prompts are gated, but how strictly.
- **L2 / L3** — auto-spawn ready tasks; prompts route through the overseer at the standard 0.6
  threshold. L3 additionally waves non-destructive prompts through when no overseer is configured at all.

## Overseer (decision gate)

Two decision paths, controlled by configuration:

### Relay path (default)

Permission-prompt decisions go through a relay LLM. When no relay is wired at all (no API
key, no parked agent), the daemon applies a conservative fallback: **only L3 waves a
non-destructive prompt through**; L0–L2 escalate to a human, and destructive prompts always
escalate. All decisions pass through a centralized `gateVerdict()` that applies the minimum
confidence threshold as a single source of truth. Post-done reviews require a parked overseer.

### Agent path (parked overseer)

When an overseer exec is set, one **Overseer agent** is parked per active mission. It runs a
long-poll loop: `orca overseer poll` blocks until a decision is needed, the agent judges the
request, and `orca overseer decide` submits the verdict.

A **local destructive heuristic**, computed at enqueue time, is always authoritative — the
agent cannot override it. It covers `rm -rf`, `DROP TABLE`, `DELETE FROM`, `TRUNCATE`,
migrations, `.env`, secrets/credentials, force pushes, `git reset --hard`, `chmod 777`,
`curl`/`wget` pipes to shell, `-e`/`-c` one-liners, netcat, `eval()`, `os.system`,
`subprocess`, and `exec()`. A timeout or mission disengage conservatively escalates all
pending decisions.

## PR-native workflow (optional)

Off by default. When enabled, each mission runs isolated and ships a real GitHub pull
request instead of leaving uncommitted changes in the main checkout. It **complements** the
overseer review — the PR is the final human gate plus a feedback loop.

1. **Engage** → a dedicated branch and a sibling git **worktree** are created; the mission's
   agents run there, not in the main checkout.
2. **Per phase** → on the approving review verdict (or on close when review-on-done is off),
   the daemon commits that phase's worktree changes. A rejected phase never commits.
3. **Epic done** → an optional verify command runs in the worktree. Non-zero **holds the
   mission** and opens nothing. Green → push the branch and open the PR (auto or manual).
4. **Feedback loop** → a poller reads each open PR's reviews and comments. Fresh *actionable*
   feedback is aggregated and routed through the Pilot, which plans **1..N fix phases** under
   the epic and re-engages the mission so the next push updates the PR. A **fix-round budget**
   bounds the bot↔autopilot ping-pong: once spent, the mission parks as `stalled` for a human.

GitHub access uses a configured token or the machine's `gh` CLI login; a missing
`gh`/token/remote degrades to a no-op + warning, leaving the rest of autopilot unaffected.

## Pilot agent (AI planning)

When a pilot exec is configured, planning spawns a **Pilot** agent in the repository instead
of using the relay-based planner. The Pilot reads relevant files (AGENTS.md, CLAUDE.md,
README) for conventions, decomposes the goal into ordered phases, submits the plan via
`orca plan submit`, and stops — it must not implement anything or spawn agents. Autopilot
planning is always async: the API returns a `jobId` the web UI polls. Manual `phases` mode is
synchronous and needs no LLM key.

### Per-model descriptions & auto-model

Each exec ships with a default capability note; user edits in Settings merge over the
defaults. When auto-model is on, the planner receives a block listing every enabled model with
a non-empty note and picks the best model per phase — validated against the allow-list, falling
back to the default on anything invalid. Both the relay and the Pilot agent backend support it.

## Agent routing

Tasks specify which agent should execute them via the `exec:<spec>` label, resolved by
`resolveExecutor()`:

- `exec:sonnet` → `{ program: 'claude-code', model: 'sonnet' }`
- `exec:opencode:model` → `{ program: 'opencode', model: 'model' }`
- `exec:codex:model` → `{ program: 'codex', model: 'model' }`
- `exec:claude:model` → `{ program: 'claude-code', model: 'model' }`
- a spec containing `/` (e.g. `exec:ollama/deepseek-v4-flash`) → routed to `opencode`
- no label → the configured fallback (default `claude-code` / `sonnet`)

Executor metadata is centralized in a single module, so adding or changing an executor is a
one-line edit. The daemon's `allowedExecs` controls which executors the API permits; a
per-user model allow-list further restricts non-admin users.

## Deriver

The **deriver** monitors agent sessions in real time. It polls tmux every 5 seconds and
detects agent state from the pane output:

| Signal | Meaning |
|---|---|
| `working` | Agent is progressing normally |
| `needs_input` | Agent is waiting for user input (prompt detected, escalated) |
| `complete` | Task is closed |

Prompt detection is implemented for each supported program (OpenCode "Permission required",
Claude Code workspace-trust + "Do you want to proceed?", Codex "Allow command?"). For L1–L3
missions, environmental gates (claude workspace-trust) are auto-accepted and other prompts go
through the overseer gate; for L0, all prompts escalate. Each detected prompt is hashed to
avoid re-emitting on consecutive polls.

## Event bus

The `EventBus` decouples services and provides real-time updates to the web UI:

| Event | Trigger |
|---|---|
| `task` | Status change |
| `mission` | State change |
| `signal` | Deriver output (`working` / `needs_input` / `complete`) |
| `plan` | Plan job status |
| `review` | Overseer verdict on a post-done review |

It serves SSE streams at `GET /events`, invalidates web-UI caches, and drives two background
subscribers: the **PushDispatcher** (web-push phone notifications) and the **UsageRecorder**
(per-task token/cost snapshots on settle).

## Phone push notifications

Orca sends web-push notifications for mission events that need human attention — opt-in per
device. A VAPID keypair is generated on first boot; the public key is served for browser
subscription and the private key never leaves the daemon. The `PushDispatcher` maps events to
notifications and resolves recipients (the mission's owner plus all admins):

| Event | Notification |
|---|---|
| `review` (not approved) | Approve / Re-run |
| `signal` (`needs_input`) | Allow / Reject (or tap-to-open for multi-choice) |
| `mission` (`stalled`) | Tap-to-open |
| `mission` (`disengaged`) | Done — FYI (mentions PR if one was opened) |
| `task` (`blocked`) | Tap-to-open |

## Authentication & authorization

The daemon supports optional token-based authentication. When a user store is configured,
all endpoints except health, setup, and login require a bearer token. Login verifies a scrypt
password hash (random salt, no plaintext storage) and issues a revocable token.

Every token carries a `scope`:

| Scope | Purpose |
|---|---|
| `full` | Interactive user session — bounded by the user's role and project assignments |
| `agent` | Spawned agent — confined to a narrow verb + path allow-list and its live working set |
| `advisor` | Per-user assistant session — mapped to `full` rights but isolated from login tokens |

Agent-scoped tokens are injected into every spawned agent via `ORCA_TOKEN`. They prevent a
prompt-injected agent from creating users, performing admin operations, or reaching projects
it isn't actively working in. Project ownership is still enforced downstream, so an agent
cannot cross tenancy even within the allow-list.

### Trust boundary: admin vs owner

The token scopes above govern the REST API; the embedded **brain** (chat, Discord, cron,
sub-agent delegation) layers a second, narrower distinction on top for its own plugin tools:
`admin` (may use project-scoped power tools) and `owner` (is this genuinely the instance
operator). A Discord role can be mapped to grant `admin` so trusted members reach project tools
from chat — but only a linked account that resolves to the configured operator, or the daemon's
own internal automation, ever counts as `owner`. Owner-only surfaces — long-term memory, the raw
Discord API — gate on `owner`, so an admin-mapped Discord member can reach project tools but
never the operator's private memory or the bot's server-management token. See
[Architecture](/docs/architecture) for how this identity is carried through a prompt turn.

## Stuck detector

An agent that exits without running `orca close` leaves its task `in_progress` with a dead
tmux session. The stuck detector runs every 60 seconds with a grace period: it finds
`in_progress` tasks whose session is gone, increments the `stuck:<n>` counter, reverts to
`open` so the task re-spawns, and — once the relaunch budget is exceeded — sets the task
`blocked` and escalates to a human. On daemon startup the same logic runs once as a zombie
reconcile (no grace, no counter — a restart isn't an agent death).

## Post-done review (hard gate)

When review-on-done is enabled and an agent overseer is configured, closing a mission phase
triggers a **hard sequential gate** before the next phase may run. The close handler
synchronously blocks the open direct dependents, enqueues a `review` decision, and the parked
overseer judges it. On approval the dependents are released and the engine ticks immediately;
on reject they stay blocked, stalling the mission until a human unblocks them. The review is
fire-and-forget from the agent's perspective — its `close` call returns immediately.

## Assistant (per-user advisor)

The **assistant** is a persistent, per-user agent session (`orca-advisor-<userId>`) that
drives Orca on the user's behalf with a full-scope token. It auto-starts on login (when
configured), remembers its model, and runs in a docked IDE-style side panel with a real-PTY
terminal.

It acts through Orca's built-in **MCP server**, exposed statelessly so each connection acts
with exactly its user's rights. The toolset:

| Tool | Purpose |
|---|---|
| `orca_request` | Generic escape hatch — call any REST endpoint |
| `orca_tasks` | List all tasks |
| `orca_create_task` | Create a task |
| `orca_plan` | Plan a goal into an epic with phases |
| `orca_sessions` | List live agent sessions |

Every tool delegates to the same shared API core as the `orca api` CLI passthrough, so a new
REST endpoint works in both with zero edits.

---

See [Architecture](/docs/architecture) for how these pieces are wired into modules and timer
loops, and the [CLI reference](/docs/cli) for the commands agents and operators use. Full
reference docs live on
[GitHub](https://github.com/dragocz1995/orcasynth/tree/main/docs).
