---
title: Projects & Workflow
slug: projects-workflow
order: 9
eyebrow: Guide
---

# Projects & Workflow

A project is Elowen's explicit boundary around a repository. It gives tasks a working directory, supplies planner context, scopes user access, and connects the Web UI's Projects and Editor workspaces to a real Git checkout. Adding a project does not make every path on the machine available to the agent.

![Projects workspace](images/projects-list.png)

## Register a project

An administrator adds a project with a stable slug and repository path. A project can also have:

| Field | Purpose |
| --- | --- |
| **Notes** | Durable, project-specific guidance for planning and mission work. |
| **Icon** | An optional project-relative image used in the UI. |
| **PR workflow** | A per-project override: inherit, enable, or disable the global default. |

The slug remains stable after creation. Removing a project detaches its Elowen records—tasks, mission data, active-agent references, and access grants—but never deletes the repository files themselves.

Assign projects to users in **Users**. The daemon applies that project scope alongside the user's model and tool policy, so a conversation cannot reach a repository simply because it is visible in another person's workspace.

## Inspect Git state

The Projects workspace exposes the information needed to make a safe decision before or after agent work: branch, dirty state, changed files, recent commits, commit patches, and working-tree diffs. The current project's icon is used where the UI represents that project; generic fallback art is only used when no icon has been configured.

Open a file, diff, or commit in the Editor. Detail views use a bounded modal or drawer so you can return to the exact project list or timeline context you came from.

![Built-in project editor](images/projects-editor.png)

## Shared checkout work

Normal tasks use the project's checkout. Elowen coordinates task dispatch and Git-sensitive operations so simultaneous work does not casually overwrite the same repository state. A task records the associated worker and can expose changed files, commits, and usage in its detail view.

This is the right mode for a focused task you are actively watching. For a larger change that should remain isolated until review, use a mission with the PR workflow.

## PR workflow

The optional PR workflow creates an isolated worktree for a mission. It is controlled by the mission's explicit setting, then its project override, then the workspace default.

1. Create or engage a mission with PR workflow enabled.
2. Elowen creates a branch and separate worktree for that mission.
3. Its phases work in that isolated checkout.
4. The configured GitHub/PR settings determine verification, base branch, and whether a PR opens automatically.
5. The mission keeps its worktree lifecycle tied to the mission rather than modifying your shared checkout by surprise.

Configure GitHub credentials and defaults in **Settings → GitHub**. Credentials are write-only in the Web UI. A configured verification command is a quality gate you own; it is not a claim that every repository has been fully tested.

## Handoff notes and worker control

Mission workers can leave short notes for later phases:

```bash
elowen note add <mission-id> "Explain the remaining follow-up"
elowen note ls <mission-id>
```

Workers also receive a scoped `elowen help` and `elowen ask` interface so they can read their task context or ask the autopilot/human a question. Those controls inherit the mission's authenticated scope.

For task state and mission execution, see [Tasks & Missions](tasks-missions). For the editor and project UI, see [Web UI](web-ui).

[Next: Configuration](configuration)
