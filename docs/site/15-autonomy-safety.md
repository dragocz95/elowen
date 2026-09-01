---
title: Autonomy & Safety
slug: autonomy-safety
order: 15
eyebrow: Automation
group: Automation
---

# Autonomy & Safety

Elowen can continue work across turns, delegate focused work, and run workflow graphs. Its safety model is layered: the current account, Project access, tool grants, permission rules, conversation mode, and any integration-specific confirmation all apply together.

Two rules apply everywhere:

- **Authority is inherited, never invented.** Goals and delegated work start with the caller's current access and may only narrow it.
- **Unverifiable work fails closed.** Missing ownership, credentials, permission, or a required human decision stops or refuses the operation instead of approving it implicitly.

## Choose a work mode

The Web chat and `elowen chat` CLI provide the same three work modes:

```text
/plan       Think through the approach before editing
/build      Implement changes with tools
/workflow   Orchestrate the request as a DAG of sub-agents
```

You can also choose these modes from the chat command menu.

### Plan mode

Plan mode is enforced at tool execution time. Mutating tools are refused; `Write` and `Edit` may write only this conversation's plan file. When the plan is submitted, Elowen shows it as a decision point:

- **Implement** switches to Build mode and starts the implementation.
- **Cancel** keeps the conversation in Plan mode so you can refine it.

Plan mode is a guardrail, not a filesystem sandbox. Its shell rules block common destructive commands, but shell redirection and some interpreters can still write files the daemon user can reach. Do not use Plan mode as isolation for untrusted code.

## Persistent goals

In `elowen chat` or Web chat, set a goal with `/goal <outcome>`:

```text
/goal draft Prepare a release checklist       # create a draft contract only
/goal Prepare a release checklist              # start working toward the outcome
/goal status                                   # inspect the current goal
/goal pause
/goal resume
/goal clear
/subgoal Add a smoke-test step                 # add a checklist item
/subgoal remove 1
/subgoal clear
```

A goal belongs to the conversation that created it and runs its kickoff and continuation turns in Build mode. It stores progress, subgoals, status, the last evidence, and any pause reason. Goal turns use these markers:

- `PROGRESS: ...` — durable progress carried into the next continuation;
- `SUBGOAL_DONE: <n>` — marks a numbered subgoal complete;
- `GOAL_DONE: <evidence>` — completes the goal only with concrete evidence and no open subgoals;
- `GOAL_BLOCKED: <reason>` — pauses on a blocker that needs a person or a changed environment.

### Goal limits and resuming

The instance owner can adjust **Settings → Elowen AI → Limits**:

- **Goal turn budget** — the default number of autonomous turns before a supervised goal pauses;
- **Goal safety ceiling** — the absolute maximum number of autonomous goal turns, including YOLO.

Both default to **50**. Outside YOLO, `/goal resume` is required after the turn budget is reached; resuming an exhausted goal starts a fresh budget window. YOLO may continue past the per-window budget, but never past the safety ceiling.

A goal also needs a live driver: the active conversation or an attached client session. Switching away, losing the driver, or restarting the daemon pauses the goal. Goals never silently resume after a restart; use `/goal resume` when you are ready.

## Tool permissions and approvals

Open **Account → Elowen AI → Command permissions** to manage personal permission rules. The editor has separate lists for Bash command patterns and tool-name patterns. Each rule is one of:

- **Allow** — run without asking;
- **Ask** — request approval in interactive Web or CLI chat;
- **Deny** — refuse the call.

Rules use `*` as a wildcard and the **last matching rule wins**. Put broad rules first and specific exceptions later. Examples:

```text
git status*    Allow    # Bash command pattern
rm *           Deny     # Bash command pattern
Write          Ask      # tool-name pattern
```

Built-in safety rules are applied underneath your rules. An approval prompt's **Always allow** action saves a matching rule in this editor.

An `Ask` rule behaves differently depending on where the turn runs:

- In Web or CLI chat, the turn waits for your answer. Cancelling the prompt fails closed.
- In a scheduled job, platform channel, or delegated child, nobody can answer a prompt. The **Unattended runs** setting in the same Account → Elowen AI section controls the result: **Allow** is the default; **Block** refuses the ask.

The **YOLO mode** toggle in **Account → Elowen AI** auto-approves asks in new sessions. In the CLI, `/yolo`, `/yolo on`, and `/yolo off` change the effective setting for the current session. YOLO never overrides an effective `Deny` rule, and it does not override unattended **Block** mode.

A tool permission cannot grant a tool that the account does not otherwise have. A narrower Project, channel, plan, or delegated boundary can reduce access further.

## Delegated sub-agents

`Delegate` starts a child conversation for one focused task. It captures an immutable execution scope containing the caller's accessible Projects, owner/admin status, tool policy, permission boundary, contribution account, and read-only state.

- A child cannot exceed the caller's current authority.
- `DelegateContinue` resumes the child's own transcript, not the parent's.
- Continuing is refused if Projects, tool grants, owner authority, or permission rules have become broader than the caller's current access.
- `write_access: true` can promote only a read-only child that the same caller explicitly requested as read-only. A read-only mode imposed by Plan mode or by the child type cannot be promoted.
- A delegated child does not receive the parent's personal memory identity, although it can inherit the account-scoped plugin contributions needed for the task.

`read_only: true` removes write tools and applies a non-destructive shell guardrail. It is **not** a sandbox: shell redirection can still write files reachable by the daemon user, so use Project and Sandbox boundaries for filesystem isolation.

## Workflow DAGs

`WorkflowStart` runs a directed graph of delegated children. Independent nodes can run in parallel; a node with dependencies waits for their results and receives those results as context. `WorkflowResume` continues only unfinished work. A node added dynamically inherits the creating node's current scope and cannot widen the workflow's original authority.

A running node may use `WorkflowAddNodes` to extend its own workflow when that workflow engine is local to the process. A node executing in a forked runner reaches the owning engine through the host RPC bridge; if that capability is unavailable, the node is not given `WorkflowAddNodes` rather than being given a tool that cannot work. Nested workflows remain local to the runner that owns them and do not jump to the parent's engine.

Delegations and workflows have durable state. After a daemon restart, Elowen attempts recovery using the stored scope and workflow journal. If safe recovery cannot be established, the work is refused, parked for recovery, or terminalized with the completed portion preserved; it is not blindly replayed under a wider account scope. A continuation re-checks the caller's current Projects, account contribution, workspace, model-session boundary, tool policy, and non-interactive permission rules before delivering work.

## Account, Project, and Sandbox isolation

In a shared room, authority is resolved from the current verified writer, not from whoever opened the room. Personal tools, plugin configuration, encrypted plugin secrets, Project scope, and scheduled work follow that contribution account. An unlinked sender does not get a guessed account.

File tools remain path-confined to accessible Project roots. Fresh configuration also bubblewrap-confines non-operator terminal commands, but an operator can deliberately set `sandbox.confineNonOperators` to `false`, allowing granted non-operators to run commands directly on the host. Workspace-scoped execution remains confined and fails closed when its boundary cannot be established.

Revoking Project access removes that Project from the account's path policy. Removing a tool grant or disabling its owning plugin does not create a fallback with broader access.

## External actions

Publishing code, pushing a branch, reviewing or merging a pull request, deploying, sending messages, and restarting shared services each require the authority appropriate to that action. An approval dialog is not itself authority: the server must bind any confirmation to the current account, target, and expected state, then recheck those values immediately before the mutation.

For example, GitHub mutating tools require an interactive verified conversation. Delegated, scheduled, and other unattended contexts may inspect GitHub state but cannot publish, review, or merge through those tools.

See [Your Account & Preferences](account-preferences), [Sub-agents & Workflows](tasks-missions), and [Projects, Sandbox & GitHub](projects-workflow) for the operating details of these features.
