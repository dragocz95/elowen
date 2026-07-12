---
title: Tasks & Missions
slug: tasks-missions
order: 3
eyebrow: Core concepts
---

# Tasks & Missions

Tasks turn an agent request into work you can observe and steer. A task has a project, status, priority, optional schedule, dependencies, and an executor. It can be created in the [Web UI](web-ui), through the API, or by the agent itself.

A mission is the execution layer for work that needs several steps. It groups an epic and its phase tasks, then coordinates planning, dispatch, review, pause, and completion. You can still use Elowen entirely through ordinary chat; tasks and missions make the longer-running work legible instead of invisible.

![The task workspace, with an in-context detail drawer](images/web-ui-tasks.png)

## Tasks

Every task moves through a small state model:

```text
open → in_progress → closed
                  ├→ blocked
                  └→ cancelled
```

| Status | Meaning |
| --- | --- |
| `open` | Ready to run once its dependencies are satisfied. |
| `in_progress` | A worker is actively handling it. |
| `blocked` | Needs an answer, review, or another human decision. |
| `closed` | Finished; an outcome and summary can be recorded. |
| `cancelled` | Stopped intentionally. |

Use task types such as `task`, `feature`, `bug`, `chore`, and `epic` to make a list readable. An epic is a normal task used as the parent of mission phases; it is not a second workflow with separate data.

### Dependencies and scheduling

Dependencies are stored between tasks. A dependent task does not become ready until its prerequisites are closed, and cycles are rejected. You can also set `scheduled_at` and opt into `autostart`. A scheduled task without `autostart` is only a due-date marker; Elowen will not launch it on your behalf.

The scheduler protects shared project checkouts from concurrent writers. If several scheduled tasks target the same project, they wait for a safe slot. Missions configured for a pull-request workflow can instead run in their own worktree.

## Missions

Create a mission from a goal in the Tasks workspace. Elowen can accept a manual phase list or ask a planner to propose one. The result is an epic plus ordered phase tasks; the mission engine then engages the ready phases according to the selected autonomy and concurrency settings.

1. **Plan** — create or review phases for the goal.
2. **Engage** — choose autonomy, concurrency, optional PR workflow, and per-mission roles.
3. **Run** — dispatch ready work while honoring dependencies and project safety.
4. **Review or escalate** — capture questions and decisions instead of silently guessing.
5. **Finish** — summarize the mission and clean up its active orchestration state.

### Pilot and overseer

An optional **pilot** plans work. An optional **overseer** can stay available during the mission to judge routine decisions, review completion, or escalate uncertain cases. Each mission can select its own pilot and overseer executors, independently from the workspace defaults. If no dedicated executor is configured, Elowen uses the configured fallback behavior rather than inventing a hidden agent.

Autonomy levels control how far the mission can proceed before it asks for help. They do not bypass permission or destructive-action safeguards; use the [Agents & Autonomy](agents-autonomy) guide to choose the appropriate level.

### TDD and pull requests

Autopilot can require a test-first loop for mission workers. When enabled, it guides workers to establish a failing test, implement the smallest change, and verify the result. The rule applies to both embedded Elowen workers and supported external coding CLIs.

The optional PR workflow uses a mission worktree and can create a branch, run a verification command, and open a pull request according to your GitHub settings. Treat it as an explicit workflow choice, not a replacement for your repository's review policy.

## Watch and intervene

- **Tasks** is the primary list and detail workspace.
- **Kanban** groups task state visually and supports direct organization.
- **Sessions** shows live worker terminals when an executor uses tmux.
- **Timeline** records related activity and commits.
- **Escalations** gathers situations that require a person.

You can pause or resume a mission, answer a worker, change a task's schedule, or open the associated project without losing the surrounding context. For repository setup and PR behavior, continue to [Projects & Workflow](projects-workflow).

[Next: Agents & Autonomy](agents-autonomy)
