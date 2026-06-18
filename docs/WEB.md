# Web UI

Next.js 16 frontend at `web/`. Built with React 19, Tailwind CSS 4, TanStack React Query, and Xterm.js.

## Pages

### Dashboard `/dash`

Overview screen with:

- **Stat cards** — open tasks, in progress, blocked, live sessions, active missions
- **Status bar** — visual breakdown of task states (proportional colored segments)
- **Tasks table** — recent tasks with status badges
- **Sessions list** — active agent sessions
- **Missions list** — active missions with state badges

Data refreshes on mount and via real-time SSE events (`useOrcaEvents`).

### Tasks `/tasks`

Full task management:

- **Create task form** — title, optional type and priority
- **Task table** — all tasks with ID, title, status badge (color-coded per `statusTone`)
- **Actions per task:**
  - `ExecutorPicker` — launch agent with selected model/executor
  - `Close` button — mark task as closed
- States: loading, error (with retry), empty

### Kanban `/kanban`

Drag-and-drop task board with 5 columns:

| Column | Status |
|---|---|
| Open | `open` |
| In progress | `in_progress` |
| Blocked | `blocked` |
| Closed | `closed` |
| Cancelled | `cancelled` |

- Drag tasks between columns to update status
- Each card shows title, ID, and status badge
- Uses native HTML5 drag-and-drop (`draggable`, `onDrop`)

### Missions `/missions`

Mission lifecycle management:

- **Engage form** — create mission with epic ID, autonomy level (L0–L3), max sessions, cleared guardrails
- **Mission list** — each with ID, autonomy badge, action buttons
- **Actions per mission:**
  - `Detail` — opens modal with `MissionProgressView`
  - `Pause` / `Resume` — toggle mission state
  - `Disengage` — kill all associated sessions and end mission
- **Mission detail modal** — `MissionProgressView` shows:
  - Progress stat cards (total, done, in progress, blocked)
  - Phase-based task visualization (topological layout from DAG)
  - Tasks grouped by phase with status badges

### Sessions `/sessions`

Live agent session management:

- **Session list** — all `orca-*` tmux sessions
- **Actions per session:**
  - `Terminal` — opens modal with live Xterm.js terminal
  - `Send input` — send keystrokes (e.g., approve prompts)
  - `Interrupt` — send Ctrl+C (`["C-c"]`)
  - `Kill` — terminate tmux session
- **Terminal modal** — real-time pane stream via SSE, ANSI color support, auto-fit resize

### Timeline `/timeline`

Visual activity log with two views:

- **Axis view** — horizontal timeline showing last 12 hours of events as dots
  - Dot size scales with event frequency (logarithmic)
  - Hover tooltip shows target, detail, and timestamp
  - Hour gridlines and UTC clock labels
- **Feed view** — chronological event list with icons and badges
- **Filter** — segmented control: All / Tasks / Missions / Signals
- Events are grouped (identical events within 5 min collapse into `×N`)

### Users `/users`

User management (Config group):

- **User table** — list of all users with username, creation date, delete button
- **Add user form** — username + password fields
- **Session section** — logout button (clears token and reloads)
- Cannot delete the last remaining user

### Projects `/projects`

Project registry (Config group):

- **Project cards** — grid of projects with slug and path, clickable to select
- **New project modal** — form with slug, path, optional pilot info
- **Git section** (when project selected) — shows:
  - Current branch with dirty/ahead/behind counts
  - Branch list (current branch highlighted)
  - Recent commits (hash, subject, author, relative time)

### Settings `/settings`

Daemon configuration (Config group):

- **Models** — toggle allowed executors (checkboxes per model preset)
  - Claude Sonnet, DeepSeek v4 Flash, Kimi k2.7 Code, Minimax m2.7, Codex gpt-5.4
- **Autopilot** — decision model settings
  - Model name, API URL, API key (masked input, shows "•••• set" when configured)

---

## Components

### UI primitives

| Component | Purpose |
|---|---|
| `Button` | Primary action button with variant (accent, danger, default) and icon support |
| `IconButton` | Icon-only button (for table actions: delete, edit) |
| `Input` | Text input field |
| `Select` | Dropdown select |
| `Toggle` | Toggle switch |
| `Segmented` | Segmented control / radio group (used on Timeline for filter) |
| `Modal` | Modal dialog with title, close button, backdrop blur |
| `ConfirmDialog` | Confirmation modal with cancel/confirm |
| `Toast` | Toast notification system (icon + message, auto-dismiss) |
| `Panel` | Content panel container |
| `Section` | Section container with title, icon, and optional action slot |
| `StatCard` | Metric display card (label, value, optional hint and tone) |
| `Badge` | Status badge with tone (accent, muted, danger) |
| `Table` | Data table with `THead`, `TR`, `TH`, `TD` subcomponents |
| `PageHeader` | Page title with optional count badge |
| `Field` | Form field wrapper with label |
| `Toolbar` | Action toolbar |
| `SettingCard` | Settings section card |
| `HelpTip` | Question-mark tooltip helper |
| `ActionMenu` | Dropdown action menu |
| `states` | `LoadingState`, `ErrorState` (with retry), `EmptyState` — consistent across all pages |

### Tone system

All colored components use the `Tone` type: `'default' | 'accent' | 'muted' | 'danger'`.

### Shell

| Component | Purpose |
|---|---|
| `Shell` | Root layout: sidebar + main content area + `ToastProvider` + `CommandPalette` |
| `Sidebar` | Resizable, collapsible nav with daemon health dot, module groups, resize handle |
| `NavGroup` | Sidebar section (Operate / Config) |
| `NavItem` | Single nav link with icon |
| `ModuleShell` | Per-page wrapper with sidebar state |
| `CommandPalette` | Cmd+K global search — navigates to pages and creates tasks/missions |

### Terminal

| Component | Purpose |
|---|---|
| `Terminal` | Xterm.js wrapper with SSE stream, auto-fit, ANSI color support |
| `TerminalPanel` | Terminal + controls (close/kill buttons) |
| `TerminalControls` | Session action buttons |
| `frame.ts` | Frame composition for terminal output |

### Control forms

| Component | Purpose |
|---|---|
| `CreateTaskForm` | Task creation form |
| `EngageForm` | Mission engagement form |
| `ExecutorPicker` | Model/executor selector for spawning |
| `SendInput` | Keystroke input for session interaction |
| `LoginForm` | Auth login form |

---

## Design system

Tailwind 4 with CSS-first config in `globals.css`. OLED-friendly dark theme.

### Colors

| Token | Value | Usage |
|---|---|---|
| `bg` | `#000000` | Background (true black for OLED) |
| `surface` | `#0a0a0a` | Card/surface background |
| `elevated` | `#131313` | Elevated surfaces, hover states |
| `border` | `oklch(0.27 0 0)` | Default borders |
| `border-strong` | `oklch(0.38 0.005 256)` | Hover/active borders |
| `accent` | `oklch(0.62 0.19 256)` | Primary accent (blue) |
| `danger` | `oklch(0.55 0.20 25)` | Destructive actions (red) |
| `text` | `oklch(0.97 0 0)` | Primary text |
| `text-muted` | `oklch(0.62 0 0)` | Secondary text |

### Typography

| Token | Size | Usage |
|---|---|---|
| `display` | `2rem` | Page titles |
| `h1` | `1.5rem` | Section headers |
| `h2` | `1.125rem` | Subsection headers |
| `body` | `0.875rem` | Body text |
| `caption` | `0.6875rem` | Labels, timestamps |

### Spacing & shapes

| Token | Value |
|---|---|
| `radius` | `0.5rem` |
| `radius-sm` | `0.375rem` |
| `radius-lg` | `0.75rem` |
| `shadow-card` | `0 1px 2px 0 rgb(0 0 0 / 0.4)` |
| `shadow-raised` | `0 4px 16px -4px rgb(0 0 0 / 0.6)` |

### Animations

| Class | Effect |
|---|---|
| `.animate-fade-up` | Fade in + translate 6px up |
| `.animate-pop-in` | Scale from 0.97 |
| `.skeleton` | Pulsing skeleton loader |
| `.live-dot` | Pulsing ring animation for live indicator |
| `.marquee-track` | Scrolling ticker text |
| `.card-interactive` | Hover: lift 1px + border glow |

All animations respect `prefers-reduced-motion`.

### Focus & accessibility

- Accent-colored focus ring on all interactive elements
- Thin custom scrollbars matching the theme
- Keyboard navigation support (CommandPalette, Segmented, modals)

---

## Auth

The web UI includes an authentication layer:

- **LoginGate** — wraps the entire app, checks for a stored token on mount
- **LoginForm** — centered login screen with Orca logo, username/password fields
- **Token storage** — stored in `localStorage` under `orca.token`
- **EventBridge** — only mounted after auth (prevents 401 on SSE connections)
- **Logout** — revokes token server-side, clears local storage, reloads page
- Token is appended to SSE URLs via `?token=<value>` (EventSource limitation)

Auth is optional — if the daemon has no `UserStore`, the gate renders children directly (assumes no token needed).

## Key patterns

### Real-time updates

Two SSE connections:

1. **Pane stream** (`/sessions/:name/stream`) — per-session terminal content, 1-second poll
2. **Event bus** (`/events`) — global state changes (task/mission/signal events)

The event bus triggers cache invalidation in React Query — no manual refetching needed.

### State handling

Every data-fetching page handles three states consistently:

- **Loading** — `LoadingState` spinner component
- **Error** — `ErrorState` with retry button ("orca daemon unreachable")
- **Empty** — `EmptyState` with contextual message ("No tasks", "No live sessions")

### Terminal component

Uses `@xterm/xterm` with `@xterm/addon-fit`:

- Black background, no cursor blink
- Auto-fits on container resize via `ResizeObserver`
- Deferred first fit to animation frame for correct initial sizing
- Deduplicated frame updates (same frame → no re-render)

### Sidebar

Resizable, collapsible sidebar with:

- Navigation groups: **Operate** (Dashboard, Tasks, Kanban, Sessions, Missions, Timeline) and **Config** (Settings, Users, Projects)
- Daemon health indicator (green/gray dot)
- Collapse toggle button
- Resize handle with drag support
- Auto-collapses on mobile (<768px)

### SessionCard live preview

The `SessionCard` component shows live session output inline:

- **ANSI parsing** — `parseAnsi()` converts terminal escape codes to colored segments (256-color + true color)
- **Signal-aware UI** — shows Allow/Reject buttons when deriver emits `needs_input`
- **Live cursor** — blinking animation (`skel-pulse`) while session is active
- **Flash on update** — brief highlight when new output arrives

### Calendar scheduling

`CalendarView` (`modules/kanban/CalendarView.tsx`) provides drag-and-drop scheduling:

- **3 modes**: day (hourly), week (7-day), month (6-week matrix)
- **Task date resolution**: `scheduled_at` → `closed_at` → `created_at`
- **Drag & drop**: move tasks between days to update `scheduled_at`
- **Utilities**: `dayKey()`, `weekDays()`, `monthMatrix()`, `tasksByDay()` in `calendar.ts`

### Dependency graph

`DependencyGraph` (`modules/missions/DependencyGraph.tsx`) renders mission task dependencies as an SVG diagram:

- **Topological layout**: phases as columns (cycle-safe via visiting guard)
- **Node states**: ready (accent), locked (muted), running (pulse), done (checkmark)
- **SVG edges**: cubic bezier curves, hover highlights connected paths

### Toast system

`Toast` (`components/ui/Toast.tsx`) uses Context/Provider with rAF-based countdown:

- **Smooth progress bar**: `requestAnimationFrame` timer, pauses on hover
- **Tone system**: accent (success) / danger (error)
- **Usage**: `const { toast } = useToast(); toast('Done');`

### Atomic terminal repaint

The `frame.ts` compositor prevents flicker by combining cursor-home + clear + content into one `term.write()` call. The `nextPane()` deduplication prevents React re-renders when the frame content hasn't changed.

## Running

```bash
cd web
npm install
npm run dev        # development server
npm run build      # production build
npm start          # production server
```

Set `NEXT_PUBLIC_ORCA_URL` to point to the daemon (default: `http://localhost:4400`).

## Tests

```bash
npm test           # Vitest
npm run test:watch
```

Uses MSW for API mocking, Testing Library for component tests.
