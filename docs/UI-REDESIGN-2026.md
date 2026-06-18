# UI Redesign 2026 — Reimagining Orca's Layout & Information Architecture

> **Scope:** LAYOUT and INFORMATION ARCHITECTURE only. The OLED-black,
> gradient-free, Vercel-clean aesthetic and existing design tokens
> (`--color-*`, `--shadow-*`, `--motion-*`, `--ease-*`, radii) are
> **frozen**. This document does not repaint — it re-spaces, re-groups,
> and re-prioritizes.
>
> **Companion:** `docs/DESIGN-PROPOSALS.md` handled *micro-polish* (card
> hover, staggered fades, skeleton variants, focus rings, toast bars).
> This document is the *macro* counterpart — it reimagines where things
> live and how the eye flows. The two are complementary and do not
> overlap.
>
> **Deliverable:** proposals only. No code changes. Prioritized P0/P1/P2.

## Diagnosis — why it reads as a "table orchestrator"

Walking every page (`dash`, `tasks`, `kanban`, `missions`, `sessions`,
`timeline`, `settings`, `projects`, `users`), a single structural pattern
dominates:

```
┌─ Sidebar ─┬──────────── Main (scroll) ─────────────┐
│ logo      │ PageHeader (title + count)             │
│ nav       │ ┌─ Section ──────────────────────────┐ │
│ nav       │ │ header: icon · title · actions     │ │
│ nav       │ │ ────────────────────────────────── │ │
│ nav       │ │   grid/table/cards (homogeneous)    │ │
│ nav       │ └────────────────────────────────────┘ │
│ nav       │ ┌─ Section ──────────────────────────┐ │
│ ...       │ │   ...same shape...                 │ │
└───────────┴────────────────────────────────────────┘
```

Every page is `PageHeader` + N stacked `Section`s of equal visual weight,
each containing one homogeneous grid/table. The eye has **no focal
point** — there is no "hero" surface, no peripheral context lane, no
density contrast. The product reads as a stack of equally-loud
spreadsheet panels. That is the "table orchestrator" feeling.

Specific symptoms:

1. **Flat hierarchy.** Dashboard, Tasks, Missions, Sessions all use the
   identical `Section` container with the same header chrome. Nothing
   signals "this is the primary workspace, this is context."
2. **No spatial narrative.** Status, activity, and the live work happen
   in the same vertically-scrolling column as everything else — the
   "now" has no dedicated surface.
3. **Sidebar is underused.** It is a nav rail with a daemon dot. In a
   2026 agent-orchestration product, the sidebar is prime real estate
   for *ambient* context: live sessions, the next ready task, the
   current mission pulse — things you want visible on every page.
4. **Tables everywhere.** Dashboard tasks = table. Dashboard missions =
   table. Users = table. Timeline feed = list of cards. The kanban is
   the only layout that breaks the mold, and it is the most "alive"
   page — which is a tell.
5. **Modals carry depth that pages don't.** `MissionProgressView` (the
   dependency DAG) and the terminal modal are the richest surfaces in
   the product, and both are trapped behind a click. The canvas-style
   work never becomes the page itself.
6. **Settings is tab buttons + stacked Section.** Four giant tab
   buttons, then one section. The category switcher and the content
   have no spatial relationship.

## North-star principles (the 2026 feel, in priority order)

1. **Focal workspace vs peripheral context.** Every page has *one*
   dominant surface (the workspace) and optional peripheral lanes
   (context, queue, activity). The workspace is where the user
   *acts*; the periphery is where the system *informs*.
2. **Density rhythm.** Not all cards are equal. Hero surfaces are
   larger and more detailed; queue/rail items are compressed. Contrast
   in density creates hierarchy without color.
3. **The sidebar is an instrument, not a menu.** It carries nav, but
   also ambient state: daemon pulse, live session count, the next
   ready task, and quick actions. Collapsed = icon rail + pulse;
   expanded = a thin contextual column.
4. **Canvas over table where the data is relational.** Missions, task
   dependencies, and timeline are graphs/lanes — render them as
   canvases, not lists. Reserve tables for genuinely tabular data
   (users, git commits).
5. **Command-centricity.** ⌘K is the front door. Pages should assume
   the user may never touch the sidebar — every primary action is
   one ⌘K away and every surface is keyboard-navigable.
6. **One signature "hero" surface per page.** A larger, more
   breathing card (still OLED, still flat, still `--shadow-card`) that
   anchors the page and holds the most decision-relevant content.
7. **Preserve the tokens.** `#000` bg, `rounded-lg`, `--shadow-card`
   /`--shadow-raised`, accent blue, no gradients, no glows. Modernity
   comes from *structure and rhythm*, not from paint.

---

## P0 — Structural shifts (high leverage, mostly layout refactor)

These are the changes that most directly kill the "table orchestrator"
read. Each is page-scoped and independently shippable.

### P0.1 — Three-zone page skeleton (workspace · context · rail)

**What changes:** Replace the universal `PageHeader + stacked Section`
skeleton with a three-zone layout used by the *operational* pages
(dashboard, tasks, sessions, missions). Config pages (settings, users,
projects) keep a simpler two-zone variant (see P0.6).

```
┌─ Sidebar ─┬──────────────── Main ──────────────────┬─ Context rail ─┐
│ logo      │ Module header (compact, sticky)        │ (collapsible)  │
│ nav       │ ┌─ HERO surface ────────────────────┐  │ · live pulse   │
│ nav       │ │ the primary "now" of this page    │  │ · next ready   │
│ nav       │ │ (bigger, more breathing room)     │  │ · needs-input  │
│ nav       │ └───────────────────────────────────┘  │ · mini activity│
│ ambient   │ ┌─ WORKSPACE ───────────────────────┐  │                │
│ state     │ │ the action surface                │  │                │
│ (P0.2)    │ │ (table OR canvas OR board)        │  │                │
│           │ └───────────────────────────────────┘  │                │
└───────────┴────────────────────────────────────────┴────────────────┘
```

- **HERO** = the one thing this page is about, given room. On dashboard
  it is the "now" pulse (live sessions + active missions). On tasks it
  is the active-work queue. On sessions it is the live grid. On
  missions it is the engaged-mission panel.
- **WORKSPACE** = the secondary action surface (full list, board,
  graph). Same density as today.
- **Context rail** = a 280–320px right-side column that consolidates
  the periphery: daemon pulse, next ready task, needs-input sessions,
  mini activity. Collapsible; hidden on `<lg`. This is where the
  ActivityTicker and the "view all" snippets migrate to.

**Why it feels modern:** Hierarchy. The hero gets the eye first, the
workspace holds the work, the rail holds ambient awareness. This is the
Linear / Vercel / Raycast pattern: one focal surface, dense periphery.

**Wireframe (dashboard, desktop ≥lg):**
```
┌─────┬────────────────────────────────────┬──────────────┐
│ ◉   │ DASHBOARD              12 open · 3 │ ▸ LIVE (3)   │
│ ▢   ├────────────────────────────────────┤ │ orca-atlas  │
│ ▣   │ ╔════════════════ HERO ═══════════╗│ │ ▸ needs input│
│ ▦   │ ║ 3 running · 1 needs input       ║│ │ orca-nimbus ││
│ ⚙   │ ║ [mini lanes of live sessions]   ║│ │ tail: …     ││
│     │ ╚═════════════════════════════════╝│ │            ││
│ ▸n  │ ┌─ TASKS (recent) ──────┐ ┌─ MIS ┐ │ │ NEXT READY  │ │
│ ready│ │ compact list          │ │ mini │ │ │ task-a1     │ │
│ ▸n  │ │                       │ │ list │ │ │ task-b7     │ │
│ live│ └───────────────────────┘ └──────┘ │ │ ACTIVITY    │ │
│     │                                    │ │ · 12:05 …   │ │
│     │                                    │ │ · 12:02 …   │ │
└─────┴────────────────────────────────────┴──────────────┘
```

On `<lg` the rail folds into a collapsible drawer (hamburger in the
module header). On `md` the rail docks below the hero.

**Tokens reused:** no new colors. The hero uses `bg-surface` +
`border-border` + `--shadow-card`, just with more padding (`p-6` vs
`p-5`), a larger min-height (`min-h-[12rem]`), and a subtle top accent
hairline (`border-t-2 border-accent/40`) — still flat, still OLED.

---

### P0.2 — Sidebar becomes an ambient instrument

**What changes:** The sidebar keeps nav but gains an **ambient state
panel** above the daemon dot, and the daemon dot grows into a compact
status block. When expanded, the bottom block shows:

```
┌──────────────────────┐
│ ◉ ready   3 live     │  ← daemon pulse + live session count
│ next: task-a1        │  ← the single next ready task (click → /tasks)
│ ▸ orca-atlas  needs  │  ← needs-input session (amber dot)
└──────────────────────┘
```

Collapsed (icon rail, 56px) it reduces to: daemon dot + a tiny amber
dot if any session needs input + a count badge on the sessions icon.

**Why it feels modern:** The sidebar stops being a dead nav list. It
becomes the always-on ambient display for an *agent orchestration*
product — which is exactly what users want visible on every page. This
is the single highest-leverage change for the "real product" feel.

**Data:** already available — `useHealth()`, `useTasks()` (ready filter
already exists via `/tasks/ready`), `useSessions()` + signals. No new
API.

**Tokens:** reuse `live-dot`, the `#10b981`/`#f59e0b`/`#ef4444` inline
colors already in `Sidebar.tsx:12-16`. No new colors.

---

### P0.3 — Dashboard: hero = "now", not stat row

**What changes:** The five flat `StatCard`s and the marquee
`ActivityTicker` collapse into a single **hero "Now" surface** at the
top of the dashboard, with the stat numbers integrated as a compact
metric strip *inside* the hero (not as five peer cards). The
ActivityTicker's content migrates partly to the hero (live sessions
mini-lanes) and partly to the context rail (P0.1).

```
┌═════════════════════════ NOW ═══════════════════════════╗
║ ◉ 3 running   ▲ 1 needs input   ◇ 2 missions engaged    ║  ← metric strip
║ ─────────────────────────────────────────────────────── ║
║  swim-lane  orca-atlas   ████░░░░  · tail preview        ║  ← mini live lane
║  swim-lane  orca-nimbus  ░░░░░░░░  · awaiting input       ║
║  swim-lane  orca-rho     ████████  · 12m                  ║
║                                                         ║
║  [engage mission]  [new task]  [open terminal]          ║  ← primary CTAs
╚═════════════════════════════════════════════════════════╝
```

The stat numbers stay (open / in-progress / blocked / live / missions)
but as a *single-row metric strip* with thin dividers, not five
equal-weight cards. Blocked keeps its `danger` tone inline.

Below the hero, the dashboard becomes a **two-column workspace**:
left = recent tasks (compact list, not the generic `Table`), right =
missions mini-list. Both feed into the context rail for "view all".

**Why it feels modern:** The dashboard stops being "5 identical cards +
3 identical sections". It becomes a single decision surface: *what is
happening right now, and what do I do next*. The hero is the signature
surface called for in the north-star.

**What dies:** the standalone `ActivityTicker` marquee on the dashboard
(its content moves into the hero lanes + the rail). The marquee
component itself can stay for reuse elsewhere.

---

### P0.4 — Tasks page: active queue as hero, full list as workspace

**What changes:** Today `TasksView` is one `Section` with a search bar,
a filter `Segmented`, and a day-grouped card grid. Reimagine as:

- **Hero (compact):** the *active queue* — `in_progress` + `blocked`
  tasks, as a horizontal scroller of richer cards (model icon, live
  dot, tail snippet, quick stop/pause). This is the "what is running
  right now" band. Empty state = a calm "Nothing running — start
  something" with a single CTA.
- **Workspace:** the full task list below, but restructured as a
  **two-pane list-detail** on `≥lg`: left = dense task list (rows, not
  cards — title, id, status, scheduled; one line each), right =
  detail pane for the selected task (description, deps, result
  summary, actions). Selecting a row updates the right pane; no modal
  needed for browsing.
- The day grouping stays but becomes section *labels* inside the list,
  not separate card grids.

```
┌──────────────────────────────────────────────────────────┐
│ TASKS                          [search]  [filter]  [+new]│
├════════════════════ ACTIVE QUEUE ════════════════════════┤
║ [orca-atlas · running · tail…] [orca-nimbus · blocked]   ║  ← h-scroll
╚══════════════════════════════════════════════════════════╝
┌────────────────────────┬─────────────────────────────────┐
│ TODAY (5)              │ task-a1 — Refactor spawn service │
│  ▸ task-a1  in_progress│ ─────────────────────────────────│
│  ▸ task-b7  open       │ description …                    │
│ YESTERDAY (3)          │ deps: task-c2 ✓                  │
│  ▸ task-c2  closed     │ result: ok · "extracted Spawn…"  │
│  ...                   │ [start] [edit] [close] [delete]  │
└────────────────────────┴─────────────────────────────────┘
```

**Why it feels modern:** List-detail is the canonical 2026 pattern for
high-volume collections (Linear, GitHub issues, Mail.app). It kills
the "open modal to read" friction and gives a focal right pane that
justifies its own density. The hero queue makes "what's running" the
first thing you see, not the 8th row of a table.

**Keyboard:** j/k to move selection in the list, Enter to open the
task in the detail pane, ⌘E to edit, ⌘Enter to start. The detail pane
is the workspace; the list is the index.

---

### P0.5 — Sessions: live grid as the page, not a section

**What changes:** Today sessions are a `Section` containing a 3-col
grid of `SessionCard`s. Reimagine the *whole page* as the grid — no
`Section` wrapper, no `PageHeader` count badge duplicated. The module
header becomes a slim toolbar (density toggle, filter by state, "open
terminal" ⌘T). The grid uses **masonry-like rows** where `needs-input`
cards expand to show the inline approve/reject block (they already do)
and *also* claim more vertical space, drawing the eye.

- Needs-input cards sort to top-left and get a 2-row span (visible
  question + approve/reject without scrolling).
- Running cards = 1 row, compact tail.
- A new **"focus" mode** (toggle in toolbar) collapses the grid to a
  single big terminal for one session — for users who want to watch
  one agent work.

```
┌──────────────────────────────────────────────────────────┐
│ SESSIONS   3 live · 1 needs input   [density] [focus] [⌘T]│
├══════════════════════════════════════════════════════════┤
│ ┌─── needs-input (2-row) ──────┐ ┌── running ────┐ ┌──… │
│ │ orca-atlas                   │ │ orca-nimbus   │ │     │
│ │ "Approve rm -rf node_modules?"│ │ tail: …       │ │     │
│ │ [allow] [reject]             │ │ [term][stop]  │ │     │
│ └──────────────────────────────┘ └───────────────┘ └────┘
│ ┌── running ──────┐ ┌── running ──────┐                       │
│ │ orca-rho  …      │ │ orca-sigma …    │                       │
│ └──────────────────┘ └─────────────────┘                       │
└──────────────────────────────────────────────────────────┘
```

**Why it feels modern:** The grid *is* the page. No double framing.
Needs-input getting physical prominence mirrors the real workflow
(operator's first job is to unblock agents). Focus mode acknowledges
that sometimes you want to watch one thing — a canvas-style surface
hiding inside a grid.

---

### P0.6 — Config pages: two-zone + in-page section nav (no tab buttons)

**What changes:** Settings, Users, Projects drop the giant
`flex-wrap` tab-button row (settings) and the stacked-section
pattern. Instead they use a **two-zone layout**: a slim left
in-page-nav (sticky, icon + label, 160px) and a content zone. This is
the "settings as document" pattern (Vercel dashboard settings,
GitHub repo settings).

```
┌─────┬──────────────┬──────────────────────────────────────┐
│ ◉   │ SETTINGS     │                                      │
│ ▢   │ ▸ Models     │  Models                              │
│ ▣   │  Autopilot   │  ───────────────────────────────────│
│ ⚙◀  │  Providers   │  [grid of model cards — current]     │
│     │  Defaults    │                                      │
│     │              │  [save]                              │
└─────┴──────────────┴──────────────────────────────────────┘
```

- The in-page nav scrolls-spy to highlight the current section.
- Sections live on one scrollable page (not hidden behind tabs), so
  ⌘F actually finds things.
- The save button becomes sticky to the bottom of the content zone
  (or top-right of the module header) with a dirty-state pulse
  (already proposed in DESIGN-PROPOSALS P2.8 — here it becomes the
  primary save affordance for the whole page).

**Why it feels modern:** Tab buttons that swap one section are a 2014
pattern. Scroll-spy section nav with everything on one page is the
2026 pattern and it is more keyboard/search-friendly. Projects and
Users adopt the same shell so all config pages share a spine.

---

### P0.7 — Missions: the DAG becomes the page (canvas-style)

**What changes:** Today `MissionsView` is a list of rows; the
`DependencyGraph` canvas is locked inside a modal (`MissionProgressView`).
Flip it: the **engaged mission's DAG becomes the workspace**, and the
mission list collapses into a left rail (the in-page nav from P0.6).
This is the single biggest "wow" structural change.

```
┌─────┬──────────────┬──────────────────────────────────────┐
│ ◉   │ MISSIONS     │  "Refactor orca spawn pipeline"      │
│ ▢   │ ▸ engaged    │  L2 · 4/7 · ▸ paused [resume]        │
│ ▣◀  │   atlas-rf   │ ─────────────────────────────────────│
│ ⚙   │  nimbus-q    │  ╔══════════ DAG CANVAS ═══════════╗ │
│     │ ▸ paused     │  ║  phase1 ──▶ phase2 ──▶ phase3   ║ │
│     │  rho-cleanup │  ║  [●a1]    [●b2]    [○c3]        ║ │
│     │ ▸ done       │  ║           [○b7]                 ║ │
│     │  legacy-fix  │  ╚════════════════════════════════╝ │
│     │              │  ┌─ selected task ─────────────────┐│
│     │ [+ engage]   │  │ b2 — Derive tmux output         ││
│     │              │  │ status: in_progress · agent …   ││
│     │              │  └─────────────────────────────────┘│
└─────┴──────────────┴──────────────────────────────────────┘
```

- Left rail = all missions grouped by state (engaged / paused / done),
  with the phase ribbon already in `MissionsView.tsx:77-83` as the
  row's progress indicator.
- Workspace = the DAG canvas (the existing `DependencyGraph`,
  enlarged, pan/zoom-able on `≥xl`) + a selected-task detail pane
  below or beside it.
- Engaging a new mission stays in a modal (`EngageModal`).
- The "phase ribbon" from DESIGN-PROPOSALS P2.2 belongs here as a
  compact bar above the DAG.

**Why it feels modern:** A dependency graph *is* the mission. Hiding
it in a modal is like hiding a codebase's file tree. Promoting the
canvas to the page makes missions feel like a real control surface —
the most "2026 agent product" moment in the app.

---

### P0.8 — Kanban + Calendar: board as workspace, calendar as right rail

**What changes:** Today kanban/calendar share one `Section` via a
`Segmented` toggle. Reimagine: on `≥xl`, show **both** — the board as
the workspace (left, 5 columns), and a thin **week strip** (right,
~220px) showing the same tasks by day. Dragging from board to a day
cell reschedules. The toggle remains for smaller widths.

```
┌─────┬──────────────────────────────────────┬──────────────┐
│ ◉   │ KANBAN     [board|cal]  12 tasks     │ THIS WEEK    │
│ ▢◀  │                                      │ Mon 16       │
│ ▣   │ OPEN  PROGRESS  BLOCKED  CLOSED  CAN │ ▢ task-a1 9:00│
│ ⚙   │ ┌──┐  ┌──┐     ┌──┐     ┌──┐    ┌──┐│ Tue 17       │
│     │ │a1│  │b2│     │c3│     │d4│    │e5││ ▢ task-b7    │
│     │ └──┘  └──┘     └──┘     └──┘    └──┘│ Wed 18 ◀ today│
│     │                                      │ ▢ task-c2    │
│     │                                      │ Thu 19       │
└─────┴──────────────────────────────────────┴──────────────┘
```

**Why it feels modern:** Two views of the same data, spatially
co-present, with a unified drag language. The board is the workspace
(status), the week strip is the temporal context. Drag-across is the
kind of fluid interaction that reads as "real product."

---

### P0.9 — Timeline: lanes as the hero, feed as the rail

**What changes:** Today the timeline has two `Section`s: the axis/lanes
plot and the feed. Reimagine as: the **lanes view becomes the hero
surface** (taller, the first thing you see — it is the most visually
distinct thing orca has), and the **feed migrates into the context
rail** as a compact, always-visible event list. The "axis" single-track
view becomes an optional compact mode for the hero.

```
┌─────┬──────────────────────────────────────┬──────────────┐
│ ◉   │ TIMELINE   last 12h   [axis|lanes]   │ FEED         │
│ ▢   │ ┌═══════════════ HERO ═════════════╗│ ▸ 12:05      │
│ ▣◀  │ ║ orca-atlas   ● ●  ●●   ●         ║│   orca-atlas │
│ ⚙   │ ║ orca-nimbus  ●        ●●●        ║│   signal · … │
│     │ ║ orca-rho     ●● ●     ●          ║│ ▸ 12:02      │
│     │ ║   09:00    12:00    now          ║│   orca-nimbus│
│     │ ╚══════════════════════════════════╝│   task closed│
│     │                                      │ ▸ 11:58 …    │
└─────┴──────────────────────────────────────┴──────────────┘
```

**Why it feels modern:** The lane plot is orca's most unique asset.
Making it the hero leans into what the product *is* (agent
orchestration over time) instead of presenting it as one of two equal
sections.

---

## P1 — Rhythm & density refinements

### P1.1 — Kill the double frame: `Section` inside `ModuleShell` inside `main`

**What changes:** Several pages wrap a `Section` (with its own border +
shadow) inside a `ModuleShell` inside the `main` padding. On pages
where the content *is* the page (sessions grid, kanban board, timeline
lanes, missions DAG), drop the `Section` wrapper and let the surface
be the page with just the module header. Reserve `Section` for
genuinely sectional content (settings subsections, dashboard secondary
blocks).

**Why:** Double framing is a big contributor to the "boxes inside
boxes" table-orchestrator feel. One border, one shadow, one surface.

### P1.2 — Module header replaces `PageHeader` + section header

**What changes:** Introduce a single **module header** component that
is sticky, compact, and holds: page title, count, primary actions,
view toggles, and the ⌘K hint. It replaces both the current
`PageHeader` (which is just a title + count) and the `Section` header
on single-section pages. Height ~48px, `bg-surface/80 backdrop-blur`
on scroll (modal keeps `backdrop-blur-sm`; this is the one place a
subtle blur is justified — a sticky toolbar, not a card).

```
┌──────────────────────────────────────────────────────────┐
│ TASKS   12   [search…]  [active|open|blocked|closed|all]  │ ← sticky
│                        [+new]  ⌘K                         │
├──────────────────────────────────────────────────────────┤
│  …page content…                                          │
```

**Why:** Consolidates the two title rows we have today into one
purposeful toolbar. The sticky behavior means actions are always in
reach — a 2026 expectation.

### P1.3 — Density toggle as a first-class control

**What changes:** The sessions density toggle (`comfortable`/`compact`)
generalizes to tasks and the dashboard list. Add a third level,
`spacious`, for the hero surfaces. Persist the choice per-module in
`localStorage`. The toggle lives in the module header.

**Why:** Density control is the simplest way to let the user shape
the workspace to their workflow (operator-on-call wants compact;
planner wants spacious). It is also the most honest "this is a real
product" signal.

### P1.4 — Row-list variant for tasks/users/commits

**What changes:** Introduce a `RowList` primitive (one-line rows:
icon · title · id · status · chevron) for genuinely tabular data.
Replace: dashboard recent-tasks `Table`, tasks left pane (P0.4),
users table, projects commit list. The current `Table` component stays
for the rare true table (users admin), but `RowList` becomes the
default for navigable collections.

**Why:** Rows scan faster than cards for high-volume lists, and they
pair naturally with the list-detail pattern (P0.4). This is what
kills the "everything is a grid of cards" monotony.

### P1.5 — Hero top hairline accent

**What changes:** Every hero surface gets a 2px `border-t` in
`accent/40` (or `danger/50` when the hero's dominant signal is
blocked/needs-input). This is the *only* new decorative element
introduced by this proposal — and it reuses an existing token at low
opacity. No gradient, no glow.

**Why:** Gives the hero a quiet visual identity that distinguishes it
from the workspace below without any color system change. It is the
"signature surface" cue.

### P1.6 — Context rail as a first-class component

**What changes:** Promote the right-side context rail (from P0.1) into
a real `<ContextRail>` component with slots: `pulse`, `nextReady`,
`needsInput`, `activity`. Each slot is a small widget. The rail is
collapsible (icon tab on the right edge) and hidden on `<lg`. On `md`
it docks below the hero as a horizontal strip.

**Why:** A reusable rail is what makes the three-zone skeleton
scalable across pages without each page re-implementing it. It also
becomes the natural home for the ambient widgets the sidebar can't
fit (P0.2).

---

## P2 — Bigger structural bets (plan before doing)

### P2.1 — Command palette as the primary nav surface

**What changes:** Elevate ⌘K from "search + 2 actions" to the real
front door. Add: recent commands, per-module scoped actions ("in
tasks: new task with type=feature"), jump-to-task-by-id, jump-to
session by name, toggle mission pause. Add a persistent ⌘K hint in
the module header. Optionally a `⌘K` chip in the collapsed sidebar.

**Why:** Command-centricity is the strongest 2026 signal for a
power-user tool. The sidebar stays, but the palette becomes the
fastest path to any action. This is the Linear/Raycast/Zed pattern.

**Sketch:** extend `CommandPalette` with command sections (Navigate,
Create, Act on selected, Toggle), keyboard hints per command, and a
"recent" slice persisted to `localStorage`. No new dependencies.

### P2.2 — Unified "agent" surface: sessions + tasks + activity fused

**What changes:** Today an agent's identity is split across three
pages: its task (Tasks), its session (Sessions), its events (Timeline).
For an agent orchestrator, the *agent* is the natural unit. Add an
**agent detail route** `/agents/[name]` that fuses: the live tail, the
owning task, the dependency chain, the event timeline for that one
agent, and the actions (send input, interrupt, kill, open terminal).
The sessions grid and the dashboard hero link into it.

**Why:** This is the deepest re-imagination — a workspace centered on
the agent, not the table. It is the page that most justifies the
"real product" ambition. P2 because it is a new route + data
aggregation, not just a layout move.

**Wireframe:**
```
┌─────┬──────────────────────────────────────────────────────┐
│ ◉   │ AGENT · orca-atlas                  [⌘T] [stop] [kill]│
│ ▢   │ ┌─ task ────────────┐ ┌─ deps ──────────────────────┐ │
│ ▣◀  │ │ task-a1           │ │ c2 ✓ ──▶ a1 (this) ──▶ b7 ○  │ │
│ ⚙   │ │ Refactor spawn…   │ └──────────────────────────────┘ │
│     │ └───────────────────┘                                  │
│     │ ┌═════════════ LIVE TAIL ═══════════════════════════╗ │
│     │ ║ $ orca opencode …                                  ║ │
│     │ ║ ▋                                                  ║ │
│     │ ╚════════════════════════════════════════════════════╝ │
│     │ ┌─ recent events ───────────────────────────────────┐ │
│     │ │ 12:05 signal · needs input                        │ │
│     │ │ 12:02 task · status → in_progress                 │ │
│     │ └────────────────────────────────────────────────────┘ │
└─────┴────────────────────────────────────────────────────────┘
```

### P2.3 — Pan/zoom canvas for the mission DAG

**What changes:** The `DependencyGraph` SVG becomes a real pan/zoom
canvas (minimap optional, keyboard pan with arrow keys, fit-to-view
on load). For large missions (10+ tasks) the current fixed-size SVG
overflows awkwardly; a canvas makes the graph feel like a workspace.

**Why:** Canvas-style editing/viewing is a core 2026 pattern for
relational data. P2 because it needs interaction plumbing (pan/zoom
state, wheel handling) but no new dependency (can be done with a
small wheel/drag handler + viewBox).

### P2.4 — Dashboard hero "now" lanes pull live tails

**What changes:** The mini swim-lanes in the dashboard hero (P0.3)
show a 1-line live tail per running session (the last ~40 chars, same
`parseAnsi` already used in `SessionCard`). This makes the dashboard
hero genuinely *live* — you can see all agents breathing at a glance.

**Why:** Ambient liveliness without a full terminal. The data is
already streamed via `useSessionPane`. P2 only because it means
running N pane subscriptions on the dashboard (cap at 3 lanes).

### P2.5 — "Focus mode" for sessions (single big terminal)

**What changes:** The focus-mode toggle hinted in P0.5: collapses the
sessions grid to one full-bleed terminal + a thin session switcher
rail. For operators watching a single agent, this is the surface.

**Why:** Acknowledges that the grid is not always the right view.
Canvas-style focus is a 2026 pattern (Zed splits, Linear zoom).

### P2.6 — Keyboard-first list navigation (j/k/enter/⌘E)

**What changes:** Add a small `useListKeyboard` hook that wires
j/k/Enter/⌘E/⌘\ to the `RowList` (P1.4) and the missions rail. The
selected row is the keyboard context; ⌘K acts on the selected item
when possible.

**Why:** Keyboard navigation is the underpinning of command-centricity
(P2.1) and the list-detail pattern (P0.4). Without it, the new
layouts are just prettier tables.

---

## Non-goals (explicitly out of scope)

- No new color tokens. Reuse the `globals.css` palette.
- No gradients, no neon glows. The one decorative addition is the
  hero top hairline (P1.5), at 40% accent opacity — still flat.
- No framer-motion or other motion library. All proposals work with
  the existing CSS keyframes + `--ease-*`.
- No data-model or API changes. P2.2 (agent route) aggregates
  existing endpoints; P2.4 reuses `useSessionPane`; P0.2 reuses
  `/tasks/ready` and existing signal queries.
- No change to the daemon, store, or guardrails.
- No repaint of the OLED-clean aesthetic. This is structure, not
  paint.

---

## Suggested rollout order

1. **Pass 1 (P0 — the structural shift):** ~3–4 days.
   - P0.1 three-zone skeleton + P1.6 `ContextRail` component
   - P0.2 ambient sidebar
   - P0.3 dashboard hero "now"
   - P0.6 config two-zone + section nav
   These four together flip the app from "stacked sections" to
   "focal workspace + periphery" and are the bulk of the re-read.
2. **Pass 2 (P0 continued — page-specific re-shapes):** ~3 days.
   - P0.4 tasks list-detail
   - P0.5 sessions-as-page
   - P0.7 missions DAG-as-page
   - P0.8 kanban+calendar co-present
   - P0.9 timeline lanes-as-hero
   - P1.1 kill double-frame, P1.2 module header, P1.5 hero hairline
3. **Pass 3 (P1 — rhythm):** ~1–2 days.
   - P1.3 density toggle, P1.4 `RowList` primitive
4. **Pass 4 (P2 — bigger bets):** plan individually.
   - P2.1 command palette expansion (highest P2 value)
   - P2.2 unified agent surface (the signature 2026 page)
   - P2.3 DAG canvas, P2.4 live hero lanes, P2.5 focus mode, P2.6
     keyboard nav

Each P0/P1 item is independently shippable and reversible. None touch
the daemon or data layer. The aesthetic stays OLED-clean throughout —
modernity comes from *where things live*, not from repaint.

---

## Quick reference — page-by-page proposed layout

| Page | Hero (focal) | Workspace | Context rail | Key structural change |
|---|---|---|---|---|
| Dashboard | "Now" surface: live session lanes + metric strip | Two-col: recent tasks (rows) · missions mini-list | daemon pulse · next ready · needs-input · activity | P0.3 — stat cards → hero strip |
| Tasks | Active queue (h-scroll of running/blocked cards) | List-detail: day-grouped rows (left) · detail pane (right) | next ready · blocked count | P0.4 — list-detail, no modal for browsing |
| Kanban | (n/a — board is the workspace) | 5-col board | Week strip (co-present calendar) | P0.8 — board + week strip side by side |
| Missions | Engaged mission DAG canvas | (canvas is the workspace) | mission list as left in-page nav | P0.7 — DAG promoted from modal to page |
| Sessions | (grid is the page) | needs-input-expanded masonry grid | (none — grid is full-bleed) | P0.5 — drop Section wrapper, masonry, focus mode |
| Timeline | Lanes plot (tall) | (lanes are the workspace) | Feed as compact event list | P0.9 — lanes hero, feed to rail |
| Settings | (none — document-style) | Single scroll page with sections | Left in-page nav (scroll-spy) | P0.6 — kill tab buttons, section nav |
| Projects | (none) | Project list (rows) + git detail pane | (none) | P0.6 shell + list-detail |
| Users | (none) | Users table (true table) + add-user inline | (none) | P0.6 shell only |
| *New: Agents* | Live tail + task + deps | Agent workspace | Recent events | P2.2 — fused agent surface |

---

*End of proposal. No code changed.*