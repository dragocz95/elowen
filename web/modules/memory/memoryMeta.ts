import type { Tone } from '../../components/ui/tone';
import type { LocaleDict } from '../../lib/i18n/types';
import type { Memory, MemoryCategory, MemoryEvent } from '../../lib/types';

/** Memory status → badge tone. Single source of truth for how a memory's lifecycle colors. */
const STATUS_TONE: Record<Memory['status'], Tone> = {
  active: 'success',
  archived: 'muted',
  deleted: 'danger',
};
export function memoryStatusTone(status: Memory['status']): Tone {
  return STATUS_TONE[status];
}

/** Localized label for a memory status (list filter + detail badge share it). */
export function memoryStatusLabel(t: LocaleDict, status: Memory['status']): string {
  if (status === 'archived') return t.memory.statusArchived;
  if (status === 'deleted') return t.memory.statusDeleted;
  return t.memory.statusActive;
}

/** Localized verb for one audit action. Unknown actions fall back to the raw string so the trail
 *  never renders blank if the daemon adds a new action kind. */
export function memoryActionLabel(t: LocaleDict, action: string): string {
  switch (action) {
    case 'add': return t.memory.actionAdd;
    case 'update': return t.memory.actionUpdate;
    case 'delete': return t.memory.actionDelete;
    case 'restore': return t.memory.actionRestore;
    case 'merge': return t.memory.actionMerge;
    default: return action;
  }
}

/** Audit action → tone, reusing the lifecycle palette (add/restore read as success, delete as danger). */
export function memoryActionTone(action: string): Tone {
  if (action === 'delete') return 'danger';
  if (action === 'add' || action === 'restore') return 'success';
  if (action === 'merge') return 'accent';
  return 'muted';
}

/** Distinct kinds present in a memory list, sorted, for the kind filter dropdown. */
export function distinctKinds(memories: Memory[]): string[] {
  const set = new Set<string>();
  for (const m of memories) if (m.kind) set.add(m.kind);
  return [...set].sort((a, b) => a.localeCompare(b));
}

/** A 0..1 weight as an integer percent for compact display. */
export function pct01(v: number): number {
  return Math.round(Math.max(0, Math.min(1, v)) * 100);
}

/** Fallback swatch color for a category whose `color` is blank. A muted token so the chip still reads. */
const CATEGORY_FALLBACK_COLOR = 'var(--color-text-muted)';

/** Preset swatch palette offered in the category create/edit modal — tasteful, spread across the wheel. */
export const CATEGORY_COLORS: readonly string[] = [
  '#6366f1', '#8b5cf6', '#ec4899', '#ef4444', '#f97316',
  '#eab308', '#22c55e', '#14b8a6', '#0ea5e9', '#64748b',
];

/** A category's swatch color, falling back to a muted token when the stored color is blank. */
export function categorySwatch(color: string | null | undefined): string {
  const c = (color ?? '').trim();
  return c || CATEGORY_FALLBACK_COLOR;
}

/** Per-category memory counts (by category id) plus the uncategorized tally. Pure — drives the manager
 *  chips and any breakdown without a second server round-trip. */
export function countByCategory(memories: Memory[]): { byId: Map<number, number>; uncategorized: number } {
  const byId = new Map<number, number>();
  let uncategorized = 0;
  for (const m of memories) {
    if (m.category_id == null) uncategorized += 1;
    else byId.set(m.category_id, (byId.get(m.category_id) ?? 0) + 1);
  }
  return { byId, uncategorized };
}

/** Index categories by id for O(1) chip resolution in list rows / detail. */
export function categoriesById(categories: MemoryCategory[]): Map<number, MemoryCategory> {
  return new Map(categories.map((c) => [c.id, c]));
}

/** One bar in an overview breakdown: label, absolute count, and a max-normalized 0..100 width. */
export interface BreakdownRow { key: string; label: string; count: number; pct: number; tone: Tone }

/** Group memories by a keying function into sorted, max-normalized breakdown rows (per-kind / per-status
 *  overview bars). Pure so the view stays declarative — mirrors buildUsageSummary in stats. */
export function buildBreakdown(
  memories: Memory[],
  keyOf: (m: Memory) => string,
  labelOf: (key: string) => string,
  toneOf: (key: string) => Tone,
): BreakdownRow[] {
  const counts = new Map<string, number>();
  for (const m of memories) {
    const k = keyOf(m) || '—';
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const max = Math.max(1, ...counts.values());
  return [...counts.entries()]
    .map(([key, count]) => ({ key, label: labelOf(key), count, pct: (count / max) * 100, tone: toneOf(key) }))
    .sort((a, b) => b.count - a.count);
}

/** Parse an event's before/after JSON snapshot safely (stored blob). Returns null on any malformation. */
function parseSnapshot(json: string | null): Partial<Memory> | null {
  if (!json) return null;
  try {
    const p = JSON.parse(json) as unknown;
    if (p && typeof p === 'object') return p as Partial<Memory>;
  } catch { /* malformed snapshot — skip, keep the trail rendering */ }
  return null;
}

/** The single most useful one-line summary of what an event changed, for the audit feed. */
export function eventSummary(ev: MemoryEvent): string | null {
  const after = parseSnapshot(ev.after_json);
  if (after && typeof after.body === 'string') return after.body;
  const before = parseSnapshot(ev.before_json);
  if (before && typeof before.body === 'string') return before.body;
  return null;
}
