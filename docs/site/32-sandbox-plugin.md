---
title: Sandbox & Environments
slug: sandbox-plugin
order: 32
eyebrow: Plugin reference
group: Plugin reference
---

# Sandbox & Environments

The `sandbox` plugin, listed in **Settings → Plugins** under the label Environments, gives each linked account a private development environment and real Git worktrees, and runs persistent container environments for managed Projects. It has two halves. Account worktrees give one conversation an isolated checkout of a Project branch, with its own commit flow. Project environments are long-lived machines with a persistent disk of their own that host services, worktrees and data, and can be started, stopped, snapshotted and restored. The plugin also owns how command execution is contained for accounts without operator authority.

For how Projects, Sandbox and GitHub fit together from a member's point of view, see [Projects, Sandbox & GitHub](projects-workflow). This page documents the plugin itself: surfaces, tools, settings, and the limits visible in its behavior.

## Where it appears

- **Settings → Plugins** shows the bundled card `sandbox`, label **Environments**.
- The **Project → Environments** page lists the workspaces of that Project and offers create, activate, commit, discard and remove. The account-wide view can search and filter workspaces across all accessible Projects.
- **Account → Development environment** is an administrator view of one account's private HOME, its execution mode and confinement probe, active processes, Git author name and email, and **Reset HOME**.

The plugin registers no slash command of its own. Workspaces are created and selected through the tools below or from the Environments page.

### Workspace tools

| Tool | What it does |
| --- | --- |
| `SandboxListWorkspaces` | Lists the account's workspaces with branch, base ref, active binding and live dirty, untracked and ahead/behind counts, limited to Projects the account can currently access. |
| `SandboxCreateWorkspace` | Creates a real Git worktree for one accessible Project from a label and a base ref, without changing the conversation's active workspace. |
| `SandboxUseWorkspace` | Binds a workspace to this conversation and Project, so relative file and shell operations resolve inside the worktree. |
| `SandboxReleaseWorkspace` | Unbinds the conversation's workspaces and hands the Project directory back, preserving the worktree, branch and files. |
| `SandboxCommit` | Commits explicitly listed workspace-relative paths in the active workspace and reports what remains uncommitted. |
| `SandboxRemoveWorkspace` | Removes a workspace only when it is clean, has no untracked files, no commits beyond its base ref and no running process. |

### Environment tools

| Tool | What it does |
| --- | --- |
| `EnvironmentStatus` | Reads a managed Project's runtime state, desired state, generation and limits without starting anything. |
| `EnvironmentStart` | Requests a start of the persistent environment, preserving existing files and installed packages. |
| `EnvironmentStop` | Requests a stop, which interrupts project services and running commands; the tool contract requires confirming with the user first. |
| `EnvironmentSnapshot` | Requests a crash-consistent snapshot of the root filesystem, HOME, worktrees and data while execution is paused. |
| `EnvironmentRestore` | Requests replacement of the environment with a retained snapshot in a fresh generation; requires the user's explicit confirmation first. |
| `EnvironmentLogs` | Reads bounded lifecycle logs and the guest system journal, up to 1,000 lines. |
| `EnvironmentOperation` | Reports the real status of a previously requested operation, because a pending request is not a completed action. |
| `EnvironmentWorktrees` | Lists, creates or removes organizational Git worktrees inside the shared Project container, which do not bind the conversation. |

## Enable the plugin

The plugin is bundled and enabled in a fresh installation. No install, registry download or per-user grant is involved: the manifest does not mark it user-grantable, so availability follows the normal account and tool permissions described in [Users & Access](users-access). Environment tools additionally require access to a managed Project.

## Configuration

The plugin has one instance-wide configuration, edited in its detail view under [Configuration](configuration). There is no per-account settings schema; the account-level Git author and HOME reset live on the Development environment page instead.

| Field | Key | Type | Default | What it does |
| --- | --- | --- | --- | --- |
| Execution | `sec_execution` | section | not set | Form section heading for how commands from accounts without operator authority are contained. |
| Confine non-operator commands | `confineNonOperators` | boolean | `true` | Runs non-operator commands in bubblewrap with only their accessible Projects, workspaces and account HOME mounted. Network access stays available. If the live namespace probe fails, execution is refused rather than run unconfined. |
| Environment defaults | `sec_resources` | section | not set | Form section heading for the resources a project environment receives when it is first provisioned. |
| Processor | `defaultCpus` | number, slider | `1` | CPU cores a newly provisioned environment may use, 0.1 to 64, enforced by the CPU quota. |
| Memory | `defaultMemoryMb` | number, slider | `1024` | Memory ceiling in MiB, 128 to 65536. A process that exceeds it is terminated by the kernel. |
| Processes | `defaultPidsLimit` | number, slider | `512` | Maximum number of processes and threads inside the environment, 32 to 8192. |

The three resource defaults apply when an environment is first provisioned. Existing environments keep the limits they were created with; an administrator changes those on the Project itself, and a change is applied to the running environment without a restart. If a configured value is missing or unusable, provisioning falls back to the built-in figures of 1 CPU, 1024 MiB memory and 512 processes.

## The normal workspace flow

An operator usually works like this:

1. **List or create.** `SandboxCreateWorkspace` takes an accessible Project, a label and a base ref such as `main`. The label becomes the worktree directory and a branch named `elowen/u<account>/<slugified-label>`; a numeric suffix is added only when the directory or branch already exists. Creation never changes the current conversation.
2. **Activate.** `SandboxUseWorkspace` binds the workspace to this conversation and Project. One workspace is active per conversation and Project; after that, relative file operations and shell commands resolve inside the worktree, while explicit paths remain guarded by the account's Project access.
3. **Commit.** `SandboxCommit` stages exactly the workspace-relative paths listed and never stages everything at once. Repository hooks are disabled. Unselected changes stay in the workspace and are reported after the commit.
4. **Release or remove.** `SandboxReleaseWorkspace` unbinds the conversation; `SandboxRemoveWorkspace` deletes a clean worktree and its generated branch.

Release and remove are deliberately different. Releasing destroys nothing: the workspace, its branch and its directory are preserved and can be re-activated later. It is refused while a process still runs in the workspace. Removing deletes the worktree directory and the branch, so the work in it is gone. The tool removes only a workspace whose tree is clean, with no untracked files, no commits beyond its base ref and no active process lease. A workspace with changes or commits is discarded from the Project's Environments page, which shows a loss preview and requires typing the displayed confirmation phrase; active processes always block removal.

Every activation, commit and execution is re-checked against the account's current Project access. If access to the source Project is revoked, the workspace remains owned but cannot be activated, committed or used. If the Project is removed or the worktree path disappears, the workspace becomes orphaned and is likewise unusable. A workspace reference always names both the workspace and its Project and cannot be widened back to the whole Project.

The workspace detail on the Project page shows its path, branch, changed and untracked files, ahead and behind counts, active processes and working patch.

## Account HOME

Every linked account owns a private HOME directory holding its Git, npm and tool configuration. It belongs to the account rather than to any single project, and it carries a generation counter: a reset produces a new generation, and leases record the generation they were launched with. **Reset HOME** on the Development environment page removes that configuration; workspaces are preserved, and active processes block the reset. Removing an account removes its workspaces, environment access and account data with it.

## Confined execution and the plain terminal

The plugin changes what a shell command means depending on who runs it and where:

- An operator running commands outside a workspace executes them directly on the host, as in the plain terminal described in [Terminal & Processes](terminal-plugin).
- Commands from accounts without operator authority run confined by default: a bubblewrap namespace that mounts only the account's accessible Projects, its workspaces and its account HOME. Network access remains available for package installation, Git and development servers. If the live bubblewrap probe fails, such a command is refused rather than started without containment. An administrator can set `confineNonOperators` to `false`, which lets those accounts run directly on the host.
- A shell launched from inside a Sandbox workspace is always pinned into that worktree, mounted at `/workspace`, with a workspace-private HOME, even for an operator. Path prefixes in output are rewritten to `/workspace` so the transcript shows guest paths.
- Work that plugins start in the background is always confined, regardless of the setting above.

A confined terminal session is the only command surface that receives the account's GitHub credential, and any output containing the token is redacted. Commands in a managed Project run inside the Project's own container and are not governed by the confinement setting at all.

## Persistent Project environments

A managed Project has one persistent environment. A new environment is built on the systemd-nspawn machine runtime, which the installer provisions and which the host must carry before the first environment can be created; environments created earlier keep running under rootless Podman until an administrator migrates them. It is provisioned on demand the first time it is needed and reports one of the states unprovisioned, starting, running, stopped, failed, deleting or deleted.

Lifecycle tools write durable requests, and daemon reconciliation performs the actual work. `EnvironmentStart`, `EnvironmentStop`, `EnvironmentSnapshot` and `EnvironmentRestore` return an operation immediately; `EnvironmentOperation` reports its real status. Reuse the same request id to retry an interrupted request without queuing a second one, and pass an expected generation to fail cleanly if the environment changed in the meantime. `EnvironmentLogs` reads the bounded lifecycle log and the guest system journal; `EnvironmentStatus` reads state without starting anything.

An environment that predates persistent disks is moved onto one with a disk migration, and an environment already on a persistent disk is moved from Podman to the machine runtime with a runtime migration. Both are administrator-only, are requested like any other lifecycle operation, and a runtime change copies no data: the same disk keeps running under a different envelope.

Stopping interrupts shared project services and running commands while preserving files and installed packages. A snapshot pauses execution and captures the root filesystem, HOME, worktrees and data. It is crash-consistent, not database-consistent, so an application database may need its own export; a note up to 2,000 characters can describe it. Project snapshots always include every component. A restore replaces the environment with the chosen snapshot in a fresh generation, discarding everything since the snapshot and interrupting running work, so it requires the user's explicit confirmation first. Deleting a Project deletes its environment with it; published Sites must be transferred or deleted first, and cleanup completion is reported asynchronously.

`EnvironmentWorktrees` lists, creates and removes organizational worktrees inside the shared container, on branches named `elowen/<slug>-<suffix>`. They separate unfinished work between people on the same Project but are not security-isolated, never bind the conversation, and can be mutated only while the environment is idle.

## Permissions and consent

The manifest declares no mutating consent categories, so enabling the plugin does not prompt for a power acknowledgment. It does declare read access to the database, the host stores, Git state, project files and the control plane; the host verifies those declarations when the plugin registers.

Project boundaries remain the real gate. Every workspace operation, environment request and explicit file path is checked against the account's current Project access at call time, and a delegated child pinned to a workspace cannot switch or release its assignment. The account Development environment page and resource limit changes on a Project are administrator-only surfaces. `SandboxListWorkspaces` is safe to call during plan mode.

## Known limits

- Workspaces require a Git Project; they cannot be created from a non-Git Project.
- One workspace is active per conversation and Project, and an explicitly workspace-scoped child cannot change or release its assignment.
- Workspace removal through the tool never force-deletes; dirty workspaces can only be discarded through the browser flow with its loss preview and confirmation phrase.
- Release and removal are blocked while a process lease is active; stale leases are reaped automatically.
- Environment tools work only on managed Projects and refuse anything else.
- Snapshots are crash-consistent rather than database-consistent, and databases may need a separate export before a restore.
- Resource limits are fixed at provisioning for an existing environment until an administrator changes them on the Project.
- A new environment needs the machine runtime on the host: the privileged helper, the machine unit template and the polkit rule, installed by `elowen install` and `elowen update`. Podman is still needed as the image store. When either is unavailable, the first start refuses and names what is missing.
- If legacy and current account HOME directories both exist after an upgrade, startup migration is refused and the readiness panel names the collision for an operator to resolve.

For the account HOME, reset behavior and Git author, see [Projects, Sandbox & GitHub](projects-workflow). For plugin settings in general, see [Plugins](plugins).

[Next: Sub-agent Plugin](subagent-plugin)