# Design Proposals — WOW & Interactivity (Vercel/OLED clean)

Goal: keep the existing OLED-black, gradient-free, Vercel-clean aesthetic
(`#000` bg, `rounded-lg`, accent blue, `var(--shadow-card)`), but add more
"smrnc" — life, micro-motion, depth and delightful moments — without
turning it into a dashboard demo.

Conventions used below:
- All motion respects the existing `--motion-base` (200ms), `--ease-out`
  cubic-bezier, and the `prefers-reduced-motion` block already in
  `globals.css`.
- No new colors. Reuse `--color-accent`, `--color-danger`, the
  `#10b981`/`#f59e0b`/`#22c55e` already referenced inline across the app.
- No gradients, no glows. Depth comes from border-lighten + `--shadow-raised`
  on hover, exactly as `.card-interactive` already does.

Priority key:
- **P0** — quick wins, low risk, high perceived quality (mostly CSS/Tailwind).
- **P1** — moderate effort, scoped component work, clear visual payoff.
- **P2** — larger features (new data-viz, new components) — bigger bang, plan.

---

## P0 — Quick wins (mostly CSS)

### P0.1 — Shared "card-interactive" on every clickable surface

**What feels flat today:** `TaskCard`, project tiles, session cards, kanban
cards, settings model cards, missions rows all hand-roll their own
`hover:border-border-strong` / `hover:bg-elevated/50` transitions. Some lift,
some don't; the depth language is inconsistent.

**Proposal:** make `.card-interactive` the single hover treatment for every
clickable card. Already defined in `globals.css:30` with `translateY(-1px)` +
`--shadow-raised`. Apply it everywhere instead of bespoke hover classes.

**Sketch** (TaskCard `web/modules/tasks/TaskCard.tsx:43`):
```tsx
className={`group relative flex flex-col gap-2 rounded-lg border p-3 card-interactive ${
  selected ? 'border-accent bg-accent/[0.06]' : 'border-border bg-surface'
}`}
```
Drop the inline `style={{ boxShadow: 'var(--shadow-card)' }}` — bake the base
shadow into `.card-interactive` via the `@layer` or a utility so the resting
and raised shadow live in one place.

Same one-liner applies to:
- `web/modules/sessions/SessionCard.tsx:31`
- `web/modules/kanban/KanbanBoard.tsx:52`
- `web/modules/projects/ProjectsView.tsx:63`
- `web/app/settings/page.tsx:193` (model cards)

---

### P0.2 — Stagger the fade-up entrances

**What feels flat:** `Section` (`components/ui/Section.tsx:6`) slaps
`animate-fade-up` on itself. Every section on the dashboard/missions page
slides in simultaneously, so the motion reads as one block, not a rhythm.

**Proposal:** stagger entrance via an inline `animationDelay` based on index.
Keep the same `fade-up` keyframe. Cheap, no new dependency.

**Sketch:**
```tsx
// Section.tsx — accept an optional `index` prop
export function Section({ title, icon: Icon, actions, children, index = 0 }) {
  return (
    <section
      className="bg-surface border border-border rounded-lg overflow-hidden animate-fade-up"
      style={{ boxShadow: 'var(--shadow-card)', animationDelay: `${Math.min(index, 6) * 40}ms` }}
    >
      ...
    </section>
  );
}
```
Then pass `index` from the dashboard/missions layouts. Cap at ~6 to avoid
late stragglers.

---

### P0.3 — Animated status breakdown bar (dashboard)

**What feels flat today:** The stacked status bar at
`web/modules/dashboard/DashboardView.tsx:70-82` is static `flexGrow` divs.
When data refreshes, segments jump instantly.

**Proposal:** add a `transition-[flex-grow]` on each segment so widths ease
on data change. Also add a tiny scale-on-hover so a hovered segment highlights.

**Sketch:**
```tsx
<div
  key={key}
  className={`${bg} transition-all`}
  style={{
    flexGrow: count,
    transitionDuration: 'var(--motion-base)',
    transitionTimingFunction: 'var(--ease-out)',
  }}
/>
```
Bonus: tooltip on hover showing `key: count` (mirrors `AxisMarker` pattern
in `TimelineView.tsx:35`).

---

### P0.4 — Count-up is already there — extend it to progress bars

**What feels flat today:** Mission progress bars
(`MissionsView.tsx:74`, `MissionProgressView`) animate width via CSS
`transition-[width]`, but the numeric label `{done}/{total}` jumps.

**Proposal:** extract the `useCountUp` hook from
`components/ui/StatCard.tsx:13` into a shared `lib/useCountUp.ts` and reuse
it for the `done`/`total` numbers next to progress bars, so digits and bar
move in lockstep.

**Sketch:**
```tsx
import { useCountUp } from '../../lib/useCountUp';
const animatedDone = useCountUp(done);
const animatedTotal = useCountUp(total);
<span className="font-mono text-[11px] text-text-muted">
  {t.missions.progressDone
    .replace('{done}', String(animatedDone))
    .replace('{total}', String(animatedTotal))}
</span>
```

---

### P0.5 — Delightful empty states

**What feels flat today:** `EmptyState`
(`components/ui/states.tsx:4`) is just a title + description, no icon, no
personality. Every "no tasks"/"no sessions"/"no missions" looks identical.

**Proposal:** accept an optional `icon` and `action` prop. Pair each empty
state with a tasteful line-icon (lucide) and the primary CTA already
available in context (e.g. "New task" button on the tasks empty state).
Keep the icon in `text-text-muted/40` — subtle, not shouty.

**Sketch:**
```tsx
export function EmptyState({ title, description, icon: Icon, action }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-14 text-center animate-fade-up">
      {Icon && <Icon size={28} strokeWidth={1.25} className="text-text-muted/40" aria-hidden />}
      <div className="flex flex-col gap-1">
        <p className="uppercase tracking-wide text-sm text-text">{title}</p>
        {description && <p className="text-xs text-text-muted">{description}</p>}
      </div>
      {action}
    </div>
  );
}
```
Usage in `TasksView.tsx:118`:
```tsx
<EmptyState
  title={t.tasks.empty}
  description={t.tasks.emptyDescription}
  icon={ListChecks}
  action={<Button variant="accent" icon={Plus} onClick={() => setCreating(true)}>{t.tasks.newTask}</Button>}
/>
```

---

### P0.6 — Keyboard-focus ring polish

**What feels flat today:** Focus ring is `outline: 1px solid var(--color-accent)`
(`globals.css:62`). On OLED it reads as a hard 1px line — functional but
cold.

**Proposal:** swap to a 2-tone ring (accent inset + subtle elevated halo),
still no glow. Use `box-shadow` inset so it sits inside rounded corners.

**Sketch** (in `globals.css`):
```css
button:focus-visible, a:focus-visible, input:focus-visible,
[role="switch"]:focus-visible, [role="radio"]:focus-visible {
  outline: none;
  box-shadow: 0 0 0 1px var(--color-accent), inset 0 0 0 1px var(--color-accent);
}
```
Keeps the OLED discipline (no outer glow), gives the focus more presence.

---

### P0.7 — Button press feedback already exists — add a tiny ripple-free "settle"

**What feels flat today:** `Button.tsx:16` has `active:scale-[0.97]`.
Good, but the snap-back is instant because `transition` omits `transform`.

**Proposal:** add `transform` to the transition list so the release eases.

**Sketch:**
```tsx
className={`... transition-[color,background-color,border-color,transform] duration-150 ...`}
```
Currently the transition is `transition-[color,background-color,border-color,transform]`
— wait, re-read: it already includes `transform`. So this is mostly a check.
The actual polish: add `ease-out` timing so the press springs back softly:
```tsx
className={`... transition-[color,background-color,border-color,transform] duration-150 ease-out ...`}
```

---

## P1 — Component-scoped work

### P1.1 — Skeleton loaders matched to real layout

**What feels flat today:** `LoadingState`
(`components/ui/states.tsx:13`) renders a generic 4-row skeleton regardless
of what's loading — a tasks grid, a sessions grid, a kanban board all show
the same list-shaped placeholder.

**Proposal:** add a `variant` prop (`'list' | 'grid' | 'cards' | 'kanban'`)
that emits a skeleton shaped like the real content. This is the single
biggest perceived-speed win — the layout stops "popping" into existence.

**Sketch:**
```tsx
export function LoadingState({ variant = 'list', label }: { variant?: 'list' | 'grid' | 'cards' | 'kanban'; label?: string }) {
  if (label) return <div className="flex items-center justify-center py-12 font-mono text-xs text-text-muted animate-pulse">{label}</div>;
  if (variant === 'cards') {
    return (
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" aria-busy="true">
        {[0,1,2,3,4,5].map((i) => (
          <div key={i} className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-3" style={{ boxShadow: 'var(--shadow-card)' }}>
            <div className="skeleton h-4 w-2/3 rounded" />
            <div className="skeleton h-3 w-1/3 rounded" />
            <div className="mt-2 skeleton h-6 w-full rounded-md" />
          </div>
        ))}
      </div>
    );
  }
  if (variant === 'kanban') {
    return (
      <div className="flex gap-3 overflow-hidden">
        {['open','in_progress','blocked','closed','cancelled'].map((c) => (
          <div key={c} className="flex min-w-[14rem] flex-1 flex-col gap-2 rounded-lg border border-border bg-surface p-2">
            <div className="skeleton h-3 w-20 rounded" />
            {[0,1,2].map((i) => <div key={i} className="skeleton h-12 w-full rounded-md" />)}
          </div>
        ))}
      </div>
    );
  }
  // ... 'grid' similar
  return <DefaultListSkeleton />; // current implementation
}
```
Wire `variant="cards"` into `TasksView`, `sessions`, `projects`;
`variant="kanban"` into `KanbanBoard` parent.

---

### P1.2 — Kanban card drop zones + drag affordance

**What feels flat today:** `KanbanBoard.tsx:47` cards are draggable but give
no visual cue while dragging or hovering a column. A drop feels like a guess.

**Proposal:**
1. On `onDragOver` set a `dropTarget` state on the column → ring it with a
   dashed accent border.
2. On `onDragStart` add `opacity-50` + `rotate-[1deg]` to the source card.
3. Use `transition-transform` so the card "lifts" out of the column.

**Sketch:**
```tsx
const [dragOver, setDragOver] = useState<TaskStatus | null>(null);
const [draggingId, setDraggingId] = useState<string | null>(null);

// column:
<div
  onDragOver={(e) => { e.preventDefault(); setDragOver(col.status); }}
  onDragLeave={() => setDragOver((s) => s === col.status ? null : s)}
  onDrop={(e) => { e.preventDefault(); setDragOver(null); setDraggingId(null); ... }}
  className={`... rounded-lg border bg-surface p-2 transition-colors ${
    dragOver === col.status ? 'border-accent/60' : 'border-border'
  }`}
>
// card:
<div
  draggable={!blocked}
  onDragStart={(e) => { setDraggingId(task.id); e.dataTransfer.setData('text/plain', task.id); }}
  onDragEnd={() => setDraggingId(null)}
  className={`... transition-transform ${draggingId === task.id ? 'opacity-50 rotate-[1deg]' : ''}`}
>
```

---

### P1.3 — Session card live tail shimmer

**What feels flat today:** `SessionCard.tsx:38` shows a static `<pre>` tail
that updates in place — no sense of "streaming".

**Proposal:** when new tail arrives, briefly flash the bottom edge with a
1px accent line that fades out. Pure CSS keyframe, toggled via a `data-live`
attribute when the tail hash changes.

**Sketch** (in `globals.css`):
```css
@keyframes tail-flash {
  from { box-shadow: inset 0 -1px 0 0 var(--color-accent); }
  to   { box-shadow: inset 0 -1px 0 0 transparent; }
}
.tail-live[data-flash="true"] { animation: tail-flash 600ms var(--ease-out); }
```
```tsx
// SessionCard.tsx
const prevTail = useRef(tail);
useEffect(() => {
  if (prevTail.current !== tail) {
    setFlash(true);
    const id = setTimeout(() => setFlash(false), 600);
    prevTail.current = tail;
    return () => clearTimeout(id);
  }
}, [tail]);

<pre data-flash={flash ? 'true' : undefined} className="tail-live ...">
```
Also: a subtle blinking block cursor at the end of the tail (`▋` that
blinks via the existing `skel-pulse` animation, reused).

---

### P1.4 — Timeline axis: animated marker entrance + "now" pulse

**What feels flat today:** `TimelineView` axis markers pop in on data
refresh. There's a "now" tick concept implicitly (right edge) but no
visible "live" indicator.

**Proposal:**
1. Markers animate in with `pop-in` (already defined) staggered by index.
2. Add a vertical "now" line at `frac=1` with a small accent dot pulsing
   via the existing `live-dot` animation.

**Sketch:**
```tsx
<div
  className="absolute top-1/2 h-8 w-px -translate-y-1/2 bg-accent/40"
  style={{ right: 0 }}
  aria-hidden
>
  <span className="live-dot absolute -top-1 left-1/2 h-1.5 w-1.5 -translate-x-1/2 rounded-full bg-accent" style={{ ['--live-ring' as string]: 'rgba(59,130,246,0.5)' }} />
</div>
```
For marker entrance:
```tsx
<div className={`... animate-pop-in`} style={{ animationDelay: `${Math.min(i, 8) * 30}ms` }} />
```

---

### P1.5 — Dependency graph: edge "flow" animation + node reveal

**What feels flat today:** `DependencyGraph.tsx` is a static SVG. When a
dep becomes terminal, the edge just turns green — no sense of progression.

**Proposal:**
1. Animate `stroke-dashoffset` on edges that transition from blocked→done,
   so the line "draws itself" green. One-time, ~500ms.
2. Nodes fade+scale in on mount, staggered by phase index.
3. The `live-dot` on running nodes is already there — extend the same
   treatment to "ready" nodes (subtle accent border pulse).

**Sketch** (edge transition):
```tsx
// add a one-shot ref tracking previous terminal state
const wasDone = useRef<Record<number, boolean>>({});
// in path:
const justResolved = !wasDone.current[i] && done;
useEffect(() => { wasDone.current[i] = done; }, [done]);
<path
  d={...}
  stroke={done ? '#22c55e' : 'var(--color-border-strong)'}
  strokeDasharray={justResolved ? 200 : 0}
  className={justResolved ? 'animate-draw' : undefined}
/>
```
```css
/* globals.css */
@keyframes draw { from { stroke-dashoffset: 200; } to { stroke-dashoffset: 0; } }
.animate-draw { animation: draw 500ms var(--ease-out) forwards; }
```

---

### P1.6 — Toast: progress bar countdown

**What feels flat today:** `Toast.tsx:24` auto-dismisses after 4500ms with
no indication it will. Users get surprised.

**Proposal:** thin progress bar along the bottom of the toast that shrinks
from 100% → 0% over the lifetime. Pause on hover.

**Sketch:**
```tsx
const [remaining, setRemaining] = useState(100);
useEffect(() => {
  const start = Date.now();
  const id = setInterval(() => {
    setRemaining(Math.max(0, 100 - ((Date.now() - start) / 4500) * 100));
  }, 50);
  return () => clearInterval(id);
}, []);
// pause on hover:
const [paused, setPaused] = useState(false);
useEffect(() => { if (paused) setRemaining((r) => r); }, [paused]);
```
```tsx
<div
  className="..."
  onMouseEnter={() => setPaused(true)}
  onMouseLeave={() => setPaused(false)}
>
  {/* existing content */}
  <div className="absolute bottom-0 left-0 h-0.5 bg-accent/60" style={{ width: `${remaining}%`, transition: paused ? 'none' : 'width 50ms linear' }} />
</div>
```
Hover-pause also extends the `setTimeout` — track elapsed vs. wall-clock.

---

### P1.7 — Settings category tabs: animated active indicator

**What feels flat today:** `settings/page.tsx:155-177` category buttons
just swap border/bg color on active. No motion between tabs.

**Proposal:** add a sliding underline (or top-border) that animates between
the active tab. Use a `layoutId` (framer-motion-free: track active index
and animate a positioned bar with `transition-[left,width]`).

**Sketch** (CSS-only approach, no framer):
```tsx
<div className="relative flex flex-wrap gap-2">
  {categories.map((id, i) => (
    <button
      key={id}
      onClick={() => setCategory(id)}
      className={`relative ... ${active ? 'text-white' : 'text-text-muted'}`}
    >
      <Icon /> {t.settings[id]}
      {active && (
        <span className="absolute inset-x-2 -bottom-px h-0.5 bg-accent animate-fade-up" style={{ animationDuration: 'var(--motion-fast)' }} />
      )}
    </button>
  ))}
</div>
```
For a true slide, hoist an absolutely-positioned bar and animate `left`/`width`
based on a ref-measured active button — more work, more polish.

---

### P1.8 — Checkbox / Toggle: check-mark pop

**What feels flat today:** `Checkbox.tsx:14` flips `Check` opacity 0↔100
instantly. `Toggle.tsx` slides the knob but the on/off state has no
"settle" feedback.

**Proposal:** add `transition-transform` with a small `scale` pop on the
check icon; for Toggle, add a subtle overshoot via a spring-like cubic.

**Sketch** (Checkbox):
```tsx
<Check
  size={11}
  strokeWidth={3}
  className={`transition-all duration-150 ${checked ? 'opacity-100 scale-100' : 'opacity-0 scale-50'}`}
  style={{ transitionTimingFunction: 'var(--ease-out)' }}
/>
```
(Toggle already transitions `transform` — just swap easing to a gentle
overshoot: `cubic-bezier(0.34, 1.56, 0.64, 1)` via a new `--ease-spring`
token, used sparingly only for binary toggles.)

---

## P2 — Larger features (plan before doing)

### P2.1 — Dashboard sparkline strip in StatCards

**What feels flat today:** `StatCard` shows a single number + hint. No
trend. You can't tell if "open: 12" is rising or falling.

**Proposal:** optional `sparkline` prop — a 12-point sparkline (last 12
ticks of the metric) rendered as a tiny inline SVG below the number, in
`text-text-muted/50`. Requires the daemon to expose per-metric history
(check `useActivity` / a new `/metrics/series` endpoint) — that's the P2
part.

**Sketch:**
```tsx
export function StatCard({ label, value, hint, tone, spark }) {
  ...
  {spark && (
    <svg viewBox="0 0 100 20" className="mt-1 h-4 w-full" preserveAspectRatio="none" aria-hidden>
      <polyline
        points={spark.map((v, i) => `${(i / (spark.length - 1)) * 100},${20 - (v / max) * 18}`).join(' ')}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        className="text-text-muted/50"
      />
    </svg>
  )}
}
```
Use color tone only on the *last* point dot (`accent` if trending up-good,
`danger` if up-bad like `blocked`).

---

### P2.2 — Mission progress: phase ribbon

**What feels flat today:** Mission progress is a single flat bar
(`MissionsView.tsx:74`). It hides phase structure — a 5-phase mission at
60% looks identical to a 1-phase mission at 60%.

**Proposal:** segmented progress bar — one segment per phase, colored by
phase status (done=accent, in-progress=accent-dim, blocked=danger,
pending=border). Tooltips per segment.

**Sketch:**
```tsx
<div className="flex h-1.5 w-full gap-0.5 overflow-hidden rounded-full">
  {phases.map((p) => (
    <div
      key={p.id}
      className={`flex-1 rounded-full transition-colors ${phaseColor(p.status)}`}
      style={{ transitionDuration: 'var(--motion-base)' }}
      title={`${p.title}: ${p.status}`}
    />
  ))}
</div>
```
Falls back to a single segment when no phase data — preserves current UX.

---

### P2.3 — Command palette: fuzzy match highlighting

**What feels flat today:** `CommandPalette.tsx` (not read in detail, but
exists in `components/shell/`) filters by substring. No visible match
highlight, no recent-items section.

**Proposal:**
1. Highlight the matched substring in each result (accent text).
2. Persist last 5 executed commands to `localStorage` and show them first
   when the palette opens with empty query.

**Sketch:**
```tsx
function Highlight({ text, q }: { text: string; q: string }) {
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, i)}
      <span className="text-accent">{text.slice(i, i + q.length)}</span>
      {text.slice(i + q.length)}
    </>
  );
}
```

---

### P2.4 — Activity ticker: prepend animation on new events

**What feels flat today:** `ActivityTicker.tsx` runs a marquee. New events
just appear in the rotated list — no "just arrived" signal.

**Proposal:** when a new event arrives at the head, flash it with the
`pop-in` animation and a brief accent left-border before it blends into the
marquee. Requires tracking the previous event list head by id.

**Sketch:**
```tsx
const prevHead = useRef<string | null>(null);
const isNew = (e: ActivityEvent) => prevHead.current !== null && e.id !== prevHead.current && /* newer ts */ true;
useEffect(() => { if (events[0]) prevHead.current = events[0].id; }, [events]);

// in Item:
<button className={`... ${isNew(e) ? 'animate-pop-in border-l-2 border-accent' : ''}`}>
```

---

### P2.5 — Sessions grid: density toggle + "live" sort

**What feels flat today:** Sessions are a static 3-col grid. No way to
focus on the ones needing input, or to compact the view.

**Proposal:**
1. Density toggle (Segmented: comfortable / compact) — compact shrinks the
   tail `<pre>` height and padding.
2. Auto-sort: sessions with `needs_input` signal float to top with a
   one-time `animate-fade-up` reorder. Requires `framer-motion`-free
   `LayoutGroup` alternative — or just key the list by signal priority so
   React reorders with transitions.

**Sketch:**
```tsx
const sorted = useMemo(() => {
  const prio = (s: Session) => signals[s.name]?.type === 'needs_input' ? 0 : 1;
  return [...sessions].sort((a, b) => prio(a) - prio(b));
}, [sessions, signals]);
```
Wrap each card in a `<div key={name} className="transition-all">` so the
reorder animates via FLIP if a layout-anim lib is added; otherwise the
visual jump is acceptable + the `needs_input` card already has a colored
border that draws the eye.

---

### P2.6 — Calendar: drag-to-reschedule + drop hover day highlight

**What feels flat today:** `CalendarView.tsx` shows task chips but you
can't move them — you must open the task modal to change `scheduled_at`.

**Proposal:** make `TaskChip` draggable, drop onto another day cell → calls
`updateTask({ scheduled_at })`. Day cell highlights on `dragOver` (same
pattern as kanban P1.2). This unifies the kanban/calendar drag language.

**Sketch:**
```tsx
function TaskChip({ task, onReschedule }) {
  return (
    <button
      draggable
      onDragStart={(e) => e.dataTransfer.setData('application/x-task', task.id)}
      ...
    />
  );
}
// day cell:
<div
  onDragOver={(e) => { e.preventDefault(); setDragDay(dayKey(d)); }}
  onDrop={(e) => { const id = e.dataTransfer.getData('application/x-task'); onReschedule(id, d); }}
  className={`... ${dragDay === dayKey(d) ? 'ring-1 ring-accent/50' : ''}`}
>
```
P2 because it needs a `useUpdateTask` mutation wired into the calendar
parent and a shared drag-payload convention with kanban.

---

### P2.7 — Global: route-transition fade

**What feels flat today:** Navigating between modules
(dashboard → tasks → kanban) is a hard cut. Next.js App Router doesn't
animate by default.

**Proposal:** add a `template.tsx` at `web/app/template.tsx` that wraps
children in a keyed `animate-fade-up` div. App Router re-mounts the
template on navigation, so the fade runs on every route change.

**Sketch:**
```tsx
// web/app/template.tsx
'use client';
export default function Template({ children }: { children: React.ReactNode }) {
  return <div className="animate-fade-up" key={typeof window !== 'undefined' ? window.location.pathname : undefined}>{children}</div>;
}
```
Caveat: the key trick can cause full re-mount of stateful views. Safer:
use a `usePathname()`-keyed wrapper with a short fade only on the shell
content area, not the sidebar. Keep it subtle (180ms).

---

### P2.8 — Settings save button: dirty-state pulse

**What feels flat today:** Save buttons in settings are always enabled and
look identical whether you've changed anything or not.

**Proposal:** track dirty state per section (compare form state to
`config.data`). When dirty, the Save button gets a subtle accent border
pulse (`live-dot` reused) until clicked. Disabled when clean.

**Sketch:**
```tsx
const dirty = useMemo(
  () => !config.data || JSON.stringify({ allowed, customModels, hiddenPresets }) !== JSON.stringify({
    allowedExecs: config.data.allowedExecs,
    customModels: config.data.customModels ?? [],
    hiddenPresets: config.data.hiddenPresets ?? [],
  }),
  [config.data, allowed, customModels, hiddenPresets],
);
<Button variant="accent" icon={Save} disabled={!dirty} onClick={saveModels} className={dirty ? 'live-dot' : ''}>
```
Requires normalizing comparison (array order, etc.) — that's the P2 cost.

---

## Non-goals (explicitly out of scope)

- No gradients, no neon glows, no backdrop blur on cards (modal keeps its
  existing `backdrop-blur-sm`).
- No new color tokens — reuse the existing palette.
- No framer-motion or other motion library — the existing CSS keyframes +
  `--ease-out` cover everything proposed here. Adding a lib would be a P3
  conversation, not part of these proposals.
- No change to the data model or API — P2 sparkline is the only item that
  *might* need a new endpoint; everything else is pure UI.

---

## Suggested rollout order

1. **First pass (P0)** — half a day: shared `card-interactive`, staggered
   sections, animated status bar, count-up extraction, empty-state icons,
   focus ring polish. These compound: the whole app immediately feels
   more cohesive.
2. **Second pass (P1)** — 1–2 days: skeleton variants, kanban drop zones,
   session tail shimmer, timeline now-line, dependency-graph edge flow,
   toast progress bar, settings tab indicator, checkbox pop.
3. **Third pass (P2)** — plan individually, ship incrementally: sparklines
   (needs API), phase ribbon, command palette polish, activity ticker
   prepend, calendar drag-to-reschedule, route transitions, dirty-save
   pulse.

Each P0/P1 item is independently shippable and reversible. None touch the
daemon or data layer.