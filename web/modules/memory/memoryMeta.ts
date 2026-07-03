import type { Tone } from '../../components/ui/tone';
import type { LocaleDict } from '../../lib/i18n/types';
import type { Memory, MemoryEvent } from '../../lib/types';

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
