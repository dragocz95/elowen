---
title: Sub-agent Plugin
slug: subagent-plugin
order: 33
eyebrow: Plugin reference
group: Plugin reference
---

# Sub-agent Plugin

The bundled `subagent` plugin provides the delegation layer of Elowen. It runs one self-contained task in a fresh child conversation, called a sub-agent, and returns the child's final result to the conversation that delegated the work. The same plugin runs several sub-agents as a directed acyclic graph of nodes, called a workflow, where independent steps run in parallel and dependent steps wait for the results they need.

The delegation concepts, the live progress views and the recovery behavior are covered on [Sub-agents & Workflows](tasks-missions). This page describes operating the plugin itself: its tools, its Web UI surface, its settings and its boundaries.

## Where the plugin appears

**Settings → Plugins → Installed** lists `subagent` among the bundled plugins. The plugin contributes one Web UI surface: an **Agents** panel for administrators. It lists every typed sub-agent in the catalog with badges for built-in and custom agents, and it can also be opened as the plugin's own page. Administrators create, edit and delete agent types there. Each entry has a name in kebab-case, a one-line description the assistant reads when it chooses a type, a tools mode, and a prompt body. The tools mode is read-only, full toolset, inherited from the caller, or a custom comma-separated tool list. A saved change triggers the live plugin reload, so new conversations pick up the catalog without a daemon restart. Two administrator-only API routes back the panel and expose the same catalog as JSON.

The plugin registers no slash command. The `/workflow` prompt command and the key that moves a running foreground child to the background are core behavior, described on [Sub-agents & Workflows](tasks-missions).

### Tools the model receives

| Tool | What it does |
| --- | --- |
| `Delegate` | Hands one self-contained task to a fresh sub-agent. It returns a job id and the result is delivered in a later turn, unless the call asks to wait with `background: false`. |
| `DelegateStatus` | Reports a one-off live snapshot of a running delegation: status, tool count, token spend and current activity. It never waits and does not collect a result. |
| `DelegateResult` | Returns the final text of a finished delegation, or its error, read back from the durable store. |
| `DelegateModels` | Lists the configured `provider/model` values a sub-agent may run on, with the reasoning levels each accepts. |
| `DelegateList` | Lists the sub-agents this conversation has already run, newest first, so a follow-up can be sent to one of them. |
| `DelegateRead` | Reads the final stored assistant text of a listed sub-agent, paged with offset and limit. |
| `DelegateContinue` | Sends a follow-up to a sub-agent that already ran, so it resumes with its full context; it can also lift a read-only child back into write mode. An idle sub-agent's reply is delivered in a later turn unless the call passes `background: false`. |
| `DelegateStop` | Stops a direct sub-agent of this conversation, together with whatever that child delegated itself. |
| `WorkflowStart` | Runs a workflow: a DAG of sub-agent nodes whose complete definition is a JSON file. |
| `WorkflowAddNodes` | Extends a running workflow with new nodes as the work reveals follow-up steps. |
| `WorkflowStatus` | Returns a live per-node snapshot of one workflow: statuses, dependencies, tokens and elapsed time. |
| `WorkflowResume` | Re-runs only the unfinished nodes of a stopped workflow; completed nodes are kept exactly as they finished. |
| `WorkflowStop` | Stops a running workflow, aborts its running nodes and keeps the results of finished nodes. |

### Background and blocking delegation

A `Delegate` call is asynchronous by default: it returns a stable job id immediately and Elowen delivers the result in a new turn once the child settles. `background: false` is the explicit request to wait, and the call then blocks and returns the child's final text as its own result. A running blocking delegation can also be moved to the background from the chat interface without cancelling it. A delivered result arrives on its own, so `DelegateStatus` and `DelegateResult` exist for a direct question about a job or a missed delivery; polling them in a loop is never the intended use. Where a delegation runs outside a conversation that could be woken, a call that names no mode waits instead, so its result is never left undelivered. Live progress is kept in memory: after a daemon restart a job is no longer tracked live, but its durable result is still readable by job or session id and `DelegateContinue` still works.

The same rule covers a follow-up. `DelegateContinue` on an idle sub-agent returns once that sub-agent has started its turn and the reply is delivered later; `background: false` waits for the reply instead. A sub-agent that is still mid-turn is steered rather than restarted: that message has no reply of its own, so the call answers immediately and the updated conclusion arrives through the original delegation.

Every delegation can carry a short name that labels the child in the progress rail, the agents table and the running-subagents reminder. Without one the label is derived from the opening words of the task.

### Narrowing a child

A child inherits the caller's model, reasoning level, working directory and effective authority. The delegation parameters can only narrow that copy, never widen it:

- `read_only` gives the child look-only tools without write and edit tools, a shell clamped to non-destructive commands, and no ability to delegate further. The clamp is a guardrail rather than a sandbox: redirection can still write files.
- `tools` names an exact toolset drawn from the caller's own tools. An empty list is rejected, and a tool the caller does not hold is refused by name.
- `subagent_type` runs the child as a typed role from the catalog. The built-in `explore` and `plan` types ship read-only, administrators add more in the **Agents** panel, and an unknown type is refused with the valid names.
- `model` and `thinkingLevel` choose a configured model and reasoning effort for this delegation only. `DelegateModels` lists the valid values; by default the child inherits the caller's model.
- `workspaceId` confines the child to one Git Sandbox worktree as its logical filesystem root.

`DelegateContinue` can lift a read-only child that the caller itself started back into full write access. The child then resumes with its full context under the caller's current permissions, and an explicit tool list from the original call is lifted with it.

### Forks

With `fork: true` the child starts from the current conversation's own system prompt, tools and history, and the task text becomes a directive rather than a fresh briefing. The value of a fork is the provider's cached prompt prefix, which is why it pays off only when the child runs on the same provider and model as its parent. A fork must keep the parent's exact tool set and prompt, so the parameters that narrow a child are refused together with it. Forking works only in an owner conversation: a shared channel session has no prompt cache to inherit, and a worker that is itself a fork cannot fork again.

### Workflows

A workflow definition is a JSON file the delegating conversation writes first and passes by path; nodes cannot be passed inline. The file is either a node array or an object with optional `title`, `fork` and `background` beside its `nodes`. Each node carries a unique short `id` and a complete self-contained `task`, and may set `deps`, `model`, `thinkingLevel`, `fork`, `read_only`, `tools`, `subagent_type` and `workspaceId`. At least one node must have no dependencies, dependency ids must exist, and cycles are rejected.

A node whose task needs an earlier result must be reachable through the dependency chain, because a dependent node receives only a short handover from each direct dependency, at most 4,000 characters, and nothing from further upstream. The handover is the section the node wrote under a `## Handover` heading, or the tail of its result when it wrote none.

`WorkflowStart` starts the DAG and delivers its summary in a later turn; `background: false`, as an argument or in the file, makes it block and return every node's result instead. The argument wins over the file, and the choice governs delivery only: independent nodes still run in parallel and a dependent node still waits for the nodes it depends on. `WorkflowStatus` reads the live per-node snapshot, `WorkflowAddNodes` extends a running DAG, `WorkflowResume` re-runs only unfinished nodes and keeps the delivery the run already had unless it is given its own `background`, and `WorkflowStop` ends a run early. Resume and stop work only from the conversation that started the workflow. A workflow lives in memory on the daemon, so a finished one can be inspected or resumed only while it is still held there.

## Enabling the plugin

`subagent` is a bundled plugin and is enabled in a fresh installation. If it was disabled or removed, restore it in **Settings → Plugins**: switch it on in **Installed**, or restore it from **Available** as a disabled plugin. The plugin is not user-grantable, so no per-user grant exists; every authenticated user receives its tools subject to the normal account and tool permissions.

## Configuration

| Field | Key | Type | Default | What it does |
| --- | --- | --- | --- | --- |
| Retention | `sec_retention` | section | not set | Groups the retention setting. A section carries no value. |
| Result retention (ms) | `resultRetentionMs` | number | `3600000` | How long a finished background delegation or workflow stays readable with `DelegateStatus`, `DelegateResult` or `WorkflowStatus`. Past it the entry is forgotten and the id no longer resolves. Range 10 minutes to 24 hours, in 10-minute steps. |
| Stall watchdog | `sec_watchdog` | section | not set | Groups the watchdog setting. |
| Stall timeout (minutes) | `stallMinutes` | number | `60` | How long a delegated sub-agent may go with no tool start or step boundary before it is aborted as stalled. The verdict is recoverable with `DelegateContinue`, so the watchdog is a safety net for a wedged child; raise it for deep analyses that think for long stretches. Range 5 to 240 minutes. |

Both values are resolved when the plugin loads, so a change takes effect on the next delegated turn after the plugin reload; a daemon restart is not required. See [Configuration](configuration) for the general settings layout.

## Permissions and consent

Enabling the plugin asks for consent to one mutating capability, `workflow-dag`, which the workflow tools use to record and control their runs. The manifest also declares read access to the sub-agent catalog and to runtime controls published by other plugins. Cancelling the consent dialog leaves the plugin installed but disabled.

Delegation never widens access. A child runs inside a narrower copy of the caller's authority, an explicit tool list may name only tools the caller holds, and a workflow node added dynamically inherits the adding child's narrower boundary. The manifest marks six tools as plan-safe, `DelegateStatus`, `DelegateResult`, `DelegateModels`, `DelegateList`, `DelegateRead` and `WorkflowStatus`, so a turn that is planning can still inspect past delegations and workflows. The **Agents** panel and its two API routes are administrator-only surfaces. Individual account tool permissions and model restrictions continue to apply on top of the plugin's own boundaries; see [Users & Access](users-access).

## Known limits

- One conversation can hold at most 64 delegations, foreground and background together. A foreground call occupies a slot because it can be detached, so a full set refuses a new spawn until one finishes.
- A stored child result keeps its last 100,000 characters when the run succeeded and its first 100,000 when it failed. `DelegateRead` returns at most 50,000 characters per call, 8,000 by default, and `DelegateList` lists 20 entries by default.
- At most 16 workflows may run at the same time. A finished workflow can be inspected, extended or resumed only while the daemon still holds it, which the retention window bounds; after a daemon restart a workflow cannot be resumed at all.
- A workflow holds at most 64 nodes, with a task of at most 4,000 characters and an id of at most 64 characters per node.
- A dependent node receives at most 4,000 characters of handover per direct dependency. A node whose dependency fails is reported as skipped rather than run without its input.
- The stall watchdog aborts a child that shows no tool or step activity for the configured timeout. The work is recoverable with `DelegateContinue`, but the interrupted turn is lost.

[Next: Web Search & Fetch](web-plugin)