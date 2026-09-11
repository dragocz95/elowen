---
title: Sub-agents & Workflows
slug: tasks-missions
order: 13
eyebrow: Delegation
group: Automation
---

# Sub-agents & Workflows

Elowen delegates focused work to fresh child conversations called **sub-agents**. For work with dependencies, it can run those children as a directed acyclic graph (DAG): independent steps run in parallel and dependent steps wait for the results they need.

The delegation layer is provided by the bundled `subagent` plugin. Core supplies the host and authority boundaries, but it no longer owns the legacy task and mission domains. The session task list is provided by the optional `todo` plugin, while the current typed sub-agent catalog is provided by `subagent`; either plugin can be absent or disabled. The catalog's historical `/plugins/agents/list` and `/plugins/agents/:name` API routes are owned by `subagent`, not by a separate agents plugin. A sub-agent is not a separate account, worker, or Project. It runs inside the same Elowen instance with a narrower copy of the caller's authority.

## Plugin availability and recovery

Optional domain plugins must be installed and enabled before their tools, pages, and API mounts exist. Manage them in **Settings → Plugins → Available**:

1. Select **Install** to copy the plugin from the curated registry. The standard web action then enables it as part of the same operation.
2. Review the plugin's capabilities and configure any required fields. If the plugin requests mutation grants, confirm them; cancelling leaves the newly installed plugin disabled.
3. For an installed but disabled plugin, use its toggle in **Installed**.

The live registry reloads after an enable or install, usually without a daemon restart. If work is currently running, the change may be reported as pending and will apply when that work settles. On startup, the reconciler attempts to restore previously enabled registry plugins when the registry is reachable; an unavailable registry leaves them missing rather than enabling anything new.

For **root-mounted** plugin routes, the HTTP result distinguishes these states:

- **404** means the route is not declared by a known plugin (for example, the plugin was removed, or the registry has no cached route information).
- **503** with `plugin is disabled` means the plugin is discovered but switched off; enable it in Settings.
- **503** with `plugin is enabled but not installed` means configuration still enables the plugin, but its code is missing locally; restore or install it from the curated registry.

Namespaced `/plugins/<name>/api/...` routes return **404** when no live handler is registered; they do not expose the root-route 503 distinction.

## Delegate one focused task

`Delegate` creates a fresh child conversation. The child cannot see the parent transcript, so its `task` must contain the complete instruction and relevant context. The child returns a result to the parent; it does not become a new top-level conversation.

Use delegation when a task is self-contained and you want its conclusion rather than its entire exploration trail. For independent subtasks, issue multiple `Delegate` calls in the same turn so they can run concurrently.

By default, `Delegate` is asynchronous: the tool returns a job id immediately and Elowen delivers the completed result in a later turn, so there is no reason to poll a running child in a loop. Set `background: false` when the rest of the turn depends on the answer; the call then waits and returns the child's result directly.

A child inherits the caller's model, reasoning level, working directory, Project context, and effective authority by default. You can narrow the delegation with:

- `read_only: true` for inspection and reporting without the normal `Write`/`Edit` tools. This is a narrower execution boundary, not a filesystem sandbox: the shell clamp still permits some redirection, so do not use it as a guarantee that no file can ever be changed;
- `tools` for an explicit tool allow-list;
- `subagent_type` for a named role such as the built-in read-only `explore` or `plan` type;
- `model` for another configured model. Use `DelegateModels` to see the valid `provider/model` values.

To continue a child that already ran, use `DelegateContinue`. It keeps that child's transcript and original boundary instead of making a new child rediscover the work. An idle child's follow-up turn is delivered like a delegation, in a later turn, unless the call passes `background: false`; a child that is still working is steered instead, and its updated conclusion arrives through the original delegation.

## Monitor and steer sub-agents

The parent transcript shows a live child row with its status and activity. In the CLI:

- **`Ctrl+O`** cycles focus through running child conversations;
- while a child has focus, your message is sent to that child;
- **`Esc`** returns focus to the parent;
- **`Ctrl+B`** backgrounds a running foreground child without cancelling it.

The child result, transcript, and usage remain linked to the parent conversation. A read-only child has no normal `Write`/`Edit` tools and a restricted shell; no child can gain access that the caller does not already have.

![Elowen terminal chat showing a delegated sub-agent](../screenshots/cli/11-subagent.png)

## Manage background processes

Long-running shell commands started with `Bash(run_in_background: true)` have handles scoped to the current conversation and account. Use `ListProcesses` to list only this conversation's background jobs, `ProcessOutput` to wait for or inspect one job, and `KillProcess` to stop one abruptly.

`ProcessOutput` waits by default and returns incremental output. Use `block: false` for a bounded peek or `all: true` for the retained buffer. The buffer is a rolling tail, so earlier output may be reported as dropped; after a process exits and its final output is collected, the handle is removed. `KillProcess` sends an immediate kill to the tracked process tree and discards retained output, so read output first when it matters. Foreground commands and another conversation's processes are not listed.

The terminal plugin limits concurrent background processes per session and account. The configured default is 16, with an operator-controlled range. Use the process handle returned by the tool rather than polling with repeated sleep commands.

## Run a workflow DAG

Use `/workflow` in CLI or web chat when the request is best handled by orchestration rather than one turn. This changes the agent's prompt bias; it is not an additional permission boundary. The agent may still handle a trivial request directly instead of wrapping it in a workflow.

A workflow is started with `WorkflowStart`. Its complete definition must be in a JSON file created with `Write`; nodes cannot be passed inline. An explicitly workspace-scoped child cannot use `WorkflowStart`, because host-filesystem tools are withheld from that logical workspace view. A normal parent bound to a workspace can still start delegated work whose shell begins in that worktree. The file can be a node array or an object containing `nodes`, optional `title`, optional shared `context`, and optional `background`:

```json
[
  {
    "id": "inspect",
    "task": "Inspect the repository and report the relevant files and constraints."
  },
  {
    "id": "plan",
    "task": "Use the inspection result to produce an implementation plan.",
    "deps": ["inspect"]
  },
  {
    "id": "implement",
    "task": "Implement the approved change and report concrete verification.",
    "deps": ["plan"]
  }
]
```

Each node needs a unique `id` and a complete `task`. It may also specify `deps`, `model`, `read_only`, `tools`, and `subagent_type`. At least one node must have no dependencies. A workflow may contain up to 64 nodes; dependency ids must exist, and cycles are rejected.

Use a workflow when steps have an order or pass results between stages, such as `gather → analyze → write`. Every node is a fresh sub-agent that cannot see the parent conversation. A dependent receives only the direct dependency's `## Handover` block, capped at 4,000 characters. Without that heading it receives only the bounded end of the dependency result, so write concise handovers for downstream nodes. For unrelated work, separate parallel `Delegate` calls are simpler.

By default, `WorkflowStart` returns a handle and Elowen delivers the workflow summary when the DAG finishes. Set `background: false`, as an argument or in the file, to wait for the whole DAG and receive the node results as the tool result; an explicit argument overrides the file. A blocking run can still be detached with **`Ctrl+B`** without cancelling it. Delivery is the only thing this choice changes: nodes keep running in dependency order either way, and a background workflow continues even if the conversation that started it is aborted.

## Control a running workflow

The workflow id returned by `WorkflowStart` is used with these tools:

- `WorkflowStatus` shows the overall state and each node's status, dependencies, token count, elapsed time, and current activity. It does not return node output text.
- `WorkflowAddNodes` extends a running DAG when a node discovers follow-up work. New nodes must be unique, keep the combined graph acyclic, and start when their dependencies are ready.
- `WorkflowStop` stops a running workflow from the conversation that started it. Completed nodes keep their results.
- `WorkflowResume` retries only unfinished nodes. Completed nodes are not rerun; a node that had started can continue in its existing child conversation when the original boundary is still valid.

A node whose dependency errors is reported as `skipped`, rather than being run without the result it required. Nodes added dynamically inherit the adding node's narrower authority and cannot widen the workflow's original access.

![Workflow view as a spatial DAG canvas](../screenshots/cli/17-workflow-modal.png)

## Recovery and boundaries

Sub-agent and workflow state is recorded with the parent conversation. Running workflows also have a recovery journal, so the daemon attempts to recover interrupted work after a restart. Recovery is not unconditional: if the journal, plugin, captured scope, or required runtime is unavailable, Elowen terminalizes the workflow instead of replaying uncertain mutations.

Authority is always inherited and can only become narrower. Selecting another model does not change Project, tool, memory, or permission access. External actions such as publishing code, sending messages, deploying, or restarting services still require the authority and confirmations appropriate to that action.

[Next: AI Providers, Models & Sub-agents](agents-providers)
