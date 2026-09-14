---
title: Projects, Environments & GitHub
slug: projects-workflow
order: 16
eyebrow: Workspace
group: Workspace
---

# Projects, Environments & GitHub

Elowen separates three parts of repository work:

- **Projects** define which repository or working directory an account may access.
- **Environments** run a managed Project inside its own persistent container instead of on the host.
- **GitHub** connects an account's GitHub identity to a Project and publishes committed branches.

![Projects workspace](images/projects-list.png)

## Projects are the access boundary

Open **Projects** in the main navigation and select a Project to inspect it. An administrator registers a stable slug and filesystem path, with optional notes and a project icon. Assign Projects to members from **Users** or the Project's **Access** section. An account cannot use a Project merely because another account can see it.

The Project overview is read-only. It shows the checkout's current branch and `HEAD`, upstream and ahead/behind counts, dirty and untracked counts, sanitized remotes, local branches, and recent commits. Registering or removing a Project does not delete the repository files on disk.

Core Projects does not create worktrees, store GitHub credentials, publish branches, or manage pull requests. Worktrees are created with native `git worktree` in your own checkout; publishing and pull requests belong to the GitHub plugin below.

## Work in a Git worktree

Isolated or parallel Git work is a worktree you create yourself with native `git worktree`, in your own checkout. Elowen does not create, bind or remove worktrees for a conversation.

1. Create the worktree in your checkout, for example `git worktree add ../elowen-feature -b feature-branch`.
2. Point the conversation at it with `/cd <path>` in owner chat, or start the conversation in that directory.
3. Work and commit there as usual with `git`.

Moving a conversation with `/cd` does not widen Project access: the destination must be a directory the account can already reach, and a delegated child inherits the conversation's working directory without widening it. A worktree is an ordinary directory, so nothing about confinement changes by working in one; the account's Project boundary is what the file and shell tools enforce.

## Managed Project environments

A managed Project does not run on the host. It runs in its own persistent container that survives across turns, on a disk holding its files, HOME and data, and it is provisioned on demand. Resource limits, provisioning defaults and networking are configured on the Project.

Lifecycle tools write durable requests, and daemon reconciliation performs the work: `EnvironmentStart`, `EnvironmentStop`, `EnvironmentSnapshot` and `EnvironmentRestore` return an operation immediately and `EnvironmentOperation` reports its real status, while `EnvironmentStatus` reads the state without starting anything and `EnvironmentLogs` reads the bounded lifecycle log and the guest journal. Stopping interrupts the Project's services and running commands but preserves files and installed packages. A snapshot is crash-consistent rather than database-consistent, so an application database may need its own export, and a restore replaces the environment in a fresh generation after explicit confirmation.

`EnvironmentWorktrees` lists, creates and removes organizational worktrees inside the shared environment, on branches named `elowen/<slug>-<suffix>`. They separate unfinished work between people on the same Project, are not security-isolated, never bind a conversation, and can be changed only while the environment is idle. They are not the worktree you create in your own checkout.

## Account development environment

Every account owns a private `HOME` holding its Git, npm and tool configuration. Administrators see it at **Users → select an account → Development environment**, together with the execution mode, its confinement probe, active processes, and the Git author name and email. **Reset HOME** removes that configuration, and active processes block the reset.

Fresh configuration confines non-operator commands by default. The confinement mounts only the account's accessible Projects and its account `HOME`, and network access remains available. If the live bubblewrap probe fails, required confinement is refused. An operator can deliberately disable `sandbox.confineNonOperators`, which lets granted non-operators run commands directly on the host.

## Optional Project integrations

These integrations are registry plugins. Install and enable them from **Settings → Plugins → Available**; they are not part of the bundled Project surface, and their pages appear only when the plugin is available to the account.

### OneDrive mirrors

The optional **OneDrive** plugin adds a Project tab that mirrors a selected Project folder into the linked account's own OneDrive in both directions. It requires the account's Microsoft identity to be connected and may require an administrator to grant the plugin.

Choose the whole Project or one folder, then use the mirror controls to pause, resume, sync now, inspect conflicts, or disconnect. Files excluded by `.gitignore`, version-control internals, dependencies, environment files, private keys, and credentials are never mirrored. A remote deletion is kept in the mirror's `.elowen-trash` area rather than removed permanently, and a conflict keeps both versions until you choose which copy wins.

### Published Sites

The optional **Sites** plugin publishes an address that forwards to an application already running inside an explicit managed Project. `SiteCreate` records the Project and its loopback port; `SitePublish` verifies that service through the durable Project transport and starts or copies nothing.

Sites can be private, visible to Project members, available to signed-in accounts, shared with named guests, or made public through an explicit confirmation in the Sites UI. Application lifecycle, source, logs and resource limits belong to the managed Project. File publications created by older releases keep serving and rolling back their retained files, but new file publications cannot be created or published.

### Project Editor

The optional **Editor** plugin provides `/p/editor` for browsing and editing accessible Project files. It supports file and folder operations, uploads, Markdown, image, PDF, media, Office, and CSV previews, plus read-only Git history. The editor does not widen Project access, and its administrator-only System root is separate from ordinary Project editing.

## Connect GitHub and publish a branch

GitHub is account-scoped. Go to **Account settings → GitHub** and choose **Connect GitHub** to complete the device login. Each account keeps its own GitHub identity and credentials. If GitHub reports an expired authorization, reconnect the account; Elowen does not silently refresh it.

### Map a Project

Open **Project → GitHub** and use **Detect** to inspect the Project's Git remotes, or enter the mapping manually. A mapping has:

- a **Base repository**, used for the pull request target;
- a **Push repository**, used to publish the branch.

The two repositories may differ, which supports a fork workflow. Mappings belong to the account and Project, and every operation starts from a Project the account can currently access.

### Publish, review, and merge

The normal flow is:

1. Work in your own checkout, in a `git worktree` when you want isolation, and commit the changes.
2. In **Project → GitHub**, choose **Publish branch**. Publishing requires a connected GitHub account, a verified repository mapping, and a committed `HEAD` on an Elowen-created branch.
3. Choose **Create pull request**, then inspect the pull request's changed files, reviews, and checks.
4. Submit a review or merge the pull request after reviewing the external-action confirmation.

Creating a pull request reuses an existing open pull request with the same base and head instead of creating a duplicate. Checks are reported as `pending`, `success`, `failure`, or `action_required`. Merge methods are **Squash**, **Merge commit**, and **Rebase**; the default is **Squash**.

A merge is accepted only when the pull request is still open and non-draft, its head matches the expected commit exactly, checks are successful, no current review requests changes, and the repository supports the selected method. Branch force-push, automatic branch deletion, and auto-merge are not available.

GitHub never creates or removes Git worktrees. It publishes the branch of the checkout the conversation is working in, which is the Project checkout or a worktree you created and pointed the conversation at.

## CLI and agent tools

There is no dedicated GitHub CLI command. The generic authenticated API passthrough can read its routes:

```bash
elowen api GET /plugins/github/api/status
```

The corresponding agent tools are the GitHub read and write tools exposed by the GitHub plugin. GitHub mutations require an interactive confirmation; delegated, scheduled, and unattended contexts remain read-only.

For access rules, see [Users & Access](users-access). For plugin configuration, see [Plugins](plugins).

[Next: Scheduling](scheduling)
