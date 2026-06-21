<div align="center">

# Orcasynth

**Control autonomous coding agents — without losing control.**

Plan work, launch isolated coding agents, watch every session, and step in
before risky changes reach your codebase.

`Plan · Dispatch · Observe · Intervene`

Orcasynth is a self-hosted daemon that runs coding agents (Claude Code, OpenCode,
Codex) in isolated `tmux` sessions — with a REST API, a CLI, and a real-time web UI.

[![CI](https://github.com/dragocz1995/orcasynth/actions/workflows/ci.yml/badge.svg)](https://github.com/dragocz1995/orcasynth/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22-43853d.svg)](https://nodejs.org)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](./CONTRIBUTING.md)

</div>

---

## What it does

- **Autopilot planning.** Give the Pilot a goal; an LLM decomposes it into ordered
  phases, names an agent per phase, and chains them by dependency.
- **Agent-agnostic spawning.** Runs Claude Code, OpenCode, or Codex in `tmux`,
  configurable per task. Each agent gets the task context and closes its own task when done.
- **Autonomy levels (L0–L3).** The overseer auto-clears safe permission prompts at
  higher autonomy and escalates destructive or uncertain ones to a human.
- **Live web UI.** Tasks, a kanban board + calendar, missions with progress, a timeline,
  and live `tmux` session previews with one-click agent intervention. EN/CS i18n built in.
- **Guardrails & self-healing.** Sensitive work (schema, auth, payments, destructive ops) is
  blocked until cleared, with an optional LLM overseer gate; a stuck-session detector revives
  agents that die without closing out, and live token/cost usage is shown per run.
- **Multi-user RBAC.** Per-project assignments, per-user model allow-lists, profiles & avatars,
  and a first-run onboarding that needs no login until the first admin is created.
- **Self-hosted & lightweight.** A single SQLite-backed daemon (Hono) + a Next.js front end.
  No external services required beyond your LLM provider.

## Screenshots

<div align="center">

**Dashboard** — live agents, active missions, autopilot spotlight, and recent outcomes at a glance.

![Dashboard](docs/screenshots/dashboard.png)

</div>

| | |
|---|---|
| **Tasks** — list + detail with live agent output and token usage. ![Tasks](docs/screenshots/tasks.png) | **Kanban** — open / in-progress / blocked / closed, with mission progress. ![Kanban](docs/screenshots/kanban.png) |
| **Missions** — phase graph and task flow for an autopilot run. ![Missions](docs/screenshots/missions.png) | **Timeline** — a live activity feed across tasks, missions, and signals. ![Timeline](docs/screenshots/timeline.png) |
| **Sessions** — real-time `tmux` agent previews with one-click intervention. ![Sessions](docs/screenshots/sessions.png) | **Terminal** — the full agent TUI, including human-in-the-loop approvals. ![Terminal](docs/screenshots/terminal.png) |
| **Projects** — a built-in Monaco editor with the project file tree. ![Projects editor](docs/screenshots/projects-editor.png) | **Settings** — model presets, providers, autopilot, and defaults. ![Settings](docs/screenshots/settings.png) |

<div align="center">

**Onboarding** — a first-run setup flow that needs no login until the first admin is created.

![Onboarding](docs/screenshots/onboarding.png)

</div>

## Quick start

Requires **Node ≥ 22** and **tmux**.

```bash
# 1. Daemon (REST API on :4400)
npm install
npm run build
ORCA_BOOTSTRAP_USER=admin ORCA_BOOTSTRAP_PASS=changeme node dist/daemon/index.js

# 2. Web UI (on :4500)
cd web
npm install
NEXT_PUBLIC_ORCA_URL=http://localhost:4400 npm run build
npm start
```

Open <http://localhost:4500> and sign in. Configure your LLM provider and models in
**Settings → Autopilot / Models**, then create a task or engage an autopilot mission.

The CLI auto-starts the daemon if it isn't running:

```bash
node dist/cli/index.js ls        # list tasks
node dist/cli/index.js close <id>
```

## Architecture

A daemon (`src/`) owns the database and the orchestration loop; the web app (`web/`)
is a thin client over the REST API + SSE event stream.

| Layer | What lives there |
|-------|------------------|
| `src/store` | SQLite stores (tasks, missions, agents, config, users) |
| `src/overseer` | mission engine, scheduler, planner, decision engine, janitor |
| `src/spawn` · `src/tmux` | agent command building + tmux driver |
| `src/deriver` | derives signals from agent output (working / needs-input / complete) |
| `src/api` | Hono REST server + SSE bus |
| `web/modules` | feature modules (tasks, kanban, missions, sessions, timeline, …) |

See [`docs/`](./docs) for the [API](./docs/API.md), [architecture](./docs/ARCHITECTURE.md),
[concepts](./docs/CONCEPTS.md), [CLI](./docs/CLI.md), and [development](./docs/DEVELOPMENT.md) guides.

## Development

```bash
npm test            # daemon tests (vitest)
npm run build       # typecheck + build
cd web && npm test  # web tests
```

See [`docs/DEVELOPMENT.md`](./docs/DEVELOPMENT.md) and [`docs/TESTING.md`](./docs/TESTING.md).

## Contributing

Contributors are welcome — whether it's a bug fix, a new feature, or just an idea.

- 💡 **Have a suggestion?** Open a [feature request](https://github.com/dragocz1995/orcasynth/issues/new?template=feature_request.md) and tell us what would make Orcasynth better.
- 🐛 **Found a bug?** File a [bug report](https://github.com/dragocz1995/orcasynth/issues/new?template=bug_report.md).
- 🔧 **Want to hack on it?** Read [CONTRIBUTING.md](./CONTRIBUTING.md), open a PR, and check the [Code of Conduct](./CODE_OF_CONDUCT.md).

Star the repo if you find it useful — it helps others discover the project.

## License

[MIT](./LICENSE)
