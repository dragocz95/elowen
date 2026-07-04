---
title: Web UI
slug: web-ui
order: 5
eyebrow: Guide
---

# Web UI

A tour of the Orca web interface — page by page, control by control.

![Screenshot of the Orca dashboard](images/web-ui-dashboard.png)

## Dashboard `/dash`

The dashboard is your mission control. It shows:

- **Now section** — metric cards: open tasks, in progress, blocked, live
  sessions, active missions
- **Live agent lanes** — up to 6 active sessions with status dot, model icon,
  live tail snippet, activity badge
- **Quick actions** — New task, New mission links
- **Recent tasks** — last 6 non-epic tasks with status badges
- **Active missions** — list with done/total count, live indicators, capacity
- **Autopilot spotlight** — current phase per mission, progress ribbon,
  pause/resume/disengage controls
- **Recent outcomes** — last 6 closed tasks with result summaries

Data refreshes via 5-second polling + real-time SSE events.

## Tasks `/tasks`

The task view is your primary work surface.

**Day-grouped list** — tasks grouped by today / yesterday / date, paginated
(12 per page). Each task card shows: model icon, title + ID, live dot,
status/time/project badges, quick run controls. Hover reveals action menu;
right-click opens a context menu.

**Epics** — collapsible rows that ARE missions. Shows progress ribbon,
done/total count, lifecycle pills (Engage, Pause, Resume, Disengage),
rolled-up cost. PR missions show link/open/merge pills.

**Task detail pane** — right-side drawer: description, phases, dependencies,
executor, result summary, launch/edit/close actions.

**Task modal** — create/edit forms: title, details, type (Segmented control),
priority, executor (model pills with brand icons), schedule, autostart,
dependencies, project picker (when multi-project).

**Plan modal** — autopilot planning mode: goal input, autonomy L0–L3,
max sessions, PR workflow toggle, manual phase list, auto-model toggle,
Pilot live preview.

Supports deep-links: `?new=1` opens create, `?select=<id>` opens detail.

## Kanban `/kanban`

Two views:

- **Board** — 5 columns (Open / In progress / Blocked / Closed / Cancelled)
  with drag-and-drop. Epic cards show progress ribbon with expandable phases.
- **Calendar** — 3 modes: day (hourly), week (7-day), month (6-week matrix).
  Drag tasks between days to update scheduling.

## Sessions `/sessions`

Live agent sessions with:

- **Filter** — All / Needs input
- **Density toggle** — Comfortable / Compact
- **Session cards** — live status dot, model icon, live tail preview with
  ANSI coloring
- **Signal-aware UI** — Allow/Reject buttons on `needs_input` sessions
- **Terminal modal** — full Xterm.js terminal for interactive control

## Timeline `/timeline`

Activity visualization across three views:

- **Axis** — horizontal dot plot, dot size by frequency, hour gridlines,
  hover tooltip with details
- **Swimlanes** — per-target tracks (agents/sessions/tasks)
- **Feed** — collapsible event groups with ANSI-colored live tails

Plus **ChangesOverTime** — commit stream with file-type breakdown, most
active files, sparklines, clickable diff view.

## Escalations `/escalations`

Inbox for overseer rejections awaiting human resolution. Actions: approve
(release the review gate) or re-run the rejected phase. Self-clears once
resolved.

## Projects `/projects`

Project management with git integration:

- **Project cards** — slug, path, git status (branch, clean/dirty, ahead/behind)
- **New / Edit project** — path, notes, PR workflow toggle
- **Git section** — branches, recent commits
- **Open editor** — launches the Monaco code editor

### Project Editor

Self-hosted Monaco editor with:

- File tree (changed files highlighted, context menu)
- Multi-file tabs with dirty-state indicator
- Edit + diff modes, working changes vs HEAD
- Patch view for commits
- Image and Markdown preview
- File operations: new, rename, duplicate, delete

## Stats `/stats`

Usage analytics:

- **Summary cards** — total cost, total tokens, cache tokens, models used
- **Cost by model** — per-model rows with icon, proportional bar, token count
- **Admin reset** — wipe usage snapshots (confirmation required)

## Settings `/settings`

Admin-only configuration hub. Sections:

| Section | Purpose |
|---------|---------|
| **Models** | Enable/disable executor presets, add custom models, model descriptions for autopilot |
| **Autopilot** | Relay vs CLI Agents mode, model selectors, API key, planner prompt |
| **Brain** | Provider management, OAuth account connect (Anthropic/Copilot/OpenAI) |
| **GitHub** | Token, PR defaults, auth status |
| **Providers** | Binary paths, extra args, skip-permissions, resume toggles |
| **Plugins** | Enable/disable, per-plugin config editors (Discord, Cron, Skills, etc.) |
| **Memory** | Embedding provider + model picker, categorization model |
| **Defaults** | Default executor, autonomy, max sessions, token TTL |
| **System** | Version info, update button, auto-update toggle, service health + restart |
| **Data** | Danger zone — delete all data (admin-only) |

## Users `/users`

User management (admin-only):

- User cards with avatar, username, admin badge
- Toggle admin role
- Project assignment chips
- Per-user model allow-list
- Add user modal

## Account `/account`

Your personal settings, organized into tabs:

- **Profile** — avatar, name, email, UI scale slider, default model selector
- **Security** — password change
- **Notifications** — push notification toggles per device
- **CLI** — brain model, vision model, reasoning effort, communication style,
  Discord ID linking, auto-compact threshold
- **Memory** — auto-recall and auto-save toggles per user
- **Prompts** — per-user overrides of built-in prompt templates

[Next: CLI](cli)
