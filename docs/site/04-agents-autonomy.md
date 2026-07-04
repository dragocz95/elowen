---
title: Agents & Autonomy
slug: agents-autonomy
order: 4
eyebrow: Core concepts
---

# Agents & Autonomy

Agents are AI coding assistants that carry out tasks. Orca supports multiple
agent providers and controls them through a graduated autonomy system.

## Providers

Orca spawns agents through three supported CLI providers:

| Provider | Exec prefix | Default model |
|----------|-------------|---------------|
| Claude Code | `claude:` | `sonnet` |
| OpenCode | `opencode:` | — |
| Codex | `codex:` | — |

### Executor resolution

Tasks specify their executor via `exec:<spec>` labels. Resolution:

- `exec:sonnet` → claude-code with model `sonnet`
- `exec:opencode:deepseek-v4-flash` → OpenCode with model `deepseek-v4-flash`
- `exec:codex:gpt-5.4` → Codex with model `gpt-5.4`
- `exec:ollama/deepseek-v4-flash` → OpenCode (contains `/`)
- No label → configured fallback (default: claude-code / sonnet)

Every exec must be in the daemon's `allowedExecs` list, otherwise the API
rejects it. Non-admin users may be further restricted to a subset.

### Provider configuration

Configure in **Settings → Providers**:

- **Binary path** — override the CLI binary location
- **Extra args** — additional CLI flags
- **Skip permissions** — bypass approval prompts (e.g. `--dangerously-skip-permissions`)
- **Resume sessions** — when enabled, respawned agents continue their prior
  CLI session instead of cold-starting

## Autonomy levels

Every mission runs at one of four autonomy levels:

| Level | Name | Prompt handling | Escalation |
|-------|------|----------------|------------|
| L0 | Recommend | All prompts → human | Never auto-approves |
| L1 | Assist | Overseer at 0.85 confidence | Uncertain/sensitive actions |
| L2 | Pilot | Overseer at 0.6 confidence | Ambiguous situations |
| L3 | Auto | Overseer at 0.6 confidence | Only when stuck |

L1–L3 spawn agents automatically. L0 plans and proposes but never executes
without your explicit approval.

## Overseer (decision gate)

The overseer vets every action before it executes — task dispatch, permission
prompts, and post-done reviews.

### Relay path (default)

When `overseerExec` is empty, decisions go through the configured LLM relay
using `autopilot.overseerModel`. The LLM judges each prompt and returns a
confidence score. The gate applies a threshold check:

- **Approved** — confidence ≥ threshold → agent proceeds
- **Rejected** — confidence < threshold → agent waits for human input
- **Destructive** — always escalated, overseer can't override

### Agent path (parked overseer)

When `overseerExec` is set (e.g. `sonnet`), a parked overseer agent is spawned
for each active mission. It runs a long-poll loop:

1. `orca overseer poll` — absorbs heartbeats, surfaces decisions
2. Judges the request using the prompt from `prompts/overseer.md`
3. `orca overseer decide --id <id> --approve --confidence 0.85` — submits verdict

The agent path is fully async. If the parked overseer doesn't respond within
120 seconds, the decision defaults to escalate (conservative timeout).

## Deriver (prompt detection)

The deriver polls every live agent's tmux pane every 5 seconds, detecting
state changes from terminal output.

### Detected prompts

| Program | Detects | Trigger text |
|---------|---------|-------------|
| OpenCode | Permission | `Permission required` + Allow/Reject |
| Claude Code | Workspace trust | `Yes, I trust this folder` |
| Claude Code | Permission | `Do you want to proceed?` |
| Codex | Command approval | `Allow command?` / `Approve this command?` |

Auto-accept prompts (like workspace trust) are cleared directly by the
deriver without an overseer round-trip.

### Signal bus

The deriver emits signals to the SSE event bus:

| Signal | Meaning |
|--------|---------|
| `working` | Agent is active, no prompt detected |
| `needs_input` | Agent is paused, needs human intervention |
| `complete` | Task is closed — final signal |

## Decision taxonomy

The overseer handles five decision kinds:

| Kind | Enqueued by | Context |
|------|-------------|---------|
| `prompt` | Deriver | Permission prompt question from the agent |
| `review` | Close handler | Post-done review: task title, outcome, summary |
| `question` | Deriver | Multiple-choice question from the agent |
| `message` | Agent (`orca ask`) | Free-text Q&A with the autopilot |
| `check` | Liveness sweep | Routine progress check on a working agent |

The confidence threshold is 0.85 for L1 and 0.6 for L2/L3.

## Liveness & progress checks

Orca uses a **pane activity tracker** (`PaneActivityTracker`) that hashes
pane content every 5 seconds. An agent whose pane stops changing is
considered idle. The liveness sweep then fires:

| Check | After | Action |
|-------|-------|--------|
| Worker wedge | 5 min idle | Notify overseer for escalation |
| Routine progress | 15 min working | Ask overseer "is this still on track?" |
| Overseer wedge | 10 min idle | Escalate to human |
| Dead overseer | 90 s gone | Replace with fresh overseer |
| Absolute backstop | 30 min any state | Escalate |

## Agent Q&A (`orca ask`)

Agents can ask free-text questions to the autopilot (or a human) during a
mission:

1. Agent calls `orca ask "Is this approach correct?"`
2. The autopilot answers directly, or escalates to a human
3. The human sees the question in the **Escalations** inbox
4. Human replies → agent receives the answer

The Q&A history is available via `orca ask --history`.

## Stuck detector

The stuck detector sweeps every 60 seconds for `in_progress` tasks whose agent
session is no longer alive. It reverts dead agent tasks to `open` (up to 2
retries), then escalates to `blocked` to prevent infinite crash loops. When a
dead agent is reverted, a **resume note** is set explaining why the task was
relaunched.

## Session resume

When resume is enabled per provider, the daemon captures the agent's CLI
session ID at close and splices a resume flag into the next spawn. The agent
reattaches to its prior conversation instead of cold-starting.

[Next: Web UI](web-ui)
