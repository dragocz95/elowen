---
title: Core Concepts
slug: concepts
order: 2
eyebrow: How Orca works
---

# Core Concepts

Orca is an AI agent orchestration daemon. It manages a queue of tasks, spawns coding
agents into isolated `tmux` sessions, and lets you watch, intervene, and steer — from
the web UI, the CLI, or your phone.

If you haven't yet, see [Getting Started](/docs/getting-started) for installation and
your first task.

## Tasks

A **task** is a single unit of work. You give it a title, optional details, pick an
executor (which model or agent runs it), and assign it to a project. Tasks can depend
on other tasks — a task won't start until its dependencies are done.

Tasks flow through a simple lifecycle:

```
open → in_progress → closed
  ↓                    ↑
blocked ───────────────┘ (unblock to retry)
  ↓
cancelled
```

| Status | What it means |
|---|---|
| `open` | Waiting to be picked up |
| `in_progress` | An agent is working on it right now |
| `blocked` | Something went wrong — needs a human to unblock |
| `closed` | Done |
| `cancelled` | Abandoned |

Blocked tasks stay put until you manually unblock them. The engine skips them on each
tick so it doesn't keep retrying.

## Missions

A **mission** turns a high-level goal into an autonomous run. You describe what you
want, pick an autonomy level, and Orca's **Pilot** decomposes the goal into phases
(a tree of tasks under an epic). The mission engine then ticks every 90 seconds:
it picks ready tasks, spawns agents up to your configured `max_sessions`, and works
through the phases until everything is done.

Mission states: `active` (running), `paused` (suspended), `stalled` (waiting on you),
`disengaged` (complete).

## Autonomy levels

You decide how much rope the autopilot gets:

| Level | What it means for you |
|---|---|
| **L0 · Recommend** | The Pilot plans and proposes. Nothing runs until you approve it. |
| **L1 · Assist** | Runs clear, safe steps on its own. Anything uncertain or sensitive waits for your approval. |
| **L2 · Pilot** | Runs work and clears agent permission prompts itself. Ambiguous or risky situations are escalated to you. |
| **L3 · Auto** | Full autonomy. Runs and clears everything itself, reaching out only when it genuinely cannot decide. |

Destructive operations (`rm -rf`, dropping tables, force-pushes, touching `.env`)
always escalate to a human, whatever the level.

## Agents

Orca spawns agents using the CLI tools you already have installed. Supported
providers:

- **Claude Code** (`claude`)
- **OpenCode** (`opencode`)
- **Codex** (`codex`)
- **Kilo Code** (`kilo`)
- **Pi** (`pi`)
- **oh-my-pi** (`oh-my-pi`)

Each task picks an executor via an `exec:<model>` label. If none is set, Orca uses
your configured default. You can also pin a specific agent name per task.

## Sessions

Every agent runs in its own **`tmux` session** — isolated, persistent, observable.
From the web UI you can:

- Watch a live, ANSI-colored tail of the agent's terminal
- Click into any session to get a **full PTY** — type straight into it, take over
  mid-run, scroll back through history
- Pop a terminal out into its own window

When an agent is waiting on a permission prompt, the session card shows **Allow /
Reject** buttons right there. You can also act from phone push notifications.

## The Pilot + Overseer

The **Pilot** is the planner. When you engage a mission, the Pilot reads your
project's conventions (AGENTS.md, CLAUDE.md, README), decomposes the goal into
ordered phases, and submits the plan. It plans — it does not implement.

The **Overseer** is the decision gate. When an agent hits a permission prompt
("can I run this command?"), the Overseer judges whether it's safe. You can
configure a relay LLM or a parked CLI agent as the Overseer. The gate applies a
confidence threshold — stricter for L1, standard for L2/L3.

## The Deriver

The **Deriver** watches every agent session in real time. It polls `tmux` every
**5 seconds** and detects what the agent is doing:

| Signal | Meaning |
|---|---|
| `working` | Agent is progressing normally |
| `needs_input` | Agent is waiting on a permission prompt or user input |
| `complete` | Task is done |

Prompt detection is per-provider (OpenCode's "Permission required", Claude Code's
"Do you want to proceed?", Codex's "Allow command?"). For L1–L3, environmental
gates (like workspace trust) are auto-accepted; other prompts go through the
Overseer. For L0, everything escalates to you.

## Handoff notes

Agents working the same mission can leave notes for each other. Any agent can run
`orca note add <missionId> "context for the next phase"` and the next agent reads
them with `orca note ls <missionId>`. Notes are scoped to the mission and cleaned
up when the mission ends.

## PR-native workflow

Off by default. When enabled, each mission runs in an **isolated git worktree** on
its own branch. When a phase completes, the daemon commits the changes. When the
whole epic is done, it pushes the branch and opens a **real GitHub pull request**.

The PR becomes the final human gate plus a feedback loop: the daemon polls the PR
for reviews and comments, routes actionable feedback back through the Pilot, and
the next push updates the PR. A fix-round budget prevents infinite bot ping-pong.

Use this when you want a clean review trail and don't want agents touching your
main branch directly.

## Assistant

The **Assistant** is your own persistent agent that drives Orca on your behalf. It
lives in a docked side panel in the web UI. Start it with an agent of your choice;
it can create tasks, plan missions, list sessions, and reach any Orca endpoint
through a built-in MCP server — with exactly your own rights. It auto-starts on
login once configured.

---

For the full command reference see the [CLI docs](/docs/cli), for the web UI tour
see [Using Orca](/docs/using-orca), and for daemon internals see
[Architecture](/docs/architecture).
