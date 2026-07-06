---
title: Getting Started
slug: getting-started
order: 1
eyebrow: Start here
---

# Getting Started

**Orca is a personal AI agent you talk to.** You chat with it and it acts: it
reasons, calls tools, edits files, runs shell commands, manages your tasks, and
reaches you wherever you are — the web dock, the `orca` CLI, Discord, or
WhatsApp. It sits in the same category as agents like Claude or OpenClaw, but
it's self-hosted and it's yours.

Because Orca can run real work for you, it also gives you rich surfaces to
*watch and steer* what it's doing — a live dashboard, a kanban board, a timeline
of activity, and real terminal sessions you can jump into. Those surfaces are
how you observe and control the agent. They are not the product; the agent is.

This guide takes you from zero to your first conversation and your first task in
a couple of minutes.

![Talking to your Orca agent in the web chat dock](images/getting-started-chat.png)

## What Orca is

- An **agent you chat with** that does the work — plans, calls tools, edits
  code, runs commands, and follows up with you.
- **Self-hosted**: a daemon (REST API on `:4400`) plus a Next.js web UI
  (`:4500`), driven by the `orca` CLI.
- **Extensible to the core**: every capability — chat platforms, tools, memory,
  automation, security — is a plugin you add or remove.

## The four things that make it Orca

1. **Clarity** — a clean, uncluttered UI where you always see what the agent is
   doing.
2. **Simplicity** — easy to run, easy to control, sensible defaults, low
   friction.
3. **Fully extensible** — every capability is an add/remove-able plugin. Orca is
   modular to the core.
4. **Lightweight, professional-grade** — self-hosted, small footprint, clean
   codebase.

## Prerequisites

- **Node.js** ≥22 (ESM)
- **tmux** ≥3.x (agents run in isolated tmux sessions)
- **npm**
- A C toolchain (`python3`, `make`, `g++`) — optional, only needed when
  `node-pty` has no prebuilt binary for your platform. Terminals still work
  without it.

## Quick install

```bash
npm install -g orca
orca install
```

`orca install` runs a guided wizard that:

1. Checks system dependencies (Node, tmux, git)
2. Detects installed coding-agent CLIs — Claude Code, OpenCode, Codex, Kilo Code
3. Configures provider binary paths
4. Sets up autopilot (planning/execution defaults)
5. Creates the first admin user
6. Installs the `orca-daemon` and `orca-web` systemd units
7. Enables the auto-update timer

## Start it up

```bash
orca up
```

This starts the daemon on `http://localhost:4400` and the web UI on
`http://localhost:4500`. Open `http://localhost:4500` in your browser and log in
with the admin account you just created.

## Talk to your agent

Start with a conversation — that's the whole point of Orca.

- In the web UI, open the **chat dock** and just type. Ask it something concrete:
  "list the files in this repo", "what changed in the last commit", "summarize
  the open tasks".
- Or from your terminal:

  ```bash
  orca chat
  ```

Watch it reason, call tools, and stream a reply back. The brain — Orca's
embedded agent core — is what you're talking to, and it has access to whatever
tools and projects your account is allowed to use. Learn more in
[Brain & Chat](brain-chat).

## Give it a task to run

A **task** is Orca's atomic unit of work. When you create one, the daemon spawns
a coding agent in its own isolated tmux session and puts it to work.

From the web UI:

1. Open **Tasks** → **New task**
2. Give it a title like "Hello Orca"
3. Pick an executor (e.g. Claude Sonnet)
4. Hit **Create**

Or from the CLI:

```bash
orca api POST /tasks '{"title":"Hello Orca","labels":["exec:sonnet"]}'
orca ls                 # see your task
```

Then watch it work live in the **Sessions** page — where you can pop open a real
terminal and intervene with one click — or from the CLI:

```bash
orca sessions
```

Tasks group into **missions**, and missions into **epics**. See
[Tasks & Missions](tasks-missions) for how work is organized.

## Who can do what (RBAC)

Orca has full **role-based access control**. There are two roles — **admin** and
**member** — and, crucially, **each user can have a different set of tools and
permissions**. An admin can grant one user the terminal and files tools, give
another only chat, choose which models each person may run, and scope each user
to specific projects.

This per-user tools-and-rights model is a headline feature, not an afterthought.
The full depth lives in [Account & Security](account-security).

## What's next

- [Install](install) — detailed installation options, Docker, and build-from-source
- [Brain & Chat](brain-chat) — the agent core you talk to
- [Web UI](web-ui) — a tour of the surfaces that let you observe and steer the agent
- [Plugins](plugins) — extend Orca with Discord, WhatsApp, cron, skills, and more

[Next: Install](install)
