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
production systemd install, a manual start, Docker, and building from source.

## What you're installing

Two long-running pieces work together:

- **The daemon** — the agent core. It runs the brain you chat with, spawns
  coding agents in isolated tmux sessions, serves the REST API, streams events
  over SSE, and hosts the WebSocket terminal. This is where the agent actually
  *acts*.
- **The web UI** — a Next.js app that gives you the surfaces to **observe and
  steer** the agent: Dashboard, Tasks, Kanban, Timeline, Sessions, Settings, and
  Users. It talks to the daemon; it holds no state of its own.

A single `orca` CLI binary drives both, and the agent is only a command away —
bare `orca` in a terminal opens the chat. The design goal is a lightweight,
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

The fastest path. Install the package globally — it ships as **`orcasynth`**, and
the binary it puts on your PATH is **`orca`** — then run the onboarding wizard:

```bash
npm install -g orcasynth
orca setup          # guided onboarding wizard
```

`orca setup` brings the daemon up and walks you through five quick steps, each
skippable and resumable:

1. **Account** — create the first admin user (and sign in)
2. **Project** — register a repository for agents to work in
3. **AI provider** — connect a provider and pick a model, then run a **chat
   smoke-test** (one small, real completion) to confirm the model actually
   answers. The built-in task engine is wired to that model, so basic tasks run
   with no external agent CLI installed.
4. **Memory** — optional embeddings for recall (reuse the provider's key or an
   OpenRouter key)
5. **Code intelligence** — optionally install the TypeScript language server so
   agents can type-check their own edits

It finishes with a readiness report and your next steps. Run `orca doctor` any
time for the same report on demand: it covers chat, tasks, missions, memory,
platforms, and plugins, each with a plain-language hint for whatever isn't
configured yet.

## The CLI-first flow

Orca is agent-first, so the agent is one command away. In a terminal, bare
`orca` opens the interactive chat — you talk to Orca's brain right there, the
same way `claude` or `opencode` do:

```bash
orca                # opens the chat TUI
```

Everything else hangs off a small set of verbs:

- `orca menu` — the interactive launcher: start/stop, status, logs, update, or
  jump straight into chat, all in one place
- `orca run "<prompt>"` (alias `orca -p`) — non-interactive: run one turn, slash
  command, or autonomous goal, stream it, and exit
- the lifecycle verbs `orca up` / `orca down` / `orca status` (see [Manual
  start](#manual-start-without-systemd) below)
- `orca update` — pull the latest release and restart in place

Prefer a browser? Open `http://localhost:4500`, sign in, and you land on the
Dashboard. See [Getting Started](getting-started) for your first chat and first
task.

## Production install (systemd + reverse proxy)

For a shared or always-on box, `orca install` provisions the whole service. It's
a separate, heavier wizard than `orca setup` — run it **as root**:

```bash
sudo orca install
```

It will:

1. Install prerequisites (tmux) and, optionally, the coding-agent CLIs it
   detects — Claude Code, OpenCode, Codex
2. Create (or reuse) a dedicated **service user** to run the agents
3. Ask how you'll reach the UI — a **domain** (nginx or Apache reverse proxy +
   free Let's Encrypt HTTPS), the server's **IP on a port**, or **localhost
   only**
4. Write and enable the systemd units — `orca-daemon` (`:4400`) and `orca-web`
   (`:4500`) — plus the auto-update timer
5. Run the same onboarding as `orca setup` to create the admin, connect a
   project, and wire the AI provider

Add `--unattended` with flags (`--domain`, `--admin-user`, `--admin-pass`,
`--agents`, …) for a hands-off provision; run `orca install --help` for the full
list. Manage the box afterwards with `orca menu`, which drives the systemd units
directly instead of spawning a second daemon.

## Manual start (without systemd)

If you don't want systemd units, start both processes yourself:

```bash
orca up
```

This launches the daemon on `:4400` and the web UI on `:4500`. Override the
ports with `ORCA_PORT` and `ORCA_WEB_PORT`. Stop them again with `orca down`.

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

## Non-interactive setup

For agents, CI, or scripted provisioning, `orca setup` has a flag-driven mode
that runs the same onboarding without any prompts — it creates the admin, connects
a project and an AI provider, wires the built-in task engine, runs the chat
smoke-test, and prints a readiness matrix. It exits non-zero on a missing required
input, so a caller can branch on it.

```bash
orca setup --non-interactive \
  --admin-user admin --admin-password "$ADMIN_PW" \
  --project /path/to/repo \
  --provider openai --api-key "$OPENAI_API_KEY" --model gpt-5.5 \
  --memory reuse
```

| Flag | Purpose | Env fallback |
|------|---------|--------------|
| `--admin-user` / `--admin-password` | first admin (or sign-in on re-run) | `ORCA_ADMIN_USER` / `ORCA_ADMIN_PASSWORD` |
| `--project <path>` / `--no-project` | register a project (opt-in — only when `--project` is passed) | — |
| `--project-slug <slug>` | override the auto-derived project slug | — |
| `--embedding-model <id>` | embedding model (defaults to a small recommended one) | — |
| `--provider <key\|custom>` | a preset (see [Brain & Chat](brain-chat)) or `custom` | — |
| `--api-key` / `--base-url` / `--model` | provider credentials & model (`--base-url` for `custom`; `--model` optional when the key lets `/models` be probed) | `ORCA_API_KEY` |
| `--memory <reuse\|openrouter\|skip>` | embeddings — reuse the provider's key or OpenRouter | — |
| `--memory-key` | OpenRouter key for `--memory openrouter` | `ORCA_OPENROUTER_KEY` |
| `--lsp` | install the TypeScript language server | — |
| `--skip-test` | skip the chat smoke-test | — |

Run `orca doctor` afterwards for the same readiness report on demand.

## Auto-update

`orca install` adds a systemd timer that checks for a new version hourly. It's
**off by default** — the timer fires but does nothing until you turn auto-update
on in **Settings → System**. Once enabled, updates are mission-aware: the agent
won't restart itself while a mission is running, so work in flight is never
interrupted.

[Next: Tasks & Missions](tasks-missions)
