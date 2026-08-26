---
title: Getting Started
slug: getting-started
order: 1
eyebrow: Start here
group: Start here
---

# Getting Started

Elowen is a self-hosted assistant you use from a browser, the `elowen` CLI, or an installed chat-channel plugin. It can read and edit files, run commands, use configured integrations, and delegate focused work to scoped sub-agents.

A deployment has two processes:

- **The daemon** listens on `127.0.0.1:4400` by default. It owns the brain, accounts, projects, plugins, API, and persistent state.
- **The web UI** listens on `localhost:4500` by default and talks to the daemon. It does not access the database directly.

The default configuration is deliberately local. Put a reverse proxy in front of the web UI when other people or machines need access; do not expose the daemon casually because its authenticated API can perform powerful operations.

![Talking to your Elowen agent in the web chat dock](images/getting-started-chat.png)

## Install and run the first setup

On a machine with Node.js 22 or newer:

```bash
npm install -g elowen
elowen setup
```

The setup wizard starts the local services and guides you through:

1. Creating the first administrator account.
2. Registering a Project, which is a repository or working directory Elowen may access.
3. Connecting an AI provider and selecting a model.
4. Optionally configuring embeddings for long-term memory.
5. Optionally installing the TypeScript language server.

When setup finishes, open <http://localhost:4500> and sign in, or start the terminal chat:

```bash
elowen chat
```

Run the readiness check later with:

```bash
elowen doctor
```

## Prerequisites

- Node.js 22 or newer.
- npm.
- Git for Git Projects and Sandbox workspaces.
- `tmux` for interactive terminal sessions and integrations that launch external command-line tools. The embedded chat can still be configured before `tmux` is installed; `elowen setup` prints an installation hint when it is missing.
- On Linux, `bubblewrap` is used by the Sandbox for confined non-operator commands. `elowen install` can install it on Debian/Ubuntu.

## Make your first request

In the web chat or terminal chat, start with a request whose result is easy to inspect:

```text
List the files in my current Project and summarize its README.
```

Other useful first requests include:

- “Show me the current Git branch and recent commits.”
- “Explain the entry points in this project.”
- “Create a plan for fixing the failing tests, but do not edit files.”

The tools available to a turn depend on the account, the selected Project, plugin access, and the account's tool grants. Elowen does not give every account unrestricted host access by default.

## Projects, Sandbox, and GitHub

A **Project** is the access boundary for a repository or directory. Administrators register Projects and assign them to accounts. Registering a Project does not create a worktree or change files on disk.

The optional **Sandbox** gives each account a persistent `HOME` and real Git worktrees. A workspace can be bound to one conversation and Project, so file operations and shell commands use that worktree instead of changing the source checkout. Non-operator commands are confined by default on supported Linux hosts; if the live isolation probe fails, Elowen refuses confined execution rather than silently running it unconfined.

The optional **GitHub** integration is account-scoped. It can map a Project to a base and push repository, publish a committed Sandbox branch, and handle pull-request review actions subject to confirmation and repository checks.

See [Projects, Sandbox & GitHub](projects-workflow) for the complete workflow.

## Accounts and permissions

Elowen has two roles: **admin** and **member**. Administrators can assign Projects, grant plugin access, and control each account's tool allow-list. A member's turn, delegated work, scheduled work, and channel activity inherit that account's effective access; a child cannot widen its parent's scope.

For setup and ongoing administration, see [Users & Access](users-access) and [Account & Preferences](account-preferences).

## Longer-running work

Use the mechanisms that are currently part of the chat and delegation system:

- **Plan mode** helps prepare changes while enforcing a narrower write boundary.
- **Delegate** sends one focused task to a scoped sub-agent.
- **Workflow** runs a dependency graph of sub-agents; independent nodes can run in parallel.
- **Goals** continue toward a stated outcome across multiple turns when the goal loop is available on the installation.

These are conversation and delegation features, not a separate mission or pull-request executor. See [Autonomy & Safety](autonomy-safety) and [Sub-agents & Workflows](tasks-missions).

## Service controls

For a local installation:

```bash
elowen up       # start the daemon and web UI
elowen down     # stop them
elowen status   # show service state and health
elowen menu     # interactive launcher
```

`elowen down` waits for running work by default. Use `elowen down --force` only when you explicitly need to stop immediately.

## First-run authentication

When the database contains no users, the web UI exposes the onboarding flow so the first administrator can be created. You can also seed that account before starting the daemon:

```bash
ELOWEN_BOOTSTRAP_USER=admin \
ELOWEN_BOOTSTRAP_PASS="$ADMIN_PASSWORD" \
node dist/daemon/index.js
```

After the first user exists, normal daemon requests require a bearer token. The web UI keeps that token in an HTTP-only session cookie and the CLI sends it in the `Authorization` header. Do not put tokens in URLs.

## Where to go next

- [Install](install) — local, server, source, and unattended installation.
- [Docker](docker) — build and run the daemon and web UI as containers.
- [Production & Updates](production-updates) — systemd, launchd, reverse proxies, backups, and updates.
- [Brain & Chat](brain-chat) — models, conversations, and chat behavior.
- [Channels](channels) — connect supported chat platforms.
- [Scheduling](scheduling) — recurring jobs.
- [Troubleshooting](troubleshooting) — diagnostics and common failures.

[Next: Install](install)
