---
title: Install
slug: install
order: 2
eyebrow: Start here
group: Start here
---

# Install

Elowen is a personal AI agent you run on your own machine. Under the hood it is
deliberately small: a single **daemon** (a REST API on `:4400`) plus a **Next.js
web UI** (`:4500`). That is the whole footprint — no external services, no heavy
runtime. This page covers the local install paths: the one-line bootstrap, npm
global, a manual start, and building from source. Running a server or a
container instead? See [Docker](docker) and
[Production & Updates](production-updates).

## What you're installing

Two long-running pieces work together:

- **The daemon** — the agent core. It runs the brain you chat with, spawns
  coding agents in isolated tmux sessions, serves the REST API, streams events
  over SSE, and hosts the WebSocket terminal. This is where the agent actually
  *acts*.
- **The web UI** — a Next.js app that gives you the surfaces to **observe and
  steer** the agent: Dashboard, Tasks, Kanban, Timeline, Sessions, Settings, and
  Users. It talks to the daemon; it holds no state of its own.

A single `elowen` CLI binary drives both — bare `elowen` in a terminal opens the
chat, the same way `claude` or `opencode` do.

## Requirements

- **Node.js** ≥22 (Elowen is ESM-only) — the launcher checks the version first
  and exits with a short message on anything older
- **tmux** ≥3.x — agents run inside tmux sessions
- **npm**
- A C toolchain for `node-pty` (**optional**: `python3`, `make`, `g++`) — powers
  the live PTY terminals; without it terminals degrade gracefully, everything
  else keeps working

## One-line install

The shortest path from a bare machine to a running Elowen. A small bootstrap
script installs whatever the machine is missing — a modern Node.js and the
global **`elowen`** package — then hands over to `elowen install`, the tested
provisioner that sets up tmux, the services, an optional reverse proxy (Linux)
and the first admin. You end up with a running daemon and Web UI.

```bash
# Linux (Debian/Ubuntu) — run with sudo access
# macOS — run as yourself (no sudo; needs Homebrew)
curl -fsSL https://raw.githubusercontent.com/dragocz95/elowen/main/install.sh | bash
```

```powershell
# Windows — installs into WSL2 (run in an elevated PowerShell)
irm https://raw.githubusercontent.com/dragocz95/elowen/main/install.ps1 | iex
```

- **Linux** — the provisioner runs as root: a dedicated service user, systemd
  units, and optionally a reverse proxy with HTTPS for a public domain.
- **macOS** — everything runs as *you*, no sudo: per-user launchd agents in
  `~/Library/LaunchAgents`, bound to localhost, starting at login. Logs live in
  `~/.config/elowen/logs/`.
- **Windows** — the bootstrap enables **WSL2**, installs Ubuntu if missing, and
  runs the same Linux install inside it (tmux and systemd are Linux-only). A
  first-time WSL setup needs one reboot — re-run the command afterwards. The Web
  UI is then at `http://localhost:4500`.

Two optional environment variables tune the run: `ELOWEN_VERSION` pins a
specific npm version (`ELOWEN_VERSION=0.27.3`), and `ELOWEN_INSTALL_ARGS`
forwards flags to `elowen install` — pass `--unattended` with the deployment and
admin flags for a fully non-interactive install.

> Piping a script into a shell runs code from the network — inspect it first if
> you prefer: `curl -fsSL .../install.sh | less`.

The services, reverse proxy, and update timer the provisioner sets up are
covered in [Production & Updates](production-updates).

## npm global (recommended)

The fastest path when Node.js 22+ is already present:

```bash
npm install -g elowen
elowen setup          # guided onboarding wizard
```

`elowen setup` brings the daemon up and walks you through five quick steps, each
skippable and resumable:

1. **Account** — create the first admin, or an escapable, bounded sign-in on a
   re-run (a wrong password never traps you in a loop)
2. **Project** — register a repository for agents to work in
3. **AI provider** — connect an OpenAI-compatible or Anthropic provider, a
   preset, a custom endpoint, or a supported OAuth account (Claude, ChatGPT,
   GitHub Copilot, Kimi); pick a model, then run a **chat smoke-test** to confirm it answers.
4. **Memory** — optional embeddings for recall (reuse the provider's key or an
   OpenRouter key)
5. **Code intelligence** — optionally install the TypeScript language server so
   agents can type-check their own edits

The run ends with a readiness report ("What works now") and a **done screen**
with your next steps. Run `elowen doctor` any time for the same report on
demand: chat, memory, platforms, plugins, and deployment prerequisites, each with a plain-language hint for whatever isn't configured yet.

## The CLI-first flow

Elowen is agent-first, so the agent is one command away:

```bash
elowen                # opens the chat TUI
```

Everything else hangs off a small set of verbs:

- `elowen menu` — the interactive launcher: start/stop, status, logs, update, or
  jump straight into chat
- `elowen run "<prompt>"` (alias `elowen -p`) — non-interactive: run one turn,
  slash command, or autonomous goal, stream it, and exit
- the lifecycle verbs `elowen up` / `elowen down` / `elowen status` (see [Manual
  start](#manual-start-without-systemd) below)
- `elowen update` — pull the latest release and restart in place (see
  [Production & Updates](production-updates))

Prefer a browser? Open `http://localhost:4500`, sign in, and you land on the
Dashboard. See [Getting Started](getting-started) for your first chat and longer-running goal or workflow.

## Manual start (without systemd)

If you don't want systemd units, start both processes yourself:

```bash
elowen up
```

This launches the daemon on `:4400` and the web UI on `:4500`. Override the
ports with `ELOWEN_PORT` and `ELOWEN_WEB_PORT`. Stop them again with
`elowen down`. Or run the daemon directly — handy for a second instance, a
container, or a smoke test:

```bash
ELOWEN_PORT=4400 \
ELOWEN_DB=$HOME/.config/elowen/elowen.db \
ELOWEN_ALLOW_OPEN=1 \
node dist/daemon/index.js
```

`ELOWEN_ALLOW_OPEN=1` disables auth for local, single-user use. Leave it off for
anything reachable by others (see [First-run setup](#first-run-setup)).

## Build from source

```bash
git clone https://github.com/dragocz95/elowen.git
cd elowen
npm install
npm run build
node dist/daemon/index.js    # the daemon on :4400
```

Then the web UI in a separate terminal:

```bash
cd web
npm install
npm run build
npm start                    # serves on :4500, proxies to the daemon
```

## Ports & services

The daemon listens on `4400`, the web UI on `4500` — override with
`ELOWEN_PORT` and `ELOWEN_WEB_PORT`. The web UI never talks to the database
directly; it always goes through the daemon API. Port, proxy, and webhook
routing for a server install: [Production & Updates](production-updates).

## Data directory

The daemon keeps structured state in SQLite at `~/.config/elowen/elowen.db` by default (override with `ELOWEN_DB`), created automatically on first run. Encrypted plugin credentials additionally require `~/.config/elowen/plugin-secrets.key`; back up the database and key together. Plugin data, plans, logs, and attachments live beside them in the config directory.

## First-run setup

How you start the daemon the first time decides its auth mode:

- **Local, no auth** — start with `ELOWEN_ALLOW_OPEN=1`. Good for a single-user
  machine where nothing else can reach the port.
- **Browser onboarding** — while no user exists, the web UI lands on a first-run
  wizard instead of the login form: it creates the first admin and walks through
  the initial configuration, no CLI needed.
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
and each user can carry a **different set of tools and permissions**: which
executors they may run, which brain tools are enabled for them, and which
projects they can see. Set it all up later in [Configuration](configuration) and
the Users module.

## Non-interactive setup

For agents, CI, or scripted provisioning, `elowen setup` has a flag-driven mode
that runs the same onboarding without prompts — it creates the admin, connects a
project and an AI provider, runs the chat smoke-test, and prints a readiness
matrix. It exits non-zero on a missing required input, so a caller can branch on
it.

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

[Next: Docker](docker)
