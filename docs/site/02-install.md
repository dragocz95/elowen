---
title: Install
slug: install
order: 2
eyebrow: Getting started
---

# Install

Orca is a personal AI agent you run on your own machine. Under the hood it is
deliberately small: a single **daemon** (a REST API on `:4400`) plus a **Next.js
web UI** (`:4500`). That is the whole footprint — no external services, no heavy
runtime. This page covers every way to install it: the guided npm route, a
manual start, Docker, and building from source.

## What you're installing

Two long-running pieces work together:

- **The daemon** — the agent core. It runs the brain you chat with, spawns
  coding agents in isolated tmux sessions, serves the REST API, streams events
  over SSE, and hosts the WebSocket terminal. This is where the agent actually
  *acts*.
- **The web UI** — a Next.js app that gives you the surfaces to **observe and
  steer** the agent: Dashboard, Tasks, Kanban, Timeline, Sessions, Settings, and
  Users. It talks to the daemon; it holds no state of its own.

A single `orca` CLI binary drives both. The design goal is a lightweight,
self-hosted app with a clean, professional codebase — you should be able to run
it, read it, and reason about it.

## Requirements

- **Node.js** ≥22 (Orca is ESM-only)
- **tmux** ≥3.x — agents run inside tmux sessions
- **npm**
- A C toolchain for `node-pty` (**optional**: `python3`, `make`, `g++`). This
  powers the live PTY terminals in the Sessions module. Without a prebuilt
  binary and no toolchain, terminals degrade gracefully — everything else keeps
  working.

## npm global (recommended)

The fastest path. Install the package globally, then run the guided installer:

```bash
npm install -g orca
orca install        # guided setup wizard
```

`orca install` runs a wizard that:

1. Checks system dependencies (Node, tmux, git)
2. Detects installed coding-agent CLIs — Claude Code, OpenCode, Codex, Kilo Code
3. Configures provider binary paths
4. Creates the first admin user
5. Installs systemd units (`orca-daemon` + `orca-web`)
6. Enables the hourly auto-update timer

Once it finishes, open `http://localhost:4500`, log in, and you are talking to
the agent. See [Getting Started](getting-started) for your first chat and first
task.

## Manual start (without systemd)

If you don't want systemd units, start both processes yourself:

```bash
orca up
```

This launches the daemon on `:4400` and the web UI on `:4500`. Override the
ports with `ORCA_PORT` and `ORCA_WEB_PORT`.

Or run the daemon directly — handy for a second instance, a container, or a
smoke test:

```bash
ORCA_PORT=4400 \
ORCA_DB=$HOME/.config/orca/orca.db \
ORCA_ALLOW_OPEN=1 \
node dist/daemon/index.js
```

`ORCA_ALLOW_OPEN=1` disables auth for local, single-user use. Leave it off for
anything reachable by others (see [First-run setup](#first-run-setup)).

## Docker

A minimal image on `node:22-alpine` with tmux and git, exposing the daemon on
`4400` and persisting the database on a mounted volume:

```dockerfile
FROM node:22-alpine
RUN apk add --no-cache tmux git
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
RUN npm run build
EXPOSE 4400
CMD ["node", "dist/daemon/index.js"]
```

Build and run:

```bash
docker build -t orca .
docker run -d \
  --name orca \
  -p 4400:4400 \
  -v orca-data:/app/data \
  -e ORCA_DB=/app/data/orca.db \
  -e ORCA_ALLOW_OPEN=1 \
  orca
```

Mount a volume for `ORCA_DB` so your data survives container restarts. To expose
the web UI too, build and run it alongside the daemon (see below) and publish
`4500`.

## Build from source

Clone the public repo and build:

```bash
git clone https://github.com/dragocz1995/orca.git
cd orca
npm install
npm run build
```

Start the daemon:

```bash
node dist/daemon/index.js
```

Then build and start the web UI in a separate terminal:

```bash
cd web
npm install
npm run build
npm start
```

The web UI serves on `:4500` and proxies to the daemon on `:4400`. For a deeper
look at how the two processes fit together, see [Architecture](architecture).

## Ports & services

| Service    | Default port | Purpose                                              |
|------------|--------------|------------------------------------------------------|
| Daemon API | `4400`       | REST API, SSE events, MCP, WebSocket terminal        |
| Web UI     | `4500`       | Next.js frontend (BFF proxy to the daemon)           |

Override with `ORCA_PORT` and `ORCA_WEB_PORT`. The web UI never talks to the
database directly — it always goes through the daemon API.

## Data directory

The daemon keeps everything in a single SQLite database at
`~/.config/orca/orca.db` by default. Override the location with `ORCA_DB`. The
file is created automatically on first run from the bundled schema. One small
file is the entire persistent state — tasks, missions, memory, users, and
settings all live here.

## First-run setup

How you start the daemon the first time decides its auth mode:

- **Local, no auth** — start with `ORCA_ALLOW_OPEN=1`. Good for a single-user
  machine where nothing else can reach the port.
- **Production** — seed an admin account once via bootstrap variables:

```bash
ORCA_BOOTSTRAP_USER=admin \
ORCA_BOOTSTRAP_PASS=secure-pass \
node dist/daemon/index.js
```

The admin user is seeded only once. If no users exist and you skip the bootstrap
variables, the daemon logs a warning and login stays impossible until a user is
created via the API.

That first admin unlocks Orca's **RBAC**. Roles are **admin** and **member**,
and — this is the headline — each user can carry a **different set of tools and
permissions**: which executors they may run, which brain tools are enabled for
them, and which projects they can see. You can grant one user the terminal and
files tools and give another only chat. Set it all up later in
[Configuration](configuration) and the Users module.

## Auto-update

`orca install` adds a systemd timer that checks for a new version hourly. Updates
are mission-aware — the agent won't restart itself while a mission is running, so
work in flight is never interrupted. Toggle auto-update any time in **Settings →
System**.

[Next: Tasks & Missions](tasks-missions)
