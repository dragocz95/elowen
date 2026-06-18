# Guides

Collection of advanced usage patterns, internal mechanisms, and integration recipes.

---

## Task ↔ session binding

Tasks don't store a direct reference to their tmux session. The binding is inferred from task labels:

### How it works

1. Task gets an `agent:<name>` label when spawned (e.g., `agent:SwiftLake0`)
2. The tmux session is named `orca-<name>` (e.g., `orca-SwiftLake0`)
3. To find a task's session: extract `agent:<name>` from labels → prepend `orca-`
4. To find a session's task: strip `orca-` prefix → look up agent name in `agents` table → find associated task

### Session lifecycle

```
spawn → create agent row (name, program, model) → create tmux session
  → task is in_progress → agent finishes → task closed/cancelled
  → janitor kills session → agent row stays for audit
```

### Live session detection

The web UI checks if a session is actually alive (not just `in_progress` status):

```typescript
// SessionCard reads tmux session list, compares with task's agent label
const isLive = liveSessions.includes(`orca-${agentName}`);
```

This prevents showing "Running" for tasks whose agent process crashed but status wasn't updated.

### Manual binding

If you know the agent name, you can interact directly:

```bash
curl -X POST http://localhost:4400/sessions/orca-SwiftLake0/keys \
  -H "Content-Type: application/json" \
  -d '{"keys": ["C-c"]}'
```

---

## Goal decomposition (autopilot planning)

The `POST /tasks/plan` endpoint uses an LLM to decompose a goal into ordered phases.

### Planning modes

#### Autopilot (API key configured)

1. Prompt template from `src/overseer/autopilotPrompt.md` is sent to the LLM
2. LLM returns JSON array of 3–7 phases with title, type, agent name, details
3. Each phase becomes a task, sequentially chained via `task_deps`
4. An epic task wraps all phases
5. Optionally engages a mission

**Prompt rules:**
- Phases must be concrete, independently implementable units
- No meta-steps like "specify", "research", "plan", "set up environment"
- Each phase gets a unique friendly agent name (Nova, Atlas, Iris, ...)
- Phases ordered so each builds on the previous

#### Manual fallback (no API key)

The UI shows a fallback where the user can manually type phase titles. Each line becomes a task, sequentially chained.

### Phase types

| Type | Meaning |
|---|---|
| `task` | General implementation |
| `feature` | New feature |
| `bug` | Bug fix |
| `chore` | Maintenance, refactoring |

---

## Event store / activity feed

All state changes are recorded in SQLite `events` table (`src/store/eventStore.ts`).

### Events recorded

| Event type | When triggered | Payload |
|---|---|---|
| `task` | Created, status changed, deleted | task ID + new status |
| `mission` | Engaged, paused, resumed, disengaged | mission ID + new state |
| `signal` | Deriver detected state change | session name + signal type |

### EventStore API

```typescript
class EventStore {
  record(event: { type: string; target: string; detail: string }): void
  list(opts?: { limit?: number; type?: string }): ActivityEvent[]
  deleteForTarget(target: string): void
}
```

### Activity timeline

The web UI Timeline page queries `GET /activity?limit=50` and renders:

- **Axis view**: horizontal timeline, last 12 hours, dots scaled by frequency
- **Feed view**: chronological list with icons, badges, relative timestamps
- **Filter**: All / Tasks / Missions / Signals

Events are grouped: identical events within 5 minutes collapse into `×N` to prevent flood from repeated deriver signals.

---

## Atomic terminal repaint

The terminal component (`web/components/terminal/frame.ts`) uses a specific technique to avoid flicker:

```typescript
export function composeFrame(pane: string): string {
  return `\x1b[H\x1b[2J${pane}`;
}
```

- `\x1b[H` — move cursor to home (top-left)
- `\x1b[2J` — clear entire screen
- `pane` — write new content

All three sequences are combined into a single `term.write()` call. Xterm.js processes them in one frame, so the user never sees a flash between clear and repaint.

The `nextPane()` deduplication prevents unnecessary React re-renders when the frame hasn't changed:

```typescript
function nextPane(prev: string, next: string): string {
  return prev === next ? prev : next; // same reference → React bailout
}
```

---

## Client-side ANSI parsing

The `ansi.ts` module parses terminal output with ANSI escape codes into colored segments for inline preview.

### Features

- **256-color support**: `\x1b[38;5;Nm` — foreground color from 256-color palette
- **True color (24-bit)**: `\x1b[38;2;R;G;Bm` — RGB foreground color
- **CSI stripping**: Non-color sequences (bold, italic, underline, cursor movement) are removed
- **SGR parser**: State machine parsing color codes
- **Scope**: Only foreground color — background colors and text styles are intentionally ignored for preview readability

### Output

```typescript
type AnsiSegment = { text: string; fg?: string }; // fg = CSS color string
const segments: AnsiSegment[] = parseAnsi(output);
```

Used by `SessionCard` for inline live preview without full Xterm.js.

---

## Dependency graph

The `DependencyGraph` component (`web/modules/missions/DependencyGraph.tsx`) renders mission task dependencies as an SVG node-link diagram.

### Layout algorithm

1. `layoutPhases()` performs topological sort of the task DAG
2. Cycle-safe: visiting guard prevents infinite loops on back-edges
3. Tasks are grouped into phases (columns)
4. Each phase is rendered as a vertical column of task cards
5. SVG edges (cubic bezier curves) connect dependent tasks

### Node states

| State | Visual | Meaning |
|---|---|---|
| Ready | Accent border + filled | All deps are closed/cancelled |
| Locked | Muted border | Some deps still in progress |
| Running | Animated pulse | Task is in_progress |
| Done | Subtle checkmark | Task is closed/cancelled |

### Interaction

- Hover highlights connected edges
- Click opens task detail
- Phase columns auto-scroll horizontally on overflow

---

## Calendar scheduling

The `CalendarView` (`web/modules/kanban/CalendarView.tsx`) provides day/week/month views for scheduling tasks.

### Views

| View | Shows |
|---|---|
| Day | Single day with hours, tasks positioned by `scheduled_at` |
| Week | 7 days, tasks in day columns |
| Month | Full month matrix (Mon-start, 6 weeks), task dots per day |

### Data model

```typescript
function taskCalDate(task: Task): string | null {
  return task.scheduled_at ?? task.closed_at ?? null;
}
```

Tasks without a date use `created_at` as fallback.

### Drag & drop rescheduling

- Tasks are draggable between days
- Uses `application/x-task` data transfer type
- Drop target highlights on drag over
- On drop: updates `scheduled_at` via `PATCH /tasks/:id`

### Utilities (`calendar.ts`)

```typescript
dayKey(date: Date): string         // "2026-06-18"
weekDays(weekStart: Date): Date[]  // Mon–Sun
monthMatrix(year: number, month: number): (Date | null)[][] // 6×7 grid
tasksByDay(tasks: Task[], days: Date[]): Map<string, Task[]>
```

---

## Toast notification system

The `Toast` component uses a Context/Provider pattern with rAF-based countdown.

### Architecture

```
ToastProvider (context root)
  └─ ToastContainer (fixed position, renders active toasts)
      ├─ Toast { message, tone, onDismiss }
      └─ ...
```

### Auto-dismiss with pause

```typescript
// rAF-based countdown — pauses on hover, resumes on leave
const paused = useRef(false);
const start = useRef(performance.now());

function tick(now: number) {
  if (!paused.current) elapsed += now - last;
  if (elapsed < DURATION) { raf = requestAnimationFrame(tick); }
  else { onDismiss(); }
}
```

- Uses `requestAnimationFrame` instead of `setTimeout` for smooth progress bar
- Pauses when user hovers over the toast
- Progress bar visually shows remaining time

### Usage

```typescript
const { toast } = useToast();
toast('Task created');          // accent tone (default)
toast('Failed to spawn', 'error'); // danger tone
```

---

## Provider/executor configuration

Executor presets are defined in `web/lib/execPresets.ts` and configured in `web/modules/settings/providers.tsx`.

### Executor presets

```typescript
const EXEC_PRESETS = [
  { label: 'Claude Sonnet', exec: 'sonnet' },
  { label: 'DeepSeek v4 Flash', exec: 'ollama/deepseek-v4-flash' },
  { label: 'Kimi k2.7 Code', exec: 'ollama/kimi-k2.7-code' },
  { label: 'Minimax m2.7', exec: 'ollama/minimax-m2.7' },
  { label: 'Codex gpt-5.4', exec: 'codex:gpt-5.4' },
];
```

Each preset maps a human-readable label to an `exec:<value>` that the daemon's `resolveExecutor()` understands.

### Provider metadata

The settings providers panel defines:

```typescript
interface ProviderDef {
  id: string;       // matches exec value
  label: string;    // display name
  color: string;    // accent color
  bin: string;      // binary hint
  args: string;     // argument hint
}
```

Used to render provider logos, tags, and documentation hints in settings.

---

## Inference client interface

The inference layer (`src/inference/types.ts`) defines a minimal interface for LLM backends:

```typescript
interface InferenceClient {
  decide(prompt: string): Promise<{ text: string }>;
}
```

### Implementations

| Implementation | Purpose |
|---|---|
| `RelayClient` | Production — relays to MIMO/OpenAI-compatible API |
| `FakeInference` | Tests — returns predictable responses |

### Usage

The interface is consumed by:
- **Planner** (`src/overseer/planner.ts`): goal decomposition
- **Decision engine** (`src/overseer/decision.ts`): agent prompt approval

### Adding a new backend

Implement the `InferenceClient` interface:

```typescript
class MyCustomClient implements InferenceClient {
  async decide(prompt: string): Promise<{ text: string }> {
    const response = await fetch('https://my-llm.example.com', {
      method: 'POST',
      body: JSON.stringify({ prompt }),
    });
    return { text: await response.text() };
  }
}
```

Then inject it via the `makeInference` factory in server options.

---

## Task executor in labels

Tasks store their executor as a label (`exec:sonnet`) rather than a dedicated DB column.

```typescript
// web/lib/taskExec.ts
export function taskExec(labels: string[]): string | undefined {
  return labels.find(l => l.startsWith('exec:'))?.slice('exec:'.length);
}
```

### Why labels?

- Labels are a general-purpose key-value store on tasks
- Avoids schema migration for each new attribute
- Frontend and backend use the same resolution logic
- Multiple labels can coexist (exec + exec + agent + guardrail triggers)

### Resolution order

1. Check if label starts with a known prefix (`codex:`, `opencode:`, `claude:`)
2. If contains `/`, treat as model path → use `opencode`
3. Otherwise → use `claude-code` with the value as model name

---

## Scheduled task launch

Tasks can be scheduled for future execution via the `scheduled_at` ISO-8601 field.

### Flow

1. Task created with `scheduled_at: "2026-06-20T10:00:00Z"`
2. `Scheduler.tick()` runs periodically, finds due tasks
3. Schedule is consumed (set to `null`) so it fires exactly once
4. Agent is spawned immediately

### Conflict detection

The web UI warns when two tasks are scheduled within 10 minutes of each other:

```typescript
const conflicts = tasks.filter(t =>
  t.scheduled_at && Math.abs(new Date(t.scheduled_at) - new Date(newTask.scheduled_at)) < 10 * 60 * 1000
);
```
