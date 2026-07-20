---
title: Install
slug: install
order: 2
eyebrow: Getting started
---

# Install

Elowen is a personal AI agent you run on your own machine. Under the hood it is
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

A single `elowen` CLI binary drives both, and the agent is only a command away —
bare `elowen` in a terminal opens the chat. The design goal is a lightweight,
self-hosted app with a clean, professional codebase — you should be able to run
it, read it, and reason about it.

## Requirements

- **Node.js** ≥22 (Elowen is ESM-only) — the `elowen` launcher checks the
  runtime version first and exits with a short message on anything older,
  before any dependency loads
- **tmux** ≥3.x — agents run inside tmux sessions
- **npm**
- A C toolchain for `node-pty` (**optional**: `python3`, `make`, `g++`). This
  powers the live PTY terminals in the Sessions module. Without a prebuilt
  binary and no toolchain, terminals degrade gracefully — everything else keeps
  working.

## One-line install

The shortest path from a bare machine to a running Elowen. A small bootstrap
script installs everything the machine is missing — a modern Node.js and the
global **`elowen`** package — then hands over to `elowen install`, the tested
provisioner that sets up tmux, the systemd services, an optional reverse proxy
and the first admin. You end up with a running daemon and Web UI.

```bash
# Linux (Debian/Ubuntu)
curl -fsSL https://raw.githubusercontent.com/dragocz95/elowen/main/install.sh | bash
```

```powershell
# Windows — installs into WSL2 (run in an elevated PowerShell)
irm https://raw.githubusercontent.com/dragocz95/elowen/main/install.ps1 | iex
```

Elowen runs its agents inside tmux and its services under systemd, both
Linux-only, so on **Windows** the bootstrap enables **WSL2**, installs Ubuntu if
it is missing, and runs the exact same Linux install inside it. A first-time WSL
setup needs one reboot — re-run the command afterwards to finish. The Web UI is
then reachable from Windows at `http://localhost:4500`.

Two optional environment variables tune the run:

- `ELOWEN_VERSION` — pin a specific npm version instead of the latest
  (`ELOWEN_VERSION=0.27.3`).
- `ELOWEN_INSTALL_ARGS` — flags forwarded to `elowen install`. Pass
  `--unattended` (with the deployment and admin flags) for a fully
  non-interactive install:

  ```bash
  ELOWEN_INSTALL_ARGS='--unattended --localhost --admin-user admin --admin-pass CHANGEME --agents none' \
    bash -c "$(curl -fsSL https://raw.githubusercontent.com/dragocz95/elowen/main/install.sh)"
  ```

Piping a script into a shell runs code from the network — inspect it first if
you prefer: `curl -fsSL .../install.sh | less`.

## npm global (recommended)

The fastest path when Node.js 22+ is already present. Install the package
globally — it ships as **`elowen`**, and the binary it puts on your PATH is
**`elowen`** — then run the onboarding wizard:

```bash
npm install -g elowen
elowen setup          # guided onboarding wizard
```

`elowen setup` brings the daemon up and walks you through five quick steps, each
skippable and resumable:

1. **Account** — create the first admin on a fresh box, or, on a re-run, an
   **escapable, bounded sign-in** (retries are capped and each failure lets you
   try again, skip, or go back — a wrong password never traps you in a loop)
2. **Project** — register a repository for agents to work in
3. **AI provider** — connect an OpenAI-compatible or Anthropic provider, a preset,
   a custom compatible endpoint, or a supported OAuth account (Claude, ChatGPT,
   GitHub Copilot, or Kimi); pick a model, then run a **chat smoke-test** (one
   small, real completion) to confirm the model actually answers. The built-in
   task engine is wired to that model, so basic tasks run with no external agent
   CLI installed.
4. **Memory** — optional embeddings for recall (reuse the provider's key or an
   OpenRouter key)
5. **Code intelligence** — optionally install the TypeScript language server so
   agents can type-check their own edits

The flame mascot heads every step, and the run ends with a readiness report
("What works now") followed by a dedicated **done screen** — held until you
dismiss it — with your next steps. Run `elowen doctor` any
time for the same report on demand: it covers chat, tasks, missions, memory,
platforms, and plugins, each with a plain-language hint for whatever isn't
configured yet.

## The CLI-first flow

Elowen is agent-first, so the agent is one command away. In a terminal, bare
`elowen` opens the interactive chat — you talk to Elowen's brain right there, the
same way `claude` or `opencode` do:

```bash
elowen                # opens the chat TUI
```

Everything else hangs off a small set of verbs:

- `elowen menu` — the interactive launcher: start/stop, status, logs, update, or
  jump straight into chat, all in one place
- `elowen run "<prompt>"` (alias `elowen -p`) — non-interactive: run one turn, slash
  command, or autonomous goal, stream it, and exit
- the lifecycle verbs `elowen up` / `elowen down` / `elowen status` (see [Manual
  start](#manual-start-without-systemd) below)
- `elowen update` — pull the latest release and restart in place

Prefer a browser? Open `http://localhost:4500`, sign in, and you land on the
Dashboard. See [Getting Started](getting-started) for your first chat and first
task.

## Production install (systemd + reverse proxy)

For a shared or always-on box, `elowen install` provisions the whole service. It's
a separate, heavier wizard than `elowen setup` — run it **as root**:

```bash
sudo elowen install
```

It will:

1. Install prerequisites (tmux) and, optionally, the coding-agent CLIs it
   detects — Claude Code, OpenCode, Codex
2. Create (or reuse) a dedicated **service user** to run the agents
3. Ask how you'll reach the UI — a **domain** (nginx or Apache reverse proxy +
   free Let's Encrypt HTTPS), the server's **IP on a port**, or **localhost
   only**
4. Write and enable the systemd units — `elowen-daemon` (`:4400`) and `elowen-web`
   (`:4500`) — plus the `elowen-update.timer` and a **sudoers drop-in** that lets
   the unprivileged service user restart its own units and reinstall Elowen in
   place for self-updates (see [Auto-update](#auto-update))
5. Run the same onboarding as `elowen setup` to create the admin, connect a
   project, and wire the AI provider

Provisioning progress paints into a single **framed installer panel** rather than
scrolling past as bare lines, and the run finishes on its own **"Elowen is
ready"** screen listing your URL and the `systemctl` / `journalctl` commands to
manage the box.

Add `--unattended` with flags (`--domain`, `--ip`, `--localhost`, `--admin-user`,
`--admin-pass`, `--agents`, …) for a hands-off provision; run `elowen install
--help` for the full list. Manage the box afterwards with `elowen menu`, which
drives the systemd units directly instead of spawning a second daemon.

## Manual start (without systemd)

If you don't want systemd units, start both processes yourself:

```bash
elowen up
```

This launches the daemon on `:4400` and the web UI on `:4500`. Override the
ports with `ELOWEN_PORT` and `ELOWEN_WEB_PORT`. Stop them again with `elowen down`.

Or run the daemon directly — handy for a second instance, a container, or a
smoke test:

```bash
ELOWEN_PORT=4400 \
ELOWEN_DB=$HOME/.config/elowen/elowen.db \
ELOWEN_ALLOW_OPEN=1 \
node dist/daemon/index.js
```

`ELOWEN_ALLOW_OPEN=1` disables auth for local, single-user use. Leave it off for
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
docker build -t elowen .
docker run -d \
  --name elowen \
  -p 4400:4400 \
  -v elowen-data:/app/data \
  -e ELOWEN_DB=/app/data/elowen.db \
  -e ELOWEN_ALLOW_OPEN=1 \
  elowen
```

Mount a volume for `ELOWEN_DB` so your data survives container restarts. To expose
the web UI too, build and run it alongside the daemon (see below) and publish
`4500`.

## Build from source

Clone the public repo and build:

```bash
git clone https://github.com/dragocz95/elowen.git
cd elowen
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

Override with `ELOWEN_PORT` and `ELOWEN_WEB_PORT`. The web UI never talks to the
database directly — it always goes through the daemon API.

## Data directory

The daemon keeps everything in a single SQLite database at
`~/.config/elowen/elowen.db` by default. Override the location with `ELOWEN_DB`. The
file is created automatically on first run from the bundled schema. One small
file is the entire persistent state — tasks, missions, memory, users, and
settings all live here.

## First-run setup

How you start the daemon the first time decides its auth mode:

- **Local, no auth** — start with `ELOWEN_ALLOW_OPEN=1`. Good for a single-user
  machine where nothing else can reach the port.
- **Browser onboarding** — while no user exists, the web UI lands on a first-run
  wizard instead of the login form: it creates the first admin and walks through
  the initial configuration (detecting tooling, connecting a provider, saving
  config), no CLI needed.
- **Production** — seed an admin account once via bootstrap variables:

```bash
ELOWEN_BOOTSTRAP_USER=admin \
ELOWEN_BOOTSTRAP_PASS=secure-pass \
node dist/daemon/index.js
```

The admin user is seeded only once. If no users exist and you skip both the
browser wizard and the bootstrap variables, the daemon logs a warning and login
stays impossible until a user is created through the wizard, `elowen setup`, or
the API.

That first admin unlocks Elowen's **RBAC**. Roles are **admin** and **member**,
and — this is the headline — each user can carry a **different set of tools and
permissions**: which executors they may run, which brain tools are enabled for
them, and which projects they can see. You can grant one user the terminal and
files tools and give another only chat. Set it all up later in
[Configuration](configuration) and the Users module.

## Non-interactive setup

For agents, CI, or scripted provisioning, `elowen setup` has a flag-driven mode
that runs the same onboarding without any prompts — it creates the admin, connects
a project and an AI provider, wires the built-in task engine, runs the chat
smoke-test, and prints a readiness matrix. It exits non-zero on a missing required
input, so a caller can branch on it.

```bash
elowen setup --non-interactive \
  --admin-user admin --admin-password "$ADMIN_PW" \
  --project /path/to/repo \
  --provider openai --api-key "$OPENAI_API_KEY" --model gpt-5.5 \
  --memory reuse
```

| Flag | Purpose | Env fallback |
|------|---------|--------------|
| `--admin-user` / `--admin-password` | first admin (or sign-in on re-run) | `ELOWEN_ADMIN_USER` / `ELOWEN_ADMIN_PASSWORD` |
| `--project <path>` / `--no-project` | register a project (opt-in — only when `--project` is passed) | — |
| `--project-slug <slug>` | override the auto-derived project slug | — |
| `--embedding-model <id>` | embedding model (defaults to a small recommended one) | — |
| `--provider <key\|custom>` | a preset (see [Brain & Chat](brain-chat)) or `custom` | — |
| `--api-key` / `--base-url` / `--model` | provider credentials & model (`--base-url` for `custom`; `--model` optional when the key lets `/models` be probed) | `ELOWEN_API_KEY` |
| `--memory <reuse\|openrouter\|skip>` | embeddings — reuse the provider's key or OpenRouter | — |
| `--memory-key` | OpenRouter key for `--memory openrouter` | `ELOWEN_OPENROUTER_KEY` |
| `--lsp` | install the TypeScript language server | — |
| `--skip-test` | skip the chat smoke-test | — |

Run `elowen doctor` afterwards for the same readiness report on demand.

## Auto-update

`elowen install` adds the `elowen-update.timer`, which fires an `elowen update
--auto` check hourly (and once ~15 minutes after boot). It's **off by default** —
the timer runs but the update no-ops until you turn auto-update on in **Settings →
System**. Once enabled, updates are mission-aware: the agent won't restart itself
while a mission is running, so work in flight is never interrupted.

So the timer can take a new release live unattended, `elowen install` also writes
a **sudoers drop-in** (`/etc/sudoers.d/elowen`, validated with `visudo` before it
is trusted) granting the service user a narrow set of passwordless commands:
restart and query its own units, and run the pinned self-reinstall. Both a manual `elowen update`
and the auto-update timer rely on it; without it the services still run, only
in-place self-updates lose the ability to restart the units on their own.

[Next: Tasks & Missions](tasks-missions)
