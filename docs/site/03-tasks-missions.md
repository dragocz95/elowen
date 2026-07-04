---
title: Tasks & Missions
slug: tasks-missions
order: 3
eyebrow: Core concepts
---

# Tasks & Missions

Tasks are the fundamental unit of work in Orca. A task represents a single
piece of work for an AI agent. Missions group tasks into sequential phases
toward a larger goal.

## Task lifecycle

```
open → in_progress → closed / cancelled / blocked
```

| Status | Meaning |
|--------|---------|
| `open` | Ready to be picked up by an agent |
| `in_progress` | Agent is actively working on it |
| `closed` | Agent completed it (with outcome: `ok` or `fail`) |
| `cancelled` | Manually stopped |
| `blocked` | A dependency isn't met, or the stuck detector gave up |

### Task types

| Type | Meaning |
|------|---------|
| `task` | General implementation |
| `feature` | New feature |
| `bug` | Bug fix |
| `chore` | Maintenance, refactoring |
| `epic` | Container for sub-tasks (used by missions) |

### Dependencies

Tasks can depend on other tasks via `task_deps`. A task stays `open` until all
its dependencies are `closed`. The web UI shows blockers and lets you chain
tasks via drag-and-drop on the kanban board.

### Scheduling

Set a `scheduled_at` (ISO-8601) and `autostart: 1` to schedule a task for
future execution. The scheduler checks every 30 seconds and fires once per
schedule. A per-project burst cap (default 5) prevents a flood of parallel
agents.

## Missions (autopilot)

A mission decomposes a goal into ordered phases and orchestrates their
execution. Missions are the heart of Orca's autopilot.

### How it works

1. **Plan** — you provide a goal, Orca decomposes it into phases
2. **Engage** — creates an epic task with chained child tasks
3. **Execute** — each phase spawns an agent, runs sequentially
4. **Review** — optional post-done review via the overseer gate
5. **Complete** — last phase closes, mission disengages

### Planning backends

| Backend | When | How |
|---------|------|-----|
| **Relay** | API key configured | LLM decomposes the goal using `prompts/planner.md` |
| **Pilot** | `pilotExec` is set | A CLI agent reads the codebase and submits phases |
| **Manual** | Always | You supply `phases` directly — no LLM needed |

### Autonomy levels

| Level | Name | Behavior |
|-------|------|----------|
| L0 | Recommend | Plans and proposes — nothing runs without your approval |
| L1 | Assist | Runs clear, safe steps; escalates uncertain or sensitive actions |
| L2 | Pilot | Runs work, clears agent permission prompts; escalates ambiguous situations |
| L3 | Auto | Full autonomy — clears everything, reaches out only when stuck |

The autonomy level is per-mission and can be changed at engage time.

### Mission completion

When a mission finishes (all phases closed), an LLM summarizer produces a
prose description of what was accomplished, stamped on the epic task and
visible in the web UI.

### Replanning

Mid-mission, you can add phases via `POST /tasks/:epicId/phases` with a new
goal. The active mission picks up fresh phases on the next engine tick.

[Next: Agents & Autonomy](agents-autonomy)
