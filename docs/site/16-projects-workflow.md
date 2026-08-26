---
title: Projects & Git
slug: projects-workflow
order: 16
eyebrow: Workspace
group: Workspace
---

# Projects & Git

A Project is Elowen's explicit boundary around a repository or working directory. It supplies a stable path, project-specific context, user access scope, and the read-only Git information shown in the Projects workspace. Registering a Project does not make other paths on the machine available to an account.

![Projects workspace](images/projects-list.png)

## Register a Project

An administrator adds a Project with a stable slug and filesystem path. A Project can also have:

| Field | Purpose |
| --- | --- |
| **Notes** | Durable context available to the assistant while working in this Project. |
| **Icon** | An optional project-relative image used in the UI. |

The slug remains stable after creation. Removing a Project deletes its core access assignments and project-bound memory categories, but never deletes repository files. Enabled plugins receive the Project-removal lifecycle event; plugins also reconcile their own state when enabled after an offline deletion.

Assign Projects to users in **Users**. The daemon applies that scope alongside each account's model, plugin, and tool policy, so a conversation cannot reach a repository simply because another account can see it.

## Inspect Git state

The Projects workspace provides a read-only checkout snapshot: current branch and HEAD, upstream and ahead/behind counts, dirty and untracked counts, sanitized remotes, local branches, and recent commits. Embedded credentials are removed from remote URLs before data reaches an API or plugin.

Core Projects does not own pull requests, repository mappings, publication, worktrees, or Git credentials. Those workflows belong to dedicated plugins and remain separate from Project registration and tenancy.

## Files and editor

Project file operations and the browser editor are plugin-owned surfaces. They use the core Project path guard and current account access rather than introducing a second filesystem policy. Disabling an editor or file plugin removes that surface without removing the Project itself.

For access rules, see [Users & Access](users-access). For plugin capabilities, see [Plugins](plugins).

[Next: Scheduling](scheduling)
