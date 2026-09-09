---
title: Terminal & Processes
slug: terminal-plugin
order: 31
eyebrow: Plugin reference
group: Plugin reference
---

# Terminal & Processes

The bundled `terminal` plugin lets Elowen run real shell commands and manage the processes it starts. Where a command runs is not decided by the plugin itself: the Sandbox plugin resolves the filesystem authority, the account HOME, the active workspace, and the confinement for every launch, and a launch is refused when no verified owner can be resolved, except for an instance operator running in explicit direct-host mode.

## Where it appears

The plugin contributes no Web UI pages, no account panel, and no slash commands. It appears in **Settings → Plugins** as a bundled plugin, and its surface is four tools:

| Tool | What it does |
| --- | --- |
| `Bash` | Executes a shell command and returns combined stdout and stderr with the exit code; can run detached in the background. |
| `ListProcesses` | Lists the background processes this conversation started, with state, start time, and command line. |
| `ProcessOutput` | Reads a background process's output, waiting for its exit or peeking at a long-lived process. |
| `KillProcess` | Force-stops one of this conversation's background processes and its tracked descendants. |

## Granting the plugin to a user

The manifest marks the plugin user-grantable, so a non-admin account reaches `Bash` and the process tools only after an administrator grants it:

1. Open **Users**.
2. Select the user.
3. In **Granted plugins**, choose **Manage**.
4. Select `terminal` and save.

Administrators always retain access, and an empty grant selection means the user receives none of the grantable plugins. The grant makes the plugin's surfaces eligible; the account's tool permissions can still narrow individual tools further, and nothing in `Bash` asks for confirmation, so the grant and the tool permissions are the controls that govern it. See [Users & Access](users-access).

## Where commands run

Every launch is resolved through the Sandbox control at the moment it happens, so reloads and configuration changes apply immediately. The resolved plan decides the working directory, the environment, and the confinement:

- In a project conversation, commands run under that project's access policy with the project root as the default working directory.
- A conversation bound to a Sandbox worktree runs inside that worktree.
- Inside a managed project environment, commands run in the environment through the Sandbox plugin.
- Without the Sandbox plugin, workspace and managed execution is refused, and only an instance operator may run commands directly on the host in explicit direct-host mode.

The working directory persists between successful foreground calls in a session, and an explicit `cwd` argument wins for a single call. Shell variables and functions do not persist between calls. Two shapes are refused outright: a blocking restart of the Elowen daemon from inside the daemon's own service, which can never complete, and the sandbox bypass argument, which is always refused before any process is spawned.

## Foreground runs

A foreground `Bash` call holds the turn while it runs and returns combined output with the exit code. Its `timeout` is in milliseconds, defaults to 120 seconds, and cannot exceed 600 seconds.

A foreground command whose timeout is longer than 30 seconds is normally moved to the background at the 30 second mark instead of being killed at its deadline. The result reports a process id, the command keeps running with no time limit, and `ProcessOutput` waits for the rest. The move is skipped when the user approved the command at a permission prompt, when the conversation's background slots are full, or when the turn is not an interactive chat of its own, such as a sub-agent or workflow node whose caller needs the output rather than a process id. In those cases the plain deadline applies and the result says so.

A bare `sleep` of two seconds or more as the entire command is refused, because a foreground wait that produces nothing spends the turn for nothing. Background runs are untouched, and commands that continue after a short pause are also allowed. For waiting on started work, the process tools are the way to wait.

## Background runs

`Bash` with `run_in_background: true` starts a detached process and returns a process id immediately. The conversation is notified when the process exits, and `ListProcesses`, `ProcessOutput`, and `KillProcess` manage it from there. `backgroundMode: "service"` marks a long-lived server or watcher.

A background process outlives the turn but not the daemon. A daemon restart tears down running processes and their registry entries, so a long-lived server must be restarted with the deployment.

One session and account may keep at most `maxBackgroundProcesses` background processes at once, 16 by default. Starting or detaching another is refused until one exits and is collected or is killed. Ctrl+B detaches a running foreground command into the same background list. Sessionless turns of scheduled jobs and workers cannot background a process, because there is no conversation to hand it to.

Reading a background process is incremental: each `ProcessOutput` call returns only what was written since the last read, and `all: true` returns the whole retained buffer. The buffer keeps a rolling tail under the output cap, so a very chatty process loses its earliest output and the result names the loss. By default `ProcessOutput` waits for the process to exit, for 30 seconds by default and 600 seconds at most, and the process keeps running after a timed-out wait; `block: false` peeks at a long-lived process without waiting. Reading a process that has exited returns its remaining output and collects it, so that id stops working afterwards.

`KillProcess` stops one background process of this conversation. The tracked process tree is killed immediately with no chance to shut down cleanly or flush, so a killed build or migration can leave partial state behind, and the output buffer is discarded. An unknown id is reported back rather than killing anything, and only processes this conversation started can be killed.

## Output size

Inline output is capped by `outputCap`, 60 kB by default. A foreground result past the cap keeps the beginning and the end, drops the middle, and names the discarded amount; when anything is withheld, the retained output is saved to a file the result names, and the `Read` tool can page through it. Background processes keep a rolling tail under the same cap and report when earlier output was dropped. While a foreground command runs, its live progress is streamed as a short throttled tail.

## Configuration

Configuration is instance-wide and edited in the plugin's detail view under **Settings → Plugins**. There are no per-account settings.

| Field | Key | Type | Default | What it does |
| --- | --- | --- | --- | --- |
| Limits | `sec_limits` | section | not set | Heading that groups the two limits below; stores no value. |
| Output cap | `outputCap` | number | 60,000 | How much stdout and stderr a foreground command returns, and how large a background buffer may grow. Past it the middle is dropped and the amount is named. Range 10,000 to 500,000. |
| Background processes per session and account | `maxBackgroundProcesses` | number | 16 | How many background processes one session and account may keep at once. Range 1 to 64. |

## Permissions and consent

The plugin is user-grantable, so the per-user grant in **Users → Granted plugins** decides which non-admin accounts reach it; administrators always retain access. Enabling the plugin asks for no capability consent: the manifest declares only that the plugin reads other plugins' controls, and it looks up the Sandbox control on every launch. The manifest declares no minimum core version. `ListProcesses` and `ProcessOutput` are read-only and are treated as safe to run while Elowen is still planning; `Bash` and `KillProcess` change system state and are not.

## Known limits

| Area | Limit |
| --- | --- |
| `Bash` timeout | 120 seconds by default; between 1 ms and 600 seconds |
| Auto-background | A foreground run moves to the background after 30 seconds when its timeout is longer; otherwise the deadline kills it |
| Output cap | 60 kB by default, range 10,000 to 500,000 bytes; background buffers keep a rolling tail under the same cap |
| Background processes | 16 by default, range 1 to 64, counted per session and account |
| `ProcessOutput` wait | 30 seconds by default, 600 seconds maximum; the process keeps running after a timed-out wait |
| Daemon restart | Background processes and their registry entries do not survive it |
| Backgrounding | Requires an authenticated conversation; sessionless worker and scheduled turns cannot start or detach background processes |
| Direct host | Background execution directly on the host requires Linux; non-operator commands are refused without the Sandbox plugin |

[Next: Sandbox & Environments](sandbox-plugin)