# Web UI

Next.js 16 (App Router) frontend at `web/`. React 19, Tailwind CSS 4, TanStack React Query, Xterm.js, Monaco editor.

## Routes

Every page is a thin shell in `app/<route>/page.tsx` that renders a `*View` from `modules/` inside a `ModuleShell`. All pages are `'use client'` with `export const dynamic = 'force-dynamic'`.

| Route | Module | View | Nav group |
|-------|--------|------|-----------|
| `/dash` | `dashboard/` | `DashboardView` | Operate |
| `/tasks` | `tasks/` | `TasksView` | Operate |
| `/kanban` | `kanban/` | `KanbanBoard` + `CalendarView` | Operate |
| `/sessions` | `sessions/` | `SessionsView` | Operate |
| `/missions` | `missions/` | `MissionsView` | Operate |
| `/timeline` | `timeline/` | `TimelineView` | Operate |
| `/projects` | `projects/` | `ProjectsView` | Operate |
| `/settings` | — | inline (in `app/settings/page.tsx`) | Config |
| `/users` | `users/` | `UsersView` | Config |
| `/account` | `account/` | `AccountView` | — (sidebar footer) |
| `/onboarding` | — | inline (in `app/onboarding/page.tsx`) | — (first-run) |

Module metadata (id, label, route, icon, group) is defined in each `modules/<name>/meta.ts` and registered in `modules/registry.ts` for sidebar and routing.

### Dashboard `/dash`

`DashboardView` (`modules/dashboard/DashboardView.tsx`):

- **Needs input banner** — `NeedsInputBanner` at top if any agent is waiting
- **Now section** — metric cards: open tasks, in progress, blocked, live sessions, active missions
- **Live agent lanes** — up to 6 active `orca-*` sessions with `AgentStatusDot`, `ModelIcon`, live tail snippet, activity badge
- **Quick actions** — New task, New mission links
- **Recent tasks** — last 6 non-epic tasks with status badges
- **Active missions** — list with done/total count, live session indicators, `CapacityMeter`
- **Autopilot spotlight** — every active mission: current phase, `ProgressRibbon`, pause/resume/disengage controls
- **Recent outcomes** — last 6 closed tasks with `OutcomeBadge` and result summary

Data refreshes via `useTasks` (poll 5 s), `useSessions` (poll 5 s), `useMissions`, and real-time SSE events (`useOrcaEvents`).

### Tasks `/tasks`

`TasksView` (`modules/tasks/TasksView.tsx`):

- **ModuleHeader** — title, search input, segmented filter (Active / Open / Blocked / Closed / Autopilot / All), New task button
- **Day-grouped task list** — cards grouped by today/yesterday/date, paginated (12 per page)
- **TaskCard** — shows type icon, title, status badge, dependency blockers, checkbox for bulk select
- **EpicGroup** — expands to show child phases with `ProgressRibbon`, phase spotlight, `NeedsInputBanner` on fail gate
- **Filters** — search by text/id, status filter, persistent in `localStorage`
- **Bulk actions** — bottom bar with close/delete for selected tasks
- **TaskDetailPane** — right-side detail drawer: description, phases, dependencies, executor, result summary + `OutcomeBadge`, launch/edit/close actions
- **TaskModal** — create/edit modal: title, details, type, priority, executor, schedule, autostart, dependencies
- **PlanModal** — `Autopilot · Planning` mode: goal input, autonomy (L0–L3), max sessions, manual phase list, create & engage

Supports deep-links: `?new=1` opens create modal, `?select=<id>` opens detail pane for that task.

### Kanban `/kanban`

`KanbanBoard` (`modules/kanban/KanbanBoard.tsx`) + `CalendarView` (`modules/kanban/CalendarView.tsx`):

- **Board view** — 5 columns (Open / In progress / Blocked / Closed / Cancelled) with drag-and-drop via native HTML5
- **KanbanCard** — shows title, ID, type icon, status badge, dependent blockers count
- **KanbanEpicCard** — epic card with `ProgressRibbon` and phase expansion; phases shown as nested cards
- **Calendar view** — 3 modes: day (hourly), week (7-day), month (6-week matrix)
- **Drag & drop in calendar** — move tasks between days to update `scheduled_at`
- **Utilities** — `dayKey()`, `weekDays()`, `monthMatrix()`, `tasksByDay()` in `calendar.ts`

### Sessions `/sessions`

`SessionsView` (`modules/sessions/SessionsView.tsx`):

- **Filter** — All / Needs input (persistent via URL param `?filter=needs_input`)
- **Density toggle** — Comfortable / Compact (persistent in `localStorage`)
- **Session cards** — grid of `SessionCard` components with `AgentStatusDot`, `ModelIcon`, live tail preview, ANSI-parsed output
- **Signal-aware UI** — shows Allow/Reject buttons when deriver emits `needs_input`
- **TerminalModal** — opens full Xterm.js terminal for a session
- **Empty states** — contextual with "Go to Tasks" action

### Missions `/missions`

`MissionsView` (`modules/missions/MissionsView.tsx`):

- **ActiveMissionsBar** — horizontal card strip of all missions (active → paused → disengaged), each with `ProgressRibbon`, `CapacityMeter`, live/needs count
- **Mission workspace** (selected mission):
  - Header with autonomy badge, state badge, capacity meter, Add phase button
  - Config summary line (planner + overseer + default autonomy)
  - Metric strip (total, done, in progress, blocked)
  - **Phase spotlight** — current phase (with `AgentStatusDot`, agent name) → arrow → next phase; pause/resume/disengage
  - **Upstream fail banner** — warning when a failed dependency blocks downstream
  - **NeedsInputBanner** — scoped to this mission's sessions
  - **TaskFlow** — topological phase layout (replaces old DependencyGraph), SVG edges with cubic bezier curves
  - **TaskDetailPane** — selected phase details
- **EngageModal** — epic selector, autonomy (L0–L3), max sessions, cleared guardrails
- **AddPhaseModal** — insert phases into existing epic: manual list or LLM replan with residual goal

Supports deep-link `?new=1`.

### Timeline `/timeline`

`TimelineView` (`modules/timeline/TimelineView.tsx`):

- **Axis view** — horizontal dot plot of events over the last 1h–1wk window
  - Dot size scales logarithmically with event frequency
  - Hover tooltip shows target, detail, and UTC time
  - Hour gridlines with UTC clock labels
  - "Now" edge with live pulse
- **Swimlanes view** — one horizontal track per target (agent/session/task), busiest-recent first
- **Feed view** — collapsible per-target event groups
  - `FeedGroup` — icon, title/exec, latest status badge, expandable event list with detail badges
  - `LiveFeedGroup` — real-time variant for running sessions: live tail pane with ANSI coloring
  - Autopilot chip on mission/task events
  - Cross-links to Tasks/Sessions/Missions
- **Filter** — All / Tasks / Missions / Signals (persistent in `localStorage`)
- Events within 5 min of same type/detail/target collapse into `×N` groups

### Projects `/projects`

`ProjectsView` (`modules/projects/ProjectsView.tsx`):

- **Project cards** — grid with slug, path, git status (branch, clean/dirty, ahead/behind), clickable to select
- **New project modal** — slug, path, pilot info notes
- **Edit project modal** — path and notes (slug is immutable)
- **Git section** — branches (current highlighted), recent commits with hash/subject/author/relative time
- **Open editor** — launches the Monaco code editor

#### Project Editor (`modules/projects/editor/`)

Self-hosted Monaco editor (`@monaco-editor/react`) with:

| Component | Purpose |
|-----------|---------|
| `ProjectEditor.tsx` | Root: file tree + tabs + editor split |
| `FileTree.tsx` | File tree (changed files highlighted blue, folder icons, context menu) |
| `Tabs.tsx` | Multi-file tab bar with dirty-state indicator |
| `EditorPane.tsx` | Monaco editor with `oledTheme`, word wrap, fullscreen |
| `DiffEditorPane.tsx` | Monaco diff editor for working changes vs HEAD |
| `PatchView.tsx` | Unified diff view for git commits |
| `ImagePreview.tsx` | Image preview for binary files |
| `MarkdownPreview.tsx` | Rendered markdown preview |
| `ContextMenu.tsx` | Right-click context menu for file tree |
| `dialogs.tsx` | Modal dialogs for new file/folder, rename, duplicate, delete |
| `monacoLoader.ts` | Monaco loader configuration |
| `oledTheme.ts` | OLED-friendly Monaco theme (dark, high contrast) |

- **File operations** — new file, new folder, rename, duplicate, delete, copy path
- **Git integration** — per-file working diff, commit diff view, changed files list, working changes diff
- **Tabs** — multi-file editing with dirty tracking, save via `PUT /projects/:id/file`
- **Raw file access** — authenticated URLs via `projectRawUrl()` for image previews

### Settings `/settings`

Admin-only (non-admins see a lock screen with link to My Account). Inline in `app/settings/page.tsx`:

- **Models** — grid of executor presets + custom models with toggle switches, edit/delete, add modal
  - `ModelModal` — add/edit model: label, provider (Claude Code / OpenCode / Codex / Other), model ID
  - Presets: Claude Sonnet, DeepSeek v4 Flash, Kimi k2.7 Code, Minimax m2.7, Codex gpt-5.4
  - **Auto-save** — model toggles, adds, edits, and deletes persist immediately via `PUT /config` on every change (no separate save button). Other sections (autopilot, providers, defaults) have explicit save buttons.
- **Autopilot** — backend mode toggle (Relay / CLI Agents):
  - Relay: planner model, overseer model, API URL, API key
  - CLI Agents: pilot exec, overseer exec, review on done
  - Notes, planner prompt template with `{{goal}}` placeholder
  - Test plan button — submits dry-run, polls async plan job, shows preview
- **Providers** — per-program binary paths and extra CLI args (Claude Code, OpenCode, Codex)
- **Defaults** — default executor, autonomy level, max sessions
- **Hermes** — one-click plugin install for same-host Hermes integration
  - Hermes home, orca URL and token, plugin status indicator

### Users `/users`

`UsersView` (`modules/users/UsersView.tsx`):

- **User list** — cards with avatar, username, admin badge, created date
- **Admin actions** (admin-only):
  - Toggle admin role
  - **Project assignment** — chip toggles assigning user to projects (access boundary)
  - **Model allow-list** — chip toggles per-user model restrictions
- **Add user modal** — username + password
- **Logout** — revokes token server-side, clears `localStorage`, reloads page

### Account `/account`

`AccountView` (`modules/account/AccountView.tsx`):

- **Default model selector** — radiogroup of allowed models with `ModelIcon`
- **Profile** — avatar (upload), name, email
- **Admin badge** shown when user is admin

### Onboarding `/onboarding`

First-run wizard (`app/onboarding/page.tsx`). Redirected from `/` when `freshInstall.noConfigPersisted`:

- **System dependencies** — CLI agent detection (claude, opencode, codex) and system tools (node, tmux, git)
- **Provider binaries** — binary paths and extra args per provider
- **Autopilot backend** — Relay (API key + URL) or CLI Agents (pilot/overseer exec picker)
- **Users** — user list and create-first-user form
- **Hermes** — optional orca plugin install

Root `/` checks `cli-status` and redirects to `/onboarding` (fresh install) or `/dash`.

## Data layer

All server communication goes through `lib/orcaClient.ts` (HTTP wrapper with Bearer token), consumed via TanStack React Query hooks.

### orcaClient (`lib/orcaClient.ts`)

Thin fetch wrapper around the daemon API. Sets `Authorization: Bearer <token>` from `localStorage`. On 401, clears token and throws `OrcaApiError`.

### Queries (`lib/queries.ts`)

| Hook | Key | Polling |
|------|-----|---------|
| `useTasks` | `['tasks']` | 5 s |
| `useSessions` | `['sessions']` | 5 s (selects names only) |
| `useSessionInfos` | `['sessions']` | 5 s (full session info with daemon-classified identity) |
| `useMissions` | `['missions']` | — |
| `useHealth` | `['health']` | 10 s |
| `useConfig` | `['config']` | — |
| `useMe` | `['me']` | 5 min stale |
| `useUsers` | `['users']` | — |
| `useActivity` | `['activity', type]` | 5 s |
| `useProjects` | `['projects']` | — |
| `useProjectGit` | `['project-git', id]` | — |
| `useProjectFiles` | `['project-files', id]` | — |
| `useProjectFile` | `['project-file', id, path]` | — |
| `useProjectFileAtHead` | `['project-head', id, path]` | — |
| `useProjectCommit` | `['project-commit', id, hash]` | — |
| `useProjectCommitFileDiff` | `['project-commit-file', id, hash, path]` | — |
| `useProjectChanged` | `['project-changed', id]` | — |
| `useProjectChanges` | `['project-changes', id]` | — (enabled flag) |
| `useMissionDetail` | `['mission', id]` | — |
| `useAllDeps` | `['tasks', 'deps']` | — |
| `useTaskUsage` | `['task-usage', taskId]` | 5 s (live), 5 min stale (finished) |
| `useSessionSignals` | `['session-signals']` | SSE-populated |
| `useHermesStatus` | `['hermes-status']` | — |
| `useCliStatus` | `['cli-status']` | 30 s |
| `usePlanJob` | `['plan-job', jobId]` | 1 s while planning |
| `useUserProjects` | `['user-projects', userId]` | — |

### Mutations (`lib/mutations.ts`)

Mutations auto-invalidate related query caches on success:

| Hook | Invalidates |
|------|-------------|
| `useSpawn` | tasks, sessions |
| `useCreateTask` | tasks |
| `useUpdateTask` | tasks |
| `useDeleteTask` | tasks |
| `usePlanTask` | tasks, missions |
| `useInsertPhases` | tasks, mission detail (epicId), missions |
| `useCloseTask` | tasks |
| `useSetTaskStatus` | tasks |
| `useSetTaskExec` | tasks |
| `useKillSession` | sessions |
| `useSendInput` | — (sends keystrokes to session) |
| `useEngage` / `usePauseMission` / `useResumeMission` / `useDisengage` | missions |
| `useDeleteMission` | tasks, missions, mission detail |
| `useCleanupAll` | all |
| `useUpdateConfig` | config |
| `useLogin` / `useLogout` | — |
| `useCreateUser` / `useDeleteUser` / `useUpdateUser` | users, me |
| `useUpdateMe` / `useUploadAvatar` | me |
| `useCreateProject` / `useUpdateProject` / `useRemoveProject` | projects |
| `useAssignProject` | user-projects |
| `useWriteProjectFile` | project-file, project-git |
| `useNewProjectFile` / `useNewProjectDir` / `useRenameProjectEntry` / `useCopyProjectEntry` / `useDeleteProjectEntry` | project-files, project-git, project-changed |
| `useHermesInstall` | hermes-status |

### Real-time updates

Two SSE connections:

1. **Event bus** (`/events`) — global state changes via `useOrcaEvents`:
   - `task` events → invalidate tasks, mission detail, activity
   - `mission` events → invalidate missions, mission detail, activity
   - `signal` events → update `sessionSignals` cache (derived signals per agent), invalidate sessions, activity
   - `plan` events → update `plan-job` cache (async plan resolution), invalidate tasks/missions when done

2. **Pane stream** (`/sessions/:name/stream`) — per-session terminal content for the Xterm.js component (1-second poll via `useSessionStream`)

### State handling

Every data-fetching page handles three states consistently:
- **Loading** — `LoadingState` spinner/cards
- **Error** — `ErrorState` with retry button ("orca daemon unreachable")
- **Empty** — `EmptyState` with contextual message and optional action

## Auth

- **LoginGate** (`components/auth/LoginGate.tsx`) — wraps the entire app, checks for a stored token on mount. If the daemon has no `UserStore`, renders children directly.
- **LoginForm** — centered login with Orca logo, username/password
- **Token** — stored in `localStorage` under `orca.token`; SSE appends via `?token=<value>` (EventSource limitation)
- **EventBridge** — only mounted after auth (prevents 401 on SSE). Exported from `providers.tsx`
- **Logout** — revokes server-side, clears `localStorage`, reloads page
- **Token helper** — `getToken()`, `setToken()`, `clearToken()`, `withToken()` in `lib/token.ts`

### Role-based access

When the daemon has a `UserStore` (multi-user mode):
- **Admin** (`is_admin`) — sees and manages everything
- **Non-admin** — only sees projects they're assigned to (via `user_projects`)
- **Assignment management** — admin-only, in Users page via `ProjectChips`
- **Model allow-list** — admin can restrict which models a non-admin may run

## Internationalization

Full Czech and English support via `lib/i18n/`:

- **Dictionaries** — `cs.ts` and `en.ts` in `dictionaries/`, keyed by namespace (`nav`, `tasks`, `missions`, `sessions`, `settings`, `projects`, `users`, `account`, `onboarding`, `dashboard`, `timeline`, `kanban`, `calendar`, `sidebar`, `agent`, `usage`, `changes`, `activity`)
- **LanguageProvider** — React context wrapping the app, persisted to `localStorage` under `orca-locale`
- **useTranslation hook** — returns `{ t, locale, setLocale }`
- **Locale type** — `'en' | 'cs'`
- Language toggle in sidebar footer; `document.documentElement.lang` synced

## Design system

Tailwind CSS 4 with CSS-first config in `globals.css`. OLED-friendly dark theme, flat (no gradients / no glows). The whole UI is scaled ~25% via `html { font-size: 125% }`.

### Colors

| Token | Value | Usage |
|-------|-------|-------|
| `bg` | `#000000` | True black for OLED |
| `surface` | `#0a0a0a` | Card/surface background |
| `elevated` | `#131313` | Elevated surfaces, hover states |
| `border` | `oklch(0.27 0 0)` | Default borders |
| `border-strong` | `oklch(0.38 0.005 256)` | Hover/active borders |
| `accent` | `oklch(0.62 0.19 256)` | Primary accent (blue) |
| `danger` | `oklch(0.55 0.20 25)` | Destructive actions (red) |
| `text` | `oklch(0.97 0 0)` | Primary text |
| `text-muted` | `oklch(0.62 0 0)` | Secondary text |
| `success` | `#22c55e` | Success states |
| `warning` | `#f59e0b` | Warning states |
| `info` | `#3b82f6` | Information |
| `approve` | `#10b981` | Approval actions |
| `cancelled` | `#6b7280` | Cancelled state |

### Typography

| Token | Size | Usage |
|-------|------|-------|
| `display` | `2rem` | Page titles |
| `h1` | `1.5rem` | Section headers |
| `h2` | `1.125rem` | Subsection headers |
| `body` | `0.875rem` | Body text |
| `caption` | `0.6875rem` | Labels, timestamps |

### Spacing & shapes

| Token | Value |
|-------|-------|
| `radius` | `0.5rem` |
| `radius-sm` | `0.375rem` |
| `radius-lg` | `0.75rem` |
| `shadow-card` | `0 1px 2px 0 rgb(0 0 0 / 0.4)` |
| `shadow-raised` | `0 4px 16px -4px rgb(0 0 0 / 0.6)` |

### Motion

| Class | Effect |
|-------|--------|
| `animate-fade-up` | Fade in + translate 6px up (260 ms) |
| `animate-pop-in` | Scale from 0.97 (180 ms) |
| `animate-route` | Opacity-only route transition (200 ms) — no transform to avoid containing-block issues |
| `animate-draw` | SVG path draw-in animation |
| `skeleton` | Pulsing skeleton loader |
| `live-dot` | Pulsing ring for live indicators |
| `tail-live` | Session tail flash on new output |
| `card-interactive` | Hover: lift 1px + border lighten + shadow raise |

All animations respect `prefers-reduced-motion`.

### Focus & accessibility

- Accent-colored 2-tone focus ring (outer + inset) on all interactive elements via `:focus-visible`
- Thin custom scrollbars (`scrollbar-width: thin`)
- `overscroll-behavior: none` on body for iOS stability
- `no-scrollbar` utility class for horizontal scroll rows
- Keyboard navigation: CommandPalette (Ctrl+K), Segmented, modals

## Components

### UI primitives (`components/ui/`)

| Component | Purpose |
|-----------|---------|
| `Button` | Primary action with variant (accent, danger, default, ghost) and icon support |
| `IconButton` | Icon-only button for actions |
| `Input` | Text input field |
| `Select` | Dropdown select |
| `Toggle` | Toggle switch |
| `Segmented` | Segmented control / radio group |
| `Modal` | Modal dialog with title, close, backdrop, sizes (sm/md/lg/full) |
| `ConfirmDialog` | Confirmation modal with cancel/confirm |
| `Toast` | Toast notification (icon + message, auto-dismiss, rAF-based progress bar, hover pause) |
| `Section` | Section container with title, icon, optional action |
| `Badge` | Status badge with tone (`default` / `accent` / `muted` / `danger` / `success` / `warning`) |
| `ModuleHeader` | Sticky, compact page toolbar with title, icon, optional actions |
| `Field` | Form field wrapper with label and optional hint |
| `SettingCard` | Settings section card |
| `HelpTip` | Question-mark tooltip helper |
| `ActionMenu` | Dropdown action menu with icon and tone support |
| `Avatar` | User avatar with fallback initial |
| `Checkbox` | Checkbox input |
| `states` | `LoadingState`, `ErrorState` (with retry), `EmptyState` |
| `ModelIcon` | Brand icon for a model, resolved from exec string via lobe-icons SVG set (`public/models/`) |
| `ProjectPill` | Small muted pill showing project/repo slug (hidden in single-project workspaces by default) |
| `AgentIdentityStrip` | Agent name, model, task ID in a compact strip |
| `AgentStatusDot` | Colored live-dot with signal-aware state (working, needs_input, idle, stalled, stuck) |
| `CapacityMeter` | `{running}/{max}` session usage bar |
| `ChangeStrip` | Git dirty count + last commit info |
| `NeedsInputBanner` | Alert banner when agents need human approval |
| `NeedsInputRow` | Compact row for a needs-input agent with inline Allow/Reject |
| `NotificationBell` | Sidebar bell with dropdown of agents awaiting input, portalled to body |
| `OutcomeBadge` | Compact ok/fail badge on closed tasks |
| `ProgressRibbon` | Segmented colored bar for phase-level progress |
| `TaskContextLine` | Executor + agent summary for a task |
| `TaskUsageBadge` | Token/cost display for a task's agent run |
| `UsageBadge` | Token/cost badge with IN / CACHE / OUT pills, hover breakdown with prices |

### Tone system

All colored components use `Tone` type: `'default' | 'accent' | 'muted' | 'danger' | 'success' | 'warning'` (`components/ui/tone.ts`).

Status-to-tone mapping for task statuses in `modules/dashboard/statusTone.ts`:
- `open` → `success`, `in_progress` → `accent`, `blocked` → `warning`, `closed` → `muted`, `cancelled` → `muted`

### Shell (`components/shell/`)

| Component | Purpose |
|-----------|---------|
| `Shell` | Root layout: sidebar + main content + `ToastProvider` + `LanguageProvider` + `CommandPalette` |
| `Sidebar` | Resizable, collapsible nav with daemon health dot, module groups, resize handle, auto-collapse ≤768px |
| `NavGroup` | Sidebar section (Operate / Configuration) |
| `NavItem` | Single nav link with icon |
| `ModuleShell` | Per-page wrapper with route transition animation |
| `CommandPalette` | Ctrl+K global command search — navigate pages, create tasks/missions |
| `OpsStatusBar` | Compact strip in sidebar footer: live agent count, needs-attention count, last outcome summary |

### Terminal (`components/terminal/`)

| Component | Purpose |
|-----------|---------|
| `Terminal` | Xterm.js wrapper with `@xterm/addon-fit`, SSE stream, ANSI color, auto-resize |
| `TerminalPanel` | Terminal + controls (close/kill) |
| `TerminalModal` | Modal wrapping Terminal with session actions |
| `TerminalControls` | Session action buttons (Interrupt, Kill) |
| `LiveTail` | Inline live tail (for dashboard session lanes) |
| `frame.ts` | Frame compositor: cursor-home + clear + content in one `term.write()`, deduplication via `nextPane()` |

### Control forms (`components/control/`)

| Component | Purpose |
|-----------|---------|
| `SendInput` | Keystroke input for session interaction |

### Auth (`components/auth/`)

| Component | Purpose |
|-----------|---------|
| `LoginGate` | Root auth guard — checks token, shows LoginForm or children |
| `LoginForm` | Centered login form |

## Key patterns

### Executor/model resolution

`lib/modelProvider.ts` mirrors the daemon's `resolveExecutor`:
- `codex:<model>` → program `codex`
- `opencode:<model>` → program `opencode`
- `claude:<model>` → program `claude-code`
- contains `/` → `opencode`
- bare (e.g. `sonnet`) → `claude-code`

`lib/execPresets.ts` defines presets: Claude Sonnet, DeepSeek v4 Flash, Kimi k2.7 Code, Minimax m2.7, Codex gpt-5.4. Custom models override presets by matching exec.

### Model icons

`ModelIcon` (`components/ui/ModelIcon.tsx`) resolves a model name/exec string to a brand icon from lobe-icons SVG set (`web/public/models/` via `lib/modelIcon.ts`). Color variants preferred; mono variants inverted for OLED. Falls back to `Cpu` lucide icon.

### Real-time session tail

`useSessionStream` (`lib/useSessionStream.ts`) polls `/sessions/:name/pane` every second, returning the captured pane text. `useSessionPane` wraps it with deduplication and tail length limit.

### Session stall detection

`useSessionStall` (`lib/useSessionStall.ts`) tracks agent silence — after configurable thresholds, reports `stalled` / `stuck` states surfaced via `AgentStatusDot`.

### Task tree utilities

`lib/taskTree.ts` provides `epicChildren()`, `phaseIds()`, `epicLive()`, `epicEffectiveStatus()`, `epicCapacity()` for mission/epic phase management.

### Agent utilities

`lib/agentUtils.ts` provides `taskSessionName()`, `taskAgentName()`, `taskExec()`, `taskBlockers()`, `needsInputSessions()`, `tailSnippet()`, `taskForSession()`.

### Task type metadata

`modules/tasks/taskMeta.ts` maps task types (task, bug, feature, epic, chore) to their icons and labels.

### Session live preview

`SessionCard` (`modules/sessions/SessionCard.tsx`) shows live session output inline:
- `parseAnsi()` — converts terminal escape codes to colored segments
- Signal-aware UI — Allow/Reject buttons when `needs_input`
- Live cursor animation (`skel-pulse`)
- Flash on update (`tail-live`)

### Toast system

Toast uses Context/Provider with `requestAnimationFrame`-based countdown:
- Smooth progress bar that pauses on hover
- Tone system: accent (success), danger (error)
- Usage: `const { toast } = useToast(); toast('Done');`

### Event deduplication

`TimelineView` groups identical events within 5 minutes into `×N` entries via `groupEvents()` in `modules/timeline/axis.ts`.

### Provider metadata

`modules/settings/providers.tsx` defines the three provider backends (Claude Code, OpenCode, Codex) with their ids, labels, colors, binary hints, args hints, and brand icons.

## Build & run

```bash
cd web
npm install
npm run dev          # Next.js dev server (turbopack)
npm run build        # production build (next build)
npm start             # production server (next start -p 4500)
npm test              # Vitest (~270 cases, RTL + MSW)
npm run test:watch    # watch mode
```

Set `NEXT_PUBLIC_ORCA_URL` to the daemon URL (default: `http://localhost:4400`).

**Gotcha:** a stale turbopack dev server on :4500 serves broken CSS chunks. Fix by killing the :4500 pid and running `next start` (not `next dev`).

### Test setup

Tests in `web/tests/` (~270 cases) use:
- **Vitest** — test runner
- **MSW** — API mocking
- **Testing Library** — component rendering and interaction
