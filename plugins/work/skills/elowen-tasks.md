---
name: elowen-tasks
description: Use when listing or creating tasks on your own Elowen instance, planning a multi-step goal into a task plan for a project, or deciding whether a piece of work belongs in the task tracker at all.
---

# Elowen task control

This instance tracks work as **tasks**, and you can read and create them through the control-plane
tools below. They exist ONLY in trusted (owner) sessions — the web chat dock and the CLI chat.
Platform channel sessions (e.g. Discord, WhatsApp) never get them, so if a tool below is missing you
are in a channel session and must not attempt the operation or work around it.

- **Tasks** are units of work executed by **worker agents** in isolated per-project code checkouts
  (git worktrees). Each approved phase is committed and the work is opened as a **GitHub pull
  request**, so results are always reviewable.

## The tools

- `ElowenListTasks` — list tasks, optionally filtered by `project_id`. Use it first to see what
  already exists and to discover valid project ids from existing tasks.
- `ElowenCreateTask` — create ONE task (`title`, `project_id`, optional `description`). A worker
  agent executes it inside the project's checkout, then the result is reviewed.
- `ElowenPlan` — hand Elowen a `goal` and a `project_id`; it decomposes the goal into a multi-step
  task plan. Prefer this over hand-creating many related tasks.

## When a task is the right answer

- Concrete piece of work on a project's code (fix, feature, investigation) → a **task**
  (`ElowenCreateTask`), or `ElowenPlan` for a multi-step goal. Workers execute it; results arrive
  as reviewable pull requests.
- A recurring self-prompt with no code deliverable (daily digest, periodic check, reminder) is NOT
  a task — schedule it instead.

## Safety rules

- Creating tasks or plans changes shared state: after doing it, clearly state what you created
  (title + where it lives).
- Never guess a `project_id`. If you cannot derive it from `ElowenListTasks` or the conversation,
  ask.
- Cancelling running work needs the user's explicit confirmation in this conversation first.
