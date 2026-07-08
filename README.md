<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/brand/elowen-logo-white.png">
  <img alt="Elowen" src="docs/brand/elowen-logo-black.png" width="380">
</picture>

**A personal AI agent you talk to — self-hosted, and yours.**

`Chat · Act · Automate · Extend`

Elowen is a self-hosted personal AI agent. You chat with it and it acts: it plans,
calls tools, edits files, runs shell commands, and manages your tasks — and it
reaches you wherever you are: the `elowen` CLI, the web dock, Discord, or WhatsApp.
Same agent, same tools, same memory on every surface. It runs on **your**
machine, uses **your** models, and every capability is a plugin you add or
remove. No SaaS, no lock-in.

[![CI](https://github.com/dragocz95/elowen/actions/workflows/ci.yml/badge.svg)](https://github.com/dragocz95/elowen/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22-43853d.svg)](https://nodejs.org)

</div>

---

## Meet your agent

<div align="center">

![The Elowen CLI — a reply with tool calls, a git-style diff and the telemetry panel](docs/screenshots/cli/05-diff.png)

</div>

```bash
npm install -g elowen   # installs the `elowen` command
elowen setup                 # guided wizard: account, project, AI provider, memory
elowen                       # bare `elowen` opens the chat TUI
```

The agent is the product. The dashboards, boards and terminals further down are
how you **observe and steer** what it's doing — they are not the point; the
agent is.

## What makes it Elowen

- **Clarity** — a clean, uncluttered UI where you always see what the agent is doing.
- **Simplicity** — easy to run, easy to control, sensible defaults, low friction.
- **Fully extensible** — every capability (chat platforms, tools, memory,
  automation, security) is an add/remove-able plugin. Elowen is modular to the core.
- **Lightweight, professional-grade** — one SQLite-backed daemon plus a Next.js
  web UI. Small footprint, clean, tested codebase.

## The terminal is home

The `elowen` CLI is the full agent in your shell — an opencode-style TUI with a
streaming transcript, a telemetry panel (context, project, branch, LSP), and a
slash-command menu. Tool calls render dim and collapse when done; file edits show
as git-style diffs; model reasoning folds into clickable **Thought** rows you can
toggle with `/reasoning show`.

| | |
|---|---|
| **Streaming tool calls & Thought rows** — watch the agent reason and act, with collapsed reasoning above each call. ![Tool calls with Thought rows](docs/screenshots/cli/02-tool-calls.png) | **Plan mode** — `shift+tab` or `/plan`: mutating tools are hidden server-side while the agent thinks; a "Plan ready" picker then offers Implement or keep refining. ![Plan ready](docs/screenshots/cli/08-plan-ready.png) |
| **Permissions** — every mutating tool call stops for Allow once / Always allow / Deny; `Esc` always means Deny, never abort. ![Approval prompt](docs/screenshots/cli/06-approval-touch.png) | **Todos** — multi-step work keeps a live checklist above the status bar, alongside pending approvals. ![Todos checklist](docs/screenshots/cli/09-todos.png) |

**Sub-agents you can drill into.** Ask the agent to delegate and it spawns
sub-agents in their own sessions — each a live status row in the transcript.
Click one (or press `ctrl+o`) to open the child's transcript and steer it
directly; `esc` pops back out.

<div align="center">

![Drilled into a sub-agent's own transcript — its task, tool calls and answer](docs/screenshots/cli/12-subagent-drillin.png)

</div>

And the input line does more than send text:

- **`@` file mentions** — a fuzzy, frecency-ranked file picker; text files attach
  inline, images ride along as real attachments (`@clipboard` grabs the clipboard).
- **`!cmd` local shell** — run a command on *your* machine, see its output, and
  have it buffered as context for your next prompt.
- **`/yolo`** — auto-approve tool asks for this session (deny rules still apply);
  a warning-toned YOLO chip makes sure it's never silent.
- **Pickers & prefs** — `/model` (providers, auto-fetched catalogs, OAuth
  accounts), `/theme` (15 built-in themes), and `/keybinds` to rebind every
  modifier chord live, persisted per machine.
- **Headless** — `elowen run "<prompt>"` for scripts and CI, with `--json` JSONL
  event output and meaningful exit codes.

The full reference — every command, key and flag — lives in
[`docs/site/06-cli.md`](./docs/site/06-cli.md).

## Give it real work

- **Tasks** are the atomic unit: each one runs an agent in its own isolated tmux
  session, on Elowen's built-in engine or a coding-agent CLI (Claude Code,
  OpenCode, Codex, Kilo Code) — configurable per task.
- **Missions (autopilot)** decompose a bigger goal into ordered phases — plan →
  engage → execute → review → complete — and drive them end to end, with
  dependencies, scheduling, and mid-flight replanning.
- **Autonomy levels L0–L3** decide how much runs without asking you, from
  *Recommend* (nothing runs unapproved) to *Auto* (reaches out only when stuck).
  An **overseer** — an LLM relay or a dedicated parked agent — vets each action
  at a confidence threshold; destructive actions always escalate to you.
- **The `/goal` loop** turns chat into an autonomous run: a persistent goal keeps
  taking turns until it settles, pausing at a configurable turn budget — and a
  hard safety ceiling stops even a YOLO'd goal from burning tokens forever.
- **PR-native mode** runs each phase in an isolated git worktree, commits per
  phase, and opens a real GitHub pull request for review.
- **Human-in-the-loop** — blocked work stalls instead of retrying blindly and
  lands in an Escalations inbox; web push notifications with inline actions
  reach your phone. A stuck detector and janitor self-heal dead sessions.

## It remembers, and it's yours

<div align="center">

![The Memory module — a glass-brain map of stored memories](docs/site/images/brain-memory.png)

</div>

- **Recall** — before each reply, the most relevant durable memories are
  retrieved (semantic with an embedding model, keyword otherwise) and injected
  as context — never as instructions, so a stored note can't hijack the agent.
- **Curation** — after each exchange, a cheap model distills durable, reusable
  facts and applies a small capped batch of edits; greetings and transient noise
  are deliberately ignored.
- **Per-user and private** — nothing bleeds between accounts; browse, merge and
  purge everything the agent knows from the Memory module.
- **Personality** — each user shapes the agent's communication style per
  platform: terse in the CLI, friendlier on Discord, formal on WhatsApp.

## Everything is a plugin

Fourteen bundled plugins ship out of the box — the **Discord** and **WhatsApp**
platforms; **files**, **terminal**, **MCP bridge**, **sub-agent** and ask-user
tools; **cron** automation; skills, formatters and dev-commands; a security
scanner; statusline and runtime context. A built-in **marketplace** installs,
updates and removes more, each with a toggle, its own generated config form and
a detail page showing exactly what it contributes.

<div align="center">

![The Plugins section in Settings — installed plugins with category filters](docs/site/images/plugins-overview.png)

</div>

## Watch and steer: the web UI

Because Elowen runs real work for you, it gives you rich surfaces to observe and
control it — a live dashboard, tasks with live agent output, a kanban board, a
timeline, real tmux terminals you can jump into, a Monaco editor, per-run
token/cost stats, and operator-tunable **limits** (tool-output size, memory
recall budget, goal turn budget and safety ceiling, max steps per request — all
clamped to safe ranges).

<div align="center">

![Dashboard — live agents, active missions, autopilot spotlight](docs/site/images/web-ui-dashboard.png)

</div>

| | |
|---|---|
| **Kanban** — tasks move across open / in-progress / blocked / done as agents work; chain dependencies by drag-and-drop. ![Kanban](docs/site/images/web-ui-kanban.png) | **Sessions** — real-time tmux previews with PTY streaming; pop open a terminal and intervene with one click. ![Sessions](docs/site/images/web-ui-sessions.png) |
| **Users & RBAC** — each user gets a different set of tools, models and projects; the agent only wields what you're allowed to use. ![Users](docs/site/images/users-rbac.png) | **Chat dock** — the agent follows you across every module, with tool-call traces and a per-conversation model picker. ![Chat dock](docs/site/images/getting-started-chat.png) |

## Install

```bash
npm install -g elowen   # installs the `elowen` command
elowen setup                 # ~2-minute guided wizard
```

Requires **Node ≥ 22** and **tmux**. `elowen setup` brings the daemon and web UI
up, then walks you through five skippable, re-runnable steps: **account**,
**project**, **AI provider** — sign in with Claude, GitHub Copilot or
ChatGPT/Codex, paste an API key, or point at any OpenAI-compatible endpoint,
capped with a live chat smoke-test — **memory**, and optional **code
intelligence** (TypeScript language server). In a non-interactive shell it never
blocks; for a full server deployment (dedicated user, systemd units, reverse
proxy with optional HTTPS), run `elowen install` as root instead.

Then just talk to it:

```bash
elowen                        # opens the chat TUI
elowen run "<prompt>"         # non-interactive: one turn, streamed, then exit
elowen up | down | status     # manage the daemon (:4400) + web UI (:4500)
elowen doctor                 # readiness report: what works, how to fix the rest
elowen update                 # update to the latest release
```

Or open `http://localhost:4500` and log in for the web UI.

## Architecture

```
                  ┌──────────────┐
  Browser ───────▶│  Web (:4500) │───────┐
                  │  Next.js BFF │       │
                  └──────────────┘       │
                                          ▼
  elowen CLI ──────▶┌──────────────────┐ ┌──────────┐
  Discord  ──────▶│  Daemon (:4400)  │ │ SQLite   │
  WhatsApp ──────▶│  REST + SSE + WS │ │ elowen.db  │
                  └────────┬─────────┘ └──────────┘
                           │
                    ┌──────┴──────┐
                    │  tmux       │
                    │  sessions   │
                    └─────────────┘
```

One self-hosted daemon (REST + SSE + WebSocket + a built-in MCP server) backed by
SQLite, a Next.js web UI that talks to it over a same-origin BFF proxy so the
daemon stays private, and agents that run in isolated tmux sessions. The `elowen`
CLI is a thin client over the same REST API, with daemon autostart built in.
Deep dive: [`docs/site/12-architecture.md`](./docs/site/12-architecture.md).

## Documentation

Full user manual at **[elowen.dragocz.dev](https://elowen.dragocz.dev)** and in
[`docs/site/`](./docs/site):
[Getting Started](./docs/site/01-getting-started.md) ·
[Install](./docs/site/02-install.md) ·
[Tasks & Missions](./docs/site/03-tasks-missions.md) ·
[Agents & Autonomy](./docs/site/04-agents-autonomy.md) ·
[Web UI](./docs/site/05-web-ui.md) ·
[CLI](./docs/site/06-cli.md) ·
[Brain & Chat](./docs/site/07-brain-chat.md) ·
[Plugins](./docs/site/08-plugins.md) ·
[Projects & Workflow](./docs/site/09-projects-workflow.md) ·
[Configuration](./docs/site/10-configuration.md) ·
[Account & Security](./docs/site/11-account-security.md) ·
[Architecture](./docs/site/12-architecture.md)

## Development

```bash
npm test               # daemon test suite (Vitest)
npm run build          # typecheck + build
npm run check          # lint + dead-code + dependency boundaries + typecheck
cd web && npm test     # web test suite
cd web && npm run dev  # web dev server
```

See [`docs/DEVELOPMENT.md`](./docs/DEVELOPMENT.md) for the full contributor guide.

## Built with

Elowen stands on a small, deliberately chosen open-source stack:

- **Agent core** — the embedded brain and the chat TUI are built on the **PI
  toolkit** ([`@earendil-works/pi-ai`](https://github.com/earendil-works/pi),
  `pi-coding-agent`, `pi-tui`) — a lean multi-provider LLM / agent / terminal-UI
  SDK. External clients plug in through the **Model Context Protocol**
  (`@modelcontextprotocol/sdk`).
- **Daemon** — [Hono](https://hono.dev) (REST + SSE + WebSocket) over
  [better-sqlite3](https://github.com/WiseLibs/better-sqlite3), with **TypeBox** +
  **Zod** for schema validation and **web-push** for phone notifications. Agents
  run in isolated **tmux** sessions.
- **Chat platforms** — **Baileys** + **qrcode** power the WhatsApp plugin; the
  Discord plugin is a dependency-free gateway on Node's built-in WebSocket + fetch.
- **Web UI** — [Next.js](https://nextjs.org) + **React**,
  **@tanstack/react-query**, the **Monaco** editor, **xterm.js** for live
  terminals, **lucide** icons, **marked** + **DOMPurify** for safe Markdown, and
  the **Geist** typeface.
- **Quality gates** — **Vitest**, strict **TypeScript**, **ESLint**, **Knip**
  (dead code) and **dependency-cruiser** (architecture boundaries).

See [`package.json`](./package.json) and [`web/package.json`](./web/package.json)
for the complete dependency list.

## License

[MIT](./LICENSE)
