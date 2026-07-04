<div align="center">

# Orcasynth

**Your personal AI agent.**

`Chat · Plan · Delegate · Automate`

Orca is a self-hosted personal AI agent that orchestrates autonomous coding
agents, runs a built-in brain for chat and automation, supports plugins
(Discord, cron, skills, memory, and more), and gives you a web UI and CLI
to control everything. No SaaS, no lock-in — your machine, your agents, your
code.

[![CI](https://github.com/dragocz1995/orcasynth/actions/workflows/ci.yml/badge.svg)](https://github.com/dragocz1995/orcasynth/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22-43853d.svg)](https://nodejs.org)

</div>

---

## What it does

- **Autopilot planning.** Give the Pilot a goal and an LLM decomposes it into
  ordered phases with dependencies. Each phase spawns an agent in its own tmux
  session. Independent phases can run in parallel up to your session limit.
- **Autonomy levels (L0–L3).** Choose how much rope each mission gets — from
  L0 (plan only) to L3 (full autonomy). The overseer's decision engine
  auto-clears safe actions and escalates anything destructive.
- **Brain & Chat.** A built-in AI assistant accessible via web dock, CLI
  (`orca chat`), or Discord. Multi-provider model catalog with OAuth account
  connect (Anthropic, Copilot, OpenAI). Memory, personality, and plugin support.
- **Plugin system.** Extend the brain with tools, platforms, and skills.
  12 bundled plugins: Discord bot, cron jobs, file tools, terminal, web
  search, image generation/editing, skills, security scanning, subagent
  delegation, statusline, runtime context.
- **PR-native workflow.** Missions work in isolated git worktrees, commit
  each approved phase, and open a GitHub pull request. Review feedback flows
  back as fix phases — bounded to 2 rounds, then escalates.
- **Agent-agnostic spawning.** Runs Claude Code, OpenCode, or Codex in
  isolated tmux sessions, configurable per task.
- **Real-time web UI.** Dashboard, tasks, kanban board, timeline, live session
  previews with real PTY streaming, built-in Monaco editor, stats.
- **Phone push notifications.** Web Push with inline action buttons (Allow,
  Reject, Approve, Rerun) when a mission needs you.
- **Self-healing.** Stuck detector revives dead agents, janitor cleans up
  finished sessions. Token and cost usage shown per run.
- **Multi-user RBAC.** Admin and member roles, per-project assignments,
  per-user model allow-lists.
- **Self-hosted & lightweight.** Single SQLite-backed daemon + Next.js front
  end. No external services beyond your own LLM provider.

## Install

```bash
npm install -g orcasynth
orca                    # interactive menu
orca install            # guided provisioning wizard
orca up                 # start daemon (:4400) + web UI (:4500)
```

Requires **Node ≥ 22** and **tmux**. Open `http://localhost:4500` and log in.

```bash
orca chat               # talk to your AI assistant
orca status             # check what's running
orca update             # update to latest version
```

## Screenshots

<div align="center">

**Dashboard** — live agents, active missions, autopilot spotlight.

![Dashboard](docs/screenshots/dashboard.png)

</div>

| | |
|---|---|
| **Tasks** — list + detail with live output. ![Tasks](docs/screenshots/tasks.png) | **Kanban** — board and calendar view. ![Kanban](docs/screenshots/kanban.png) |
| **Sessions** — real-time tmux previews. ![Sessions](docs/screenshots/sessions.png) | **Terminal** — interactive PTY streaming. ![Terminal](docs/screenshots/terminal.png) |
| **Projects** — built-in Monaco editor. ![Editor](docs/screenshots/projects-editor.png) | **Settings** — models, providers, plugins. ![Settings](docs/screenshots/settings.png) |

## Architecture

```
                  ┌──────────────┐
  Browser ───────▶│  Web (:4500) │───────┐
                  │  Next.js BFF │       │
                  └──────────────┘       │
                                          ▼
  orca chat ─────▶┌──────────────────┐ ┌──────────┐
  orca ls  ──────▶│  Daemon (:4400)  │ │ SQLite   │
  Discord  ──────▶│  REST + SSE + WS │ │ orca.db  │
                  └────────┬─────────┘ └──────────┘
                           │
                    ┌──────┴──────┐
                    │  tmux       │
                    │  sessions   │
                    └─────────────┘
```

See [`docs/`](./docs) for the [documentation hub](./docs/index.md),
[Getting Started](./docs/site/01-getting-started.md),
[Brain & Chat](./docs/site/07-brain-chat.md), and [Plugins](./docs/site/08-plugins.md).

## Development

```bash
npm test            # daemon tests (~471 cases)
npm run build       # typecheck + build
cd web && npm test  # web tests (~313 cases)
cd web && npm run dev  # web dev server
```

See [`docs/DEVELOPMENT.md`](./docs/DEVELOPMENT.md).

## License

[MIT](./LICENSE)
