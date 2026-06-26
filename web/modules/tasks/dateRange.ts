/** Date-range filtering for the Tasks list. Pure, side-effect-free helpers so the window logic is
 *  unit-testable independent of the view. Presets are *rolling* (computed from "now"); a custom range
 *  pins explicit local-day bounds. The whole feature lives caller-side in TasksView — it never touches
 *  the shared `/tasks` fetch, so Kanban/Timeline/Sidebar keep their unfiltered "all tasks" cache. */
import type { Task } from '../../lib/types';

export type RangePreset = '7d' | '30d' | '90d' | 'today' | 'all' | 'custom';
export const RANGE_PRESETS: readonly RangePreset[] = ['7d', '30d', '90d', 'today', 'all', 'custom'];

/** A selected window. `from`/`to` are `YYYY-MM-DD` local days, only meaningful when `preset === 'custom'`. */
export interface DateRange { preset: RangePreset; from: string | null; to: string | null }

export const DEFAULT_RANGE: DateRange = { preset: '7d', from: null, to: null };

const DAY = 86400000;
const isDateStr = (s: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(s);

/** Local start-of-day for an epoch ms. */
const startOfDay = (ms: number): number => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };
/** Local end-of-day for an epoch ms. */
const endOfDay = (ms: number): number => { const d = new Date(ms); d.setHours(23, 59, 59, 999); return d.getTime(); };
/** Local day bounds from a `YYYY-MM-DD` string (the `T..` form forces local, not UTC, parsing). */
const startOfDayStr = (s: string): number => new Date(`${s}T00:00:00`).getTime();
const endOfDayStr = (s: string): number => new Date(`${s}T23:59:59.999`).getTime();

/** Serialize for a single localStorage slot: `preset|from|to` (empty segments for null). */
export function serializeRange(r: DateRange): string {
  return `${r.preset}|${r.from ?? ''}|${r.to ?? ''}`;
}

/** Parse a stored value back to a range; returns null on anything malformed so the caller keeps the
 *  default rather than restoring junk. */
export function parseRange(raw: string): DateRange | null {
  const parts = raw.split('|');
  if (parts.length !== 3) return null;
  const [preset, from, to] = parts;
  if (!(RANGE_PRESETS as readonly string[]).includes(preset)) return null;
  if (from && !isDateStr(from)) return null;
  if (to && !isDateStr(to)) return null;
  return { preset: preset as RangePreset, from: from || null, to: to || null };
}

/** Predicate for usePersistentState — true when the raw stored string is a well-formed range. */
export const isStoredRange = (raw: string): boolean => parseRange(raw) !== null;

/** Effective `[fromMs, toMs]` window. Presets reach from N-1 days before today up to now-and-beyond
 *  (so upcoming scheduled tasks stay visible); custom uses inclusive local day bounds, open on any
 *  side left blank. */
export function rangeBounds(r: DateRange, now: number): { fromMs: number; toMs: number } {
  if (r.preset === 'all') return { fromMs: -Infinity, toMs: Infinity };
  if (r.preset === 'today') return { fromMs: startOfDay(now), toMs: endOfDay(now) };
  if (r.preset === 'custom') {
    return {
      fromMs: r.from ? startOfDayStr(r.from) : -Infinity,
      toMs: r.to ? endOfDayStr(r.to) : Infinity,
    };
  }
  const days = r.preset === '7d' ? 7 : r.preset === '30d' ? 30 : 90;
  return { fromMs: startOfDay(now) - (days - 1) * DAY, toMs: Infinity };
}

/** True when an epoch-ms timestamp falls inside the range's window. */
export function inRange(ms: number, r: DateRange, now: number): boolean {
  const { fromMs, toMs } = rangeBounds(r, now);
  return ms >= fromMs && ms <= toMs;
}

/** The epoch-ms date a task belongs to: its schedule, else when it closed, else when it was created.
 *  Returns 0 for tasks with no parseable date — the caller should treat 0 as "no date" (never hide). */
export function taskDayMs(task: Task): number {
  const iso = task.scheduled_at || task.closed_at || task.created_at;
  const ms = iso ? new Date(iso).getTime() : NaN;
  return Number.isNaN(ms) ? 0 : ms;
}

/** True when a task has no scheduled date and no closed date — i.e. it is open/in-progress/blocked
 *  work that has not been anchored to any specific day. Such tasks must always appear on the board
 *  regardless of the active date window, because hiding them would silently drop live work. */
export function isUnscheduled(task: Task): boolean {
  return !task.scheduled_at && !task.closed_at;
}
