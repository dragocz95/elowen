---
title: Sandbox & Environments
slug: sandbox-plugin
order: 32
eyebrow: Plugin reference
group: Plugin reference
---

# Sandbox & Environments

The bundled `sandbox` plugin, listed in **Settings → Plugins** under the label Environments, owns two things: how command execution is contained for accounts without operator authority, and the persistent machine environment a managed Project runs in. Account-owned Git workspaces no longer exist: isolated or parallel Git work is a worktree you create yourself with native `git worktree`, as described in [Projects, Environments & GitHub](projects-workflow).

That page covers how Projects, environments and GitHub fit together from a member's point of view. This page documents the plugin itself: its surfaces, tools, settings and limits.

## Where it appears

- **Settings → Plugins** shows the bundled card `sandbox`, label **Environments**. Its detail view carries the **Host runtime** readiness section.
- The **Project → Environments** page shows that Project's environment: state, generation, effective limits, live usage, snapshots, logs and its organizational worktrees.
- **Account → Development environment**, in the account view of an administrator, is one account's private HOME: its execution mode and confinement probe, active processes, the Git author name and email, and **Reset HOME**.

The plugin registers no slash command of its own.

## Environment tools

| Tool | What it does |
| --- | --- |
| `EnvironmentStatus` | Reads a managed Project's runtime state, desired state, generation and limits without starting anything. |
| `EnvironmentStart` | Requests a start of the persistent environment, preserving existing files and installed packages. |
| `EnvironmentStop` | Requests a stop, which interrupts project services and running commands; the tool contract requires confirming with the user first. |
| `EnvironmentSnapshot` | Requests a crash-consistent snapshot of the root filesystem, HOME, worktrees and data while execution is paused. |
| `EnvironmentRestore` | Requests replacement of the environment with a retained snapshot in a fresh generation; requires the user's explicit confirmation first. |
| `EnvironmentLogs` | Reads bounded lifecycle logs and the guest system journal, up to 1,000 lines. |
| `EnvironmentOperation` | Reports the real status of a previously requested operation, because a pending request is not a completed action. |
| `EnvironmentWorktrees` | Lists, creates or removes organizational Git worktrees inside the shared Project environment, which do not bind the conversation. |

Every environment tool refuses a Project that is not a managed environment.

## Enable the plugin

The plugin is bundled and enabled in a fresh installation. No install, registry download or per-user grant is involved: the manifest does not mark it user-grantable, so availability follows the normal account and tool permissions described in [Users & Access](users-access). Environment tools additionally require access to a managed Project.

## Configuration

The plugin has one instance-wide configuration, edited in its detail view under [Configuration](configuration). There is no per-account settings schema; the account-level Git author and HOME reset live on the Development environment page instead.

| Field | Key | Type | Default | What it does |
| --- | --- | --- | --- | --- |
| Execution | `sec_execution` | section | not set | Form section heading for how commands from accounts without operator authority are contained. |
| Confine non-operator commands | `confineNonOperators` | boolean | `true` | Runs non-operator commands in bubblewrap with only their accessible Project directories and account HOME mounted. Network access stays available. If the live namespace probe fails, execution is refused rather than run unconfined. |
| Environment defaults | `sec_resources` | section | not set | Form section heading for the resources a project environment receives when it is first provisioned. |
| Processor | `defaultCpus` | number, slider | `1` | CPU cores a newly provisioned environment may use, 0.1 to 64, enforced by the CPU quota. |
| Memory | `defaultMemoryMb` | number, slider | `1024` | Memory ceiling in MiB, 128 to 65536. A process that exceeds it is terminated by the kernel. |
| Processes | `defaultPidsLimit` | number, slider | `512` | Maximum number of processes and threads inside the environment, 32 to 8192. |
| Environment networking | `sec_network` | section | not set | Form section heading for the network mode a newly provisioned environment is copied with. |
| Network mode | `defaultNetworkMode` | enum | `shared` | `shared` provides outbound internet through a private machine link; `isolated` provides only the guest loopback interface. |

The resource defaults and the network mode apply when an environment is first provisioned. Existing environments keep what they were created with, and an administrator changes those on the Project itself; a change is applied to the running environment without a restart. If a configured value is missing or unusable, provisioning falls back to the built-in figures of 1 CPU, 1024 MiB memory and 512 processes.

## Account HOME

Every linked account owns a private HOME directory holding its Git, npm and tool configuration. It belongs to the account rather than to any single project, and it carries a generation counter: a reset produces a new generation, and leases record the generation they were launched with. **Reset HOME** on the Development environment page first shows what will be lost and then requires a typed confirmation phrase; active processes block the reset.

Removing an account removes its HOME, including anything left behind by the retired workspace subsystem, and clears the Git metadata those workspaces left in the Project repositories they were cut from.

## Confined execution

The plugin changes what a shell command means depending on who runs it and where:

- An operator running commands outside a managed Project executes them directly on the host, as in the plain terminal described in [Terminal & Processes](terminal-plugin).
- Commands from accounts without operator authority run confined by default: a bubblewrap namespace that mounts only the account's accessible Project directories and its account HOME. Network access remains available for package installation, Git and development servers. If the live bubblewrap probe fails, such a command is refused rather than started without containment. An administrator can set `confineNonOperators` to `false`, which lets those accounts run directly on the host.
- Work that plugins start in the background is always confined, regardless of the setting above.

A confined terminal session is the only command surface that receives the account's GitHub credential, and any output containing the token is redacted. Commands in a managed Project run inside the Project's own environment and are not governed by the confinement setting at all.

## Persistent Project environments

A managed Project has one persistent environment. Every environment is a systemd-nspawn machine, which the installer provisions and which the host must carry before the first environment can be created. Its root filesystem comes from a prepared, published artifact that the host downloads once and checks against a known fingerprint, so nothing is assembled on your server. It is provisioned on demand the first time it is needed and reports one of the states unprovisioned, starting, running, stopped, failed, deleting or deleted.

Lifecycle tools write durable requests, and daemon reconciliation performs the actual work. `EnvironmentStart`, `EnvironmentStop`, `EnvironmentSnapshot` and `EnvironmentRestore` return an operation immediately; `EnvironmentOperation` reports its real status. Reuse the same request id to retry an interrupted request without queuing a second one, and pass an expected generation to fail cleanly if the environment changed in the meantime. `EnvironmentLogs` reads the bounded lifecycle log and the guest system journal; `EnvironmentStatus` reads state without starting anything.

An environment that predates persistent disks is moved onto one by a disk migration. It is administrator-only and is requested like any other lifecycle operation.

Stopping interrupts shared project services and running commands while preserving files and installed packages. A snapshot pauses execution and captures the root filesystem, HOME, worktrees and data. It is crash-consistent, not database-consistent, so an application database may need its own export; a note up to 2,000 characters can describe it. Project snapshots always include every component. A restore replaces the environment with the chosen snapshot in a fresh generation, discarding everything since the snapshot and interrupting running work, so it requires the user's explicit confirmation first. Deleting a Project deletes its environment with it; published Sites must be transferred or deleted first, and cleanup completion is reported asynchronously.

`EnvironmentWorktrees` lists, creates and removes organizational worktrees inside the shared environment, on branches named `elowen/<slug>-<suffix>`. They separate unfinished work between people on the same Project but are not security-isolated, never bind the conversation, and can be mutated only while the environment is idle.

## Permissions and consent

The manifest declares no mutating consent categories, so enabling the plugin does not prompt for a power acknowledgment. It does declare read access to the database, the host stores and the control plane; the host verifies those declarations when the plugin registers.

Project boundaries remain the real gate. Every environment request and explicit file path is checked against the account's current Project access at call time. The account Development environment page, the host runtime readiness section and resource limit changes on a Project are administrator-only surfaces.

## Known limits

- Environment tools work only on managed Projects and refuse anything else.
- Snapshots are crash-consistent rather than database-consistent, and databases may need a separate export before a restore.
- Resource limits are fixed at provisioning for an existing environment until an administrator changes them on the Project.
- A new environment needs the machine runtime on the host: the privileged helper, the machine unit template and the polkit rule, installed by `elowen install` and `elowen update`. It also needs the published Project root filesystem, which the host downloads and verifies on first use. When either is unavailable, the first start refuses and names what is missing.
- Historical Sandbox rows for the removed per-Site machine runtime remain stored as audit data. If an owned legacy Site machine is still active during upgrade, daemon reconciliation verifies its persisted machine binding, stops it, removes only its machine envelope and marks the retained row stopped. Sandbox exposes no Site lifecycle controls and leaves snapshots, storage, backups and UID allocations intact.
- If legacy and current account HOME directories both exist after an upgrade, startup migration is refused and the readiness panel names the collision for an operator to resolve.

For the account HOME, reset behavior and Git author, see [Projects, Environments & GitHub](projects-workflow). For plugin settings in general, see [Plugins](plugins).

[Next: Sub-agent Plugin](subagent-plugin)
