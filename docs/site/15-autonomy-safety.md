---
title: Autonomy & Safety
slug: autonomy-safety
order: 15
eyebrow: Automation
group: Automation
---

# Autonomy & Safety

Elowen's autonomy is built from persistent goals, delegation, workflow DAGs, and explicit permission boundaries. It does not rely on the retired mission/autopilot/overseer subsystem.

Two principles hold everywhere:

- **Authority is inherited, never invented.** A goal or delegated child starts from the current account, Project access, tool grants, and permission rules, then may only narrow them.
- **Unverifiable work fails closed.** Missing ownership, unavailable controls, absent credentials, or an unattended decision never become an implicit approval.

## Persistent goals

Set a goal with `/goal <outcome>`. The conversation works toward it across turns until it provides evidence of completion, reaches a blocker, is paused, or spends its turn budget.

A goal can report:

- `PROGRESS: ...` — durable progress carried into the next goal turn;
- `SUBGOAL_DONE: <n>` — one checklist item completed;
- `GOAL_DONE: <evidence>` — completion with concrete verification;
- `GOAL_BLOCKED: <reason>` — a blocker that requires a person or changed environment.

Use `/goal draft` to prepare a contract before running it, `/subgoal <text>` to add checklist items, and `/goal status|pause|resume|clear` to manage it.

### Turn budgets

A supervised goal pauses when its configured turn budget is spent. A conversation running in YOLO may continue past that budget, but never beyond the separate hard ceiling. Both values are bounded by daemon configuration; neither bypasses permissions or makes destructive actions acceptable.

A persistent goal advances only while its conversation has a live driver. Losing that driver or restarting the daemon pauses the goal rather than silently resuming unattended work.

## Delegated sub-agents

`Delegate` creates an isolated child conversation for one focused task. The child receives an immutable execution scope captured from the caller: allowed Projects, read-only status, tool policy, and non-interactive permission boundary.

- A read-only child cannot write.
- A writable child cannot exceed the caller's current authority.
- `DelegateContinue` reuses the child's own transcript and original boundary.
- Explicit promotion is permitted only for a caller-created read-only clamp and only up to the caller's current access.
- Unknown, malformed, foreign, or stale scopes are refused.

Delegated children can inherit the delegator's account-scoped plugin contributions without receiving a personal memory identity. This lets them use the correct account integration while keeping memory and person identity boundaries separate.

## Workflow DAGs

A workflow is a directed graph of delegated children. Independent nodes may run in parallel; dependent nodes wait for required results. Node access is inherited from the node that creates it, so dynamic expansion cannot widen the workflow's original authority.

Workflow and sub-agent lifecycle is durable. Boot recovery claims interrupted work through the recovery coordinator, validates its stored scope, and reports uncertain mutation state instead of replaying blindly.

## Tool permissions

Per-account tool authority combines:

1. an explicit allow-list of tools the account may use;
2. ordered allow/ask/deny rules for tools and shell commands;
3. any narrower turn, channel, planning, or delegated boundary.

An interactive `ask` parks the turn until the user answers. In unattended work, the captured policy decides whether an ask may proceed; otherwise it is denied. Explicit deny rules remain authoritative even in YOLO.

Plan mode keeps the normal tool catalogue stable for prompt caching, but write attempts are rejected at execution time. Delegated children inherit that read-only clamp.

## Account and Project isolation

Shared rooms resolve authority from the current verified writer, not from whoever opened the room. Personal tools, plugin config, encrypted plugin secrets, Project scope, and owned scheduled work follow that contribution account. An unlinked sender receives no guessed account.

Revoking Project access immediately removes that Project from the account's path policy. Disabling a capability owner never widens access or substitutes a shared fallback.

## External actions

Sending a message, publishing code, pushing a branch, merging, deploying, or restarting shared services requires the authority appropriate to that action. A plugin may add a confirmation protocol, but presentation is not authority: the server must bind confirmations to the current account, target, and expected state, then recheck immediately before mutation.

[Next: Projects & Git](projects-workflow)
