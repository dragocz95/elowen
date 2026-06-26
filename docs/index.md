# Orca Documentation

[![CI](https://github.com/dragocz1995/orcasynth/actions/workflows/ci.yml/badge.svg)](https://github.com/dragocz1995/orcasynth/actions/workflows/ci.yml)

## Quick links

| Document | Contents |
|---|---|---|
| [README.md](../README.md) | Top-level project overview, quick start, tech stack |
| [API.md](API.md) | Full REST API reference with request/response examples and status codes |
| [ARCHITECTURE.md](ARCHITECTURE.md) | System architecture, module descriptions, data flow, timer loops, VAPID keypair, PushDispatcher, UsageRecorder, access control |
| [CLI.md](CLI.md) | CLI commands (ls, ready, sessions, close, api, plan submit, overseer poll/decide, lifecycle: up/down/status/update/install) |
| [CONCEPTS.md](CONCEPTS.md) | Domain model: tasks, missions, autonomy levels, overseer, deriver, agent routing, event bus, assistant, push notifications, usage observability, PR workflow |
| [DEVELOPMENT.md](DEVELOPMENT.md) | Setup, npm scripts, conventions, project structure, configuration, adding endpoints |
| [DEPLOYMENT.md](DEPLOYMENT.md) | Production deployment: env block, systemd, Docker, nginx, web frontend, troubleshooting |
| [GUIDES.md](GUIDES.md) | Advanced patterns: task↔session binding, goal decomposition, overseer gate, deriver prompt detection, scheduled tasks, stuck detector, post-done review, async planning jobs, event store, executor routing |
| [SECURITY.md](SECURITY.md) | Auth model (scrypt, bearer, scope full/agent/advisor, agentProjects), decision engine, user management, multi-tenancy RBAC, login rate limit, infrastructure security |
| [TESTING.md](TESTING.md) | Test architecture, fakes, MSW, writing tests, daemon + web commands, CI |
| [WEB.md](WEB.md) | Web UI pages, components, data layer, real-time updates, design system, i18n, service worker, responsive design |

## Screenshots

The Next.js dashboard (`web/`) drives the whole daemon over the HTTP API. See [WEB.md](WEB.md) for the page-by-page reference.

![Dashboard](screenshots/dashboard.png)

| | |
|---|---|
| **Tasks** — list + detail with live agent output and token usage. ![Tasks](screenshots/tasks.png) | **Kanban** — open / in-progress / blocked / closed, with mission progress. ![Kanban](screenshots/kanban.png) |
| **Mission flow** — redesigned deployment-summary view with hero header, metric pills, and phase log. ![Mission flow](screenshots/mission-flow.png) | **Timeline** — a live activity feed across tasks, missions, and signals, plus commit history. ![Timeline](screenshots/timeline.png) |
| **Sessions** — real-time `tmux` agent previews with one-click intervention. ![Sessions](screenshots/sessions.png) | **Terminal** — the full agent TUI, including human-in-the-loop approvals. ![Terminal](screenshots/terminal.png) |
| **Task detail** — per-task change snapshots with file list and diff viewer, plus handoff notes. ![Task detail](screenshots/task-detail-changes.png) | **Context menu** — right-click context menu on tasks with run controls, metadata submenus, and lifecycle actions. ![Context menu](screenshots/context-menu.png) |
| **Segmented & pills** — connected segmented controls and executor model pills replace all native selects. ![Segmented & pills](screenshots/segmented-pills.png) | **Settings** — model presets & descriptions, providers, autopilot, defaults, system panel. ![Settings](screenshots/settings.png) |
| **Projects** — a built-in Monaco editor with the project file tree. ![Projects editor](screenshots/projects-editor.png) | **Escalations** — overseer rejections with approve/rerun actions. |

First-run onboarding walks through creating the admin user and the home project:

![Onboarding](screenshots/onboarding.png)

## Architecture overview

```
                    ┌───────────┐
                    │   Client   │
                    │ (CLI/Web)  │
                    └─────┬─────┘
                          │ HTTP/SSE
                          ▼
               ┌──────────────────┐
               │   Hono Server    │
               │   port 4400      │
               └──────┬───────────┘
                      │
              ┌───────┼───────────────────────┐
              ▼       ▼                       ▼
      ┌──────────────┐   ┌──────────────────┐   ┌──────────────┐
      │  TaskStore   │   │  MissionEngine   │   │   EventBus   │
      │  (CRUD)      │   │  (90s tick)      │   │  (SSE push)  │
      └──────┬───────┘   └──────┬───────────┘   └──────────────┘
             │                  │
              │         ┌────────▼────────┐
              │         │   Routing      │
              │         │   + Decision   │
              │         └────────┬────────┘
             │                  │
             │         ┌────────▼────────┐
             │         │  SpawnService   │
             │         │  (tmux launch)  │
             │         └────────┬────────┘
             │                  │
             │         ┌────────▼────────┐
             │         │    Deriver      │
             │         │  (5s poll loop) │
             │         └────────┬────────┘
             │                  │
             ▼                  ▼
      ┌──────────────────────────────────────┐
      │           SQLite (WAL)               │
      │  tasks / missions / agents / users   │
      └──────────────────────────────────────┘
```

Additional parallel loops: **Deriver** (5s), **Scheduler** (30s), **Janitor** (60s), **Stuck detector** (60s), **Overseer watchdog** (60s), **Token purge** (1h), **Event purge** (1h).

## Key concepts

- **Tasks** — units of work, tree structure via `parent_id`, dependency DAG via `task_deps`
- **Missions** — group tasks under an epic with autonomy level (L0–L3) and `max_sessions` cap (folded into Tasks UI)
- **Autonomy levels** — L0–L3 gate auto-spawn and prompt handling
- **Overseer** — decision gate: relay LLM or parked per-mission agent; centralized `gateVerdict()` threshold; supports post-done reviews (hard gate)
- **Pilot** — repo-aware planning agent; submits phases via `orca plan submit`; prompt in `prompts/pilot.md`
- **Autopilot** — two backends: relay LLM or CLI agent (Pilot); phases from `prompts/planner.md` template
- **Assistant** — per-user advisor session driving Orca on the user's behalf via a built-in MCP server; `orca api` CLI passthrough; docked IDE-style panel with a real-PTY terminal and pop-out window
- **Per-model descriptions & autoModel** — write capability descriptions per model in Settings; flip "Autopilot picks the model" and the planner selects the best model per phase from those descriptions, validated against the allow-list
- **Deriver** — polls tmux panes every 5s, detects agent state via `shellPatterns.ts`, auto-approves via overseer gate
- **Event bus** — SSE for real-time UI updates; `GET /events`; drives PushDispatcher + UsageRecorder subscribers
- **Phone push notifications** — VAPID-based web-push for mission events (review escalation, needs_input, stall, completion, blocked); opt-in per device from Account; inline action buttons (Allow/Reject, Approve/Rerun, Open)
- **PR-native workflow** — per-mission isolated worktree + dedicated branch → GitHub PR; auto/manual open; verify command gate; feedback polling with fix budget (2 rounds); requires `gh` CLI + token
- **Usage observability** — live per-task token/cost via CLI session storage; persisted snapshots in `task_usage` table on settle; per-model aggregate stats at `GET /usage/by-model`
- **Session info** — `classifySession()` classifies every `orca-*` session (agent / pilot / overseer / advisor) with structured identity
- **Guardrails** — removed in v1.1.1 (false-positive matches stalled missions); destructive heuristic still enforced at decision enqueue time
- **Projects** — built-in Monaco editor with file tree, read/write/diff; project picker in task/autopilot modals; PR-native workflow per-project

## Prompt templates

All LLM prompts are stored as Markdown templates under `prompts/` and rendered at runtime via `src/prompts/index.ts` with `{{placeholder}}` variable substitution. The build copies the entire `prompts/` directory into `dist/prompts/`.

| Template | Used by | Placeholders |
|---|---|---|---|
| `planner.md` | Autopilot relay: goal → phases decomposition | `{{goal}}`, `{{project}}`, `{{models}}` |
| `planner-fallback.md` | Planner when no custom template is saved | `{{goal}}`, `{{models}}` |
| `pilot.md` | Pilot agent: repo-aware CLI planning | `{{goal}}`, `{{notes}}`, `{{submit}}`, `{{jobId}}`, `{{models}}` |
| `overseer.md` | Parked overseer agent: per-mission decision loop | — |
| `advisor.md` | Per-user assistant agent: drives Orca on the user's behalf | `{{userName}}` |
| `worker.md` | Worker agent: general task execution | — |
| `worker-phase.md` | Phase agent: epic child task execution | — |
| `worker-epic-close.md` | Final-phase agent: also closes parent epic | — |
| `decision-header.md` | Shared overseer decision header | — |
| `decision-prompt.md` | Overseer prompt-gate decision body | — |
| `decision-question.md` | Overseer multiple-choice question body | `{{autonomy}}`, `{{question}}`, `{{context}}`, `{{options}}` |


## Timer loops

| Loop | Interval | Purpose |
|---|---|---|---|
| Overseer (engine tick) | 90 s | Tick active missions: pick ready tasks, spawn agents |
| Scheduler | 30 s | Launch due scheduled/autostart tasks |
| Janitor | 60 s | Kill zombie tmux sessions whose task is already closed/cancelled |
| Stuck detector | 60 s | Revert tasks whose agent died without `orca close` (bounded, escalate after 2 relaunch attempts) |
| Deriver | 5 s | Poll tmux panes, detect agent state, auto-approve known prompts via overseer gate |
| Overseer watchdog | 60 s | Re-park missing overseer agents for active/stalled missions (crash recovery) |
| Token purge | 1 h | Delete expired auth tokens (TTL from `config.security.tokenTtlDays`) |
| Event purge | 1 h | Drop `events` rows past the 30-day retention window (`eventStore.purgeOlderThan()`) |
| Ticket sweep | 60 s | Sweep expired terminal-WS single-use tickets |
| PR feedback | 60 s | Poll open PRs for fresh actionable review feedback, re-engage mission with fix phases |

See [ARCHITECTURE.md](ARCHITECTURE.md) for module details.

## Run / build / test

```bash
# Daemon
npm install && npm run build        # compile TS → dist/, copy schema.sql + prompts/
npm run serve                       # dev mode (direct TS via --experimental-strip-types)
npm test                            # daemon tests (~915)
npm run lint                        # ESLint + dependency-cruiser architecture checks
node dist/daemon/index.js           # production start

# Web
cd web && npm install
npm run dev                         # Next.js dev server (turbopack)
npm test                            # web tests (~469)
npm run build && npm start          # production
```

CI runs both daemon and web jobs in parallel on every push/PR to `main` — see [`.github/workflows/ci.yml`](../.github/workflows/ci.yml).


