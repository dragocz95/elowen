---
title: Task List
slug: todo-plugin
order: 47
eyebrow: Plugin reference
group: Plugin reference
---

# Task List

The registry plugin `todo`, version 0.14.6, gives the agent a session task list: it plans multi-step work in one call, tracks it task by task, and shows progress live while the work runs. Every conversation has its own list, kept per signed-in account, so one conversation's checklist never appears in another.

## Where it appears

The plugin adds no navigation entry to the Web UI and no account panel. Its visible surface is the live task card in the conversation, and administrators manage it under **Settings → Plugins**. While the plugin is enabled, the **`/tasks`** command in the CLI and the web chat opens a picker for inspecting and managing the current conversation's tasks. The list itself is stored on the instance, so it survives a page reload within the same conversation.

## The live card

While the list exists, the conversation shows a pinned **Todos** card. In the web chat it stays pinned above the messages, the CLI shows the same list in its side panel, and chat platforms receive it as a text message. A row shows:

- the task id and subject, or the present-continuous progress text while the task runs,
- the status: pending, in progress, or completed,
- the owner, when one is set, and
- the tasks still blocking it, for every blocker that is not finished.

The card is interactive in the web UI: a reader can tick a task off, hand it an owner, or remove it, and the change lands on the same list the tools maintain. The card is refreshed after every tool call, so progress appears as soon as the model updates a task.

Before each turn, the agent also receives the current list as part of its working context, together with the rules for keeping it accurate: mark work in progress when it starts, complete it when it is genuinely finished, and respect blockers.

## The five tools

| Tool | What it does |
| --- | --- |
| `TaskCreate` | Creates a whole plan in one call: every task goes into the `tasks` array, each with a subject and a description, and the call returns the id of each new task. A missing subject or description rejects the whole batch. |
| `TaskGet` | Reads one task by id, including its private description and dependency graph. The detailed result is for the model and is not shown in the panel. |
| `TaskList` | Lists the current tasks with their public state. This is the authoritative set of ids whenever an update or a delete reports that an id was not found. |
| `TaskUpdate` | Changes one existing task per call: subject, description, progress text, status, owner, private metadata, or dependencies. It never creates a task, and a call that changes nothing is refused. |
| `TaskDelete` | Deletes one task by `taskId`, or an explicit `taskIds` batch atomically. Every id must exist and appear once; an unknown or duplicate id rejects the whole batch without deleting anything. |

## Plans, dependencies, and ids

A plan is created in one call. The `tasks` array carries every task in the order it should appear, and prerequisites are declared in `blockedBy`. An existing task uses its id as a string, such as `"3"`. A sibling in the same call uses its 1-based position with a `$` prefix, so `blockedBy: ["$1"]` waits for the first task in that array. The same field can mix both forms. Ids are handed out in input order and returned with the result. After creation, everything is updated by id. `TaskUpdate` and `TaskGet` take a single `taskId`, and ids are never guessed, only taken from a `TaskCreate` result or from `TaskList`. Self-dependencies and dependency cycles are rejected, as is any batch that names a missing prerequisite: the whole batch is refused together, and the error names the affected task and bad reference.

When no task is running yet, the first unblocked pending task starts automatically, and finishing a task names the next unblocked one so the model can chain straight onto it.

A task moves through three statuses, `pending`, `in_progress`, and `completed`; `TaskUpdate` can also delete a task outright by setting its status to `deleted`. A subject or an owner must be a single line of text, and control characters such as newlines are refused by name so the caller can correct the value.

## What is public and what is private

The reader sees the public state on the card: subject, status, owner, progress text, and blockers. The description and the metadata are private working context for the model: `TaskGet` returns them, `TaskList` omits them, and no panel displays them. Metadata keys merge on update, and a key set to null is removed. The model is instructed not to repeat the list in its reply, because the reader can already see the panel.

## Housekeeping

Three mechanics keep the list useful in long sessions:

- A fully completed list survives for three further conversation turns and is then cleared automatically, so finished work does not follow the conversation forever. New work starts with a clean panel. Only a list whose every task is completed ages toward this cleanup; a list with open work keeps its finished rows.
- In the context the model reads each turn, finished tasks beyond the ten most recent collapse into one counted summary line. Nothing is deleted by this; the rows and ids stay intact while the list exists.
- A task left in progress for a long time triggers a reminder to confirm the work still matches it, and several tasks in progress at once trigger a reminder to keep one active.

## Install, enable, and grant

1. Install `todo` from **Settings → Plugins → Available**.
2. It requires Elowen 0.28.14 or newer; the marketplace refuses installation on an older core.
3. No configuration fields exist and no per-user grant applies, because the plugin is not user-grantable. Enable it and the tools are available, subject to the account's tool permissions.

## Permissions and consent

Enabling the plugin asks for no consent confirmation, because it declares no mutating capability. Its manifest declares read access to the store, which is where the lists live. `TaskGet` and `TaskList` are read-only and form the pair the agent can use while planning rather than executing.

## Known limits

- A task list belongs to one conversation; the tools refuse when a turn has none.
- Each signed-in account has its own list per conversation; lists are not shared between accounts.
- The list is flat: there is no cross-conversation board and no project selector.
- Ids are simple counters per list. A deleted id is gone for good; the fix for a stale id is `TaskList`, never a guess.
- Deletion is permanent for the selected tasks and their dependency edges.
- Blockers steer the model, but they do not lock the reader out: a blocked task can still be completed by hand from the panel.

[Next: Voice Calls](voice-bot-plugin)