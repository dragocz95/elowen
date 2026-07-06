# Web UI

Next.js 16 (App Router) frontend at `web/`. React 19, Tailwind CSS 4,
TanStack React Query, Xterm.js, Monaco editor.

## Routes

Every page is a thin shell in `app/<route>/page.tsx` rendering a `*View` from
`modules/` inside a `ModuleShell`. All pages are `'use client'` with
`dynamic = 'force-dynamic'`.

| Route | Module | View | Nav group |
|-------|--------|------|-----------|
| `/dash` | `dashboard/` | `DashboardView` | Operate |
| `/stats` | `stats/` | `StatsView` | Operate |
| `/tasks` | `tasks/` | `TasksView` | Operate |
| `/kanban` | `kanban/` | `KanbanBoard` + `CalendarView` | Operate |
| `/sessions` | `sessions/` | `SessionsView` | Operate |
| `/timeline` | `timeline/` | `TimelineView` | Operate |
| `/escalations` | `escalations/` | `EscalationsView` | Operate |
| `/projects` | `projects/` | `ProjectsView` | Operate |
| `/editor` | `editor/` | `ProjectEditor` | Config |
| `/terminal/[name]` | — | chromeless pop-out terminal | — |
| `/settings` | — | inline in `app/settings/page.tsx` | Config |
| `/users` | `users/` | `UsersView` | Config |
| `/account` | `account/` | `AccountView` | — |
| `/onboarding` | — | first-run wizard | — |

Module metadata (id, route, icon, group) in each `modules/<name>/meta.ts`,
registered in `modules/registry.ts`.

## Auth

- **LoginGate** — wraps the entire app, probes `/api/auth/me` on mount
- **Token** — httpOnly session cookie, never in JS or `localStorage`. The
  browser talks to the same-origin `/api` BFF proxy with
  `credentials: 'same-origin'`. No `NEXT_PUBLIC_ORCA_URL`.
- **Logout** — expires the cookie server-side, fires `orca:auth-cleared` event
- **EventBridge** — only mounted after auth

### Role-based access

- **Admin** — sees and manages everything
- **Non-admin** — only assigned projects via `user_projects`
- **Assignment management** — admin-only, in Users page
- **Model allow-list** — admin restricts which models a non-admin may run

## Key pages

### Dashboard `/dash`

`DashboardView` — bento-style home with: metric cards, live agent lanes,
quick actions, recent tasks, active missions, autopilot spotlight, outcomes.

Data refreshes via 5s polling + SSE events.

### Tasks `/tasks`

Day-grouped list, paginated (12/page). Task cards with model icon, status,
quick run controls, right-click context menu. Epic rows with progress ribbon,
lifecycle pills, rolled-up cost.

**Modals:** TaskModal (create/edit), PlanModal (autopilot), AddPhaseModal.
Supports deep-links (`?new=1`, `?select=<id>`).

**MissionFlow** — redesigned mission detail with hero header, metric pills,
phase log with state glyphs, result summary.

### Kanban `/kanban`

Board (5 columns, drag-and-drop) + Calendar (day/week/month). Epic cards
with progress ribbon. Drag tasks to reschedule.

### Sessions `/sessions`

Live cards with status dot, ANSI-parsed tail, Allow/Reject buttons.
Density toggle, terminal modal.

### Timeline `/timeline`

Axis (dot plot), Swimlanes (per-target), Feed (collapsible). Events within
5 minutes collapse into `×N` groups. **ChangesOverTime** — commit stream,
most active files, sparklines, clickable patches. Date range filter, project
pills.

### Escalations `/escalations`

Inbox for overseer rejections awaiting human resolution. Self-clearing.

### Projects `/projects`

Cards with git status. Monaco editor: file tree, multi-file tabs, edit/diff
modes, patch view, image/markdown preview.

### Settings `/settings`

Admin-only. Sections: Models, Autopilot, Brain, GitHub, Providers, Plugins
(with per-plugin editors), Defaults, System, Data.

### Users `/users`

Admin-only user management with project assignment and model allow-list.

### Account `/account`

Tabs: Profile, Security, Notifications, CLI, Prompts. Per-user settings for
brain model, reasoning effort, communication style, auto-compact.

### Onboarding `/onboarding`

First-run wizard: system deps, providers, autopilot, users.

## Data layer

### orcaClient (`lib/orcaClient.ts`)

Thin fetch wrapper. Sets `BASE = '/api'`, `credentials: 'same-origin'`.
On 401, clears token and throws `OrcaApiError`.

### Queries (`lib/queries.ts`)

All data via TanStack React Query hooks. Key patterns:

| Hook | Key | Polling |
|------|-----|---------|
| `useTasks` | `['tasks']` | 5 s |
| `useSessions` | `['sessions']` | 5 s |
| `useMissions` | `['missions']` | — |
| `useConfig` | `['config']` | — |
| `useMe` | `['me']` | 5 min stale |
| `useSystem` | `['system']` | 60 s |
| `useAdvisorStatus` | `['advisor-status']` | 5 s |
| `usePlanJob` | `['plan-job', id]` | 1 s while planning |
| `useModelUsage` | `['usage-by-model']` | 30 s |

### Mutations (`lib/mutations.ts`)

Auto-invalidate related caches on success. Mutations for: tasks, missions,
sessions, projects, config, users, plugins, brain, memory, advisor, system.

### Real-time updates

Two SSE connections:

1. **Event bus** (`/events`) — global state changes via `useOrcaEvents`
2. **Pane stream** (`/sessions/:name/stream`) — per-session terminal content

Events: `task`, `mission`, `signal`, `plan`, `review`.

## Assistant dock (`modules/advisor/`)

A resizable side panel (left or right) with two modes:

- **Chat** — `BrainChat`, talking to the brain over SSE (`GET /brain/stream`).
  Conversation picker, fulltext search, tool-call trace, statusline.
- **Terminal** — each pane is a tmux-spawned assistant or a live session view.

Dock state persisted in `localStorage`. Floating `AdvisorLauncher` when closed.

## Terminal (`components/terminal/`)

| Component | Purpose |
|-----------|---------|
| `StreamTerminal` | Real-PTY via WebSocket + `tmux attach` + `node-pty` |
| `Terminal` | Xterm.js with SSE snapshot stream fallback |
| `LiveTail` | Inline live tail for dashboard lanes |

**PTY streaming:** Single-use ticket via `POST /sessions/:name/ws-ticket`,
then `wss://<host>/ws/terminal?ticket=…` straight to the daemon. Falls back
to snapshot terminal when `node-pty` is absent.

## Design system

Tailwind CSS 4 with CSS-first config in `globals.css`. OLED-friendly dark
theme, flat (no gradients). UI scaled ~25% via `html { font-size: 125% }`.

### Colors

| Token | Value | Usage |
|-------|-------|-------|
| `bg` | `#000000` | True black for OLED |
| `surface` | `#0a0a0a` | Card/surface background |
| `elevated` | `#131313` | Elevated surfaces |
| `accent` | `oklch(0.62 0.19 256)` | Primary blue accent |
| `danger` | `oklch(0.55 0.20 25)` | Destructive red |
| `success` | `#22c55e` | Success |
| `warning` | `#f59e0b` | Warning |

### Typography

| Token | Size | Usage |
|-------|------|-------|
| `display` | `2rem` | Page titles |
| `h1` | `1.5rem` | Section headers |
| `h2` | `1.125rem` | Subsection headers |
| `body` | `0.875rem` | Body text |
| `caption` | `0.6875rem` | Labels, timestamps |

### Responsive design

| Breakpoint | Width | Behavior |
|------------|-------|----------|
| Mobile | `< 768px` | Single column, collapsible sidebar, touch-optimized |
| Tablet | `768–1023px` | Sidebar auto-collapsed, 2-column grids |
| Desktop | `≥ 1024px` | Full sidebar, multi-column grids |

Container queries for content-aware layouts.

### Light/dark theme

Full light and dark mode support via `ThemeProvider`. OLED-optimized dark
theme as default. Toggle in sidebar footer.

### i18n

Full Czech and English via `lib/i18n/`. Language toggle in sidebar footer.
Every user-facing string in both CS and EN dictionaries.

## PWA

Orca is installable as a PWA with offline-capable push notifications:

- Service worker (`public/sw.js`) with VAPID push handler
- Inline action buttons (Allow, Reject, Approve, Rerun)
- Notification clicks mapped to API calls
- Manifest with `display: standalone`

## UI primitives (`components/ui/`)

Key components: Button, IconButton, Input, Toggle, Segmented, ExecutorPicker,
Modal, ConfirmDialog, Toast, Badge, ModuleHeader, Field, SettingCard, HelpTip,
ActionMenu, ContextMenu, Avatar, Checkbox, states (Loading/Error/Empty),
ModelIcon, ProjectPill, AgentStatusDot, CapacityMeter, ProgressRibbon,
OutcomeBadge, UsageBadge.

### Tone system

All colored components use `Tone`: `'default' | 'accent' | 'muted' | 'danger'
| 'success' | 'warning'`.
