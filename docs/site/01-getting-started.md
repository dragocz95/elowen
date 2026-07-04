---
title: Getting Started
slug: getting-started
order: 1
eyebrow: Start here
---

# Getting Started

**Orca** is your personal AI agent. It orchestrates autonomous coding agents,
runs a built-in brain for chat and automation, supports plugins (Discord, cron,
skills, memory, and more), and gives you a web UI and CLI to control everything.

This guide gets you from zero to your first running agent in about two minutes.

## Prerequisites

- **Node.js** ≥22 (ESM)
- **tmux** ≥3.x (for running agents)
- **npm**
- A C toolchain (`python3`, `make`, `g++`) — optional, only needed when
  `node-pty` has no prebuilt binary (terminals still work without it)

## Quick install

```bash
npm install -g orcasynth
orca install        # provisions tmux, node-pty, systemd units
```

`orca install` runs a guided wizard that:

1. Checks system dependencies (Node, tmux, git)
2. Detects installed AI coding CLIs (Claude Code, OpenCode, Codex)
3. Configures provider binary paths
4. Sets up autopilot (relay LLM or CLI agents)
5. Creates the first admin user
6. Installs systemd units (`orca-daemon` + `orca-web`)
7. Enables the auto-update timer

## Start the daemon

```bash
orca up
```

This starts the daemon on `http://localhost:4400` and the web UI on
`http://localhost:4500`. Open `http://localhost:4500` in your browser and log in.

## Your first task

1. Open the web UI → **Tasks** → **New task**
2. Give it a title like "Hello Orca"
3. Pick an executor (e.g. Claude Sonnet)
4. Hit **Create**

Or from the CLI:

```bash
orca api POST /tasks '{"title":"Hello Orca","labels":["exec:sonnet"]}'
orca ls                          # see your task
```

The daemon spawns the agent in an isolated tmux session. Watch it work in the
**Sessions** page or via:

```bash
orca sessions
```

## What's next

- [Install](install) — detailed installation options
- [Web UI](web-ui) — tour of the dashboard
- [CLI](cli) — command reference
- [Brain & Chat](brain-chat) — your AI assistant
- [Plugins](plugins) — extend Orca with Discord, cron, skills, and more
