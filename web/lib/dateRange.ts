/** Generic rolling/custom date-range filtering, shared by every view that offers a Today/7d/30d/90d/
 *  All/custom window (Tasks, Kanban, Stats). Pure, side-effect-free so the window logic is
 *  unit-testable independent of any view. Presets are *rolling* (computed from "now"); a custom
 *  range pins explicit local-day bounds. */

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
  // Legacy single-preset form (the old Timeline stored just the preset string, no from/to) — accept it as a
  // preset window so a saved 7d/30d/all range survives the collapse onto this shared model.
  if (parts.length === 1) {
    return raw !== 'custom' && (RANGE_PRESETS as readonly string[]).includes(raw) ? { preset: raw as RangePreset, from: null, to: null } : null;
  }
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

/** Cap of the visible window in hours — the distance from the window's lower bound to now. `all` (and a
 *  custom range left open on the `from` side) is unbounded → Infinity. Used by the Timeline to size its
 *  axis. */
export function rangeWindowCapHours(r: DateRange, now: number): number {
  const { fromMs } = rangeBounds(r, now);
  return Number.isFinite(fromMs) ? (now - fromMs) / 3_600_000 : Infinity;
}
