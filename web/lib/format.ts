// UI formatting helpers (duration, tokens, cost, date/time). Single source of truth for how the
// dashboard renders run lengths, token counts, costs and timestamps.

/** Normalize a SQLite ("2026-06-18 10:38:49", UTC) or ISO timestamp to epoch ms. */
export function parseTs(iso?: string | null): number | null {
  if (!iso) return null;
  // SQLite emits "2026-06-18 10:38:49" (space-separated, UTC, no zone). Normalize to ISO and
  // tag it UTC — but only add 'Z' when the value doesn't already carry a zone, so an already
  // UTC-suffixed "…49Z" doesn't become an invalid "…49ZZ".
  const norm = iso.includes('T') ? iso : iso.replace(' ', 'T') + (iso.endsWith('Z') ? '' : 'Z');
  const ms = new Date(norm).getTime();
  return Number.isNaN(ms) ? null : ms;
}

// ---------------------------------------------------------------------------------------------
// Duration
// ---------------------------------------------------------------------------------------------

/** Format a run duration (ms) as a compact "1h 4m" / "3m 12s" / "8s" label.
 *  Single source of truth for run-length formatting across the UI. */
export function formatDuration(ms: number): string {
  const secs = Math.max(0, Math.floor(ms / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ${secs % 60}s`;
  const hours = Math.floor(mins / 60);
  return `${hours}h ${mins % 60}m`;
}

/** Single-unit elapsed ladder (ms → "12s" / "3m" / "5h" / "2d"). Picks the largest unit that
 *  fits, so it reads at a glance — unlike the two-unit `formatDuration`. Negatives clamp to "0s".
 *  Single source of truth for the compact relative-time chips across the UI. */
export function compactElapsed(ms: number): string {
  const secs = Math.max(0, Math.floor(ms / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

// ---------------------------------------------------------------------------------------------
// Tokens & cost
// ---------------------------------------------------------------------------------------------

/** Compact token count: 950 → "950", 12345 → "12.3k", 1_200_000 → "1.2M". Single source of truth. */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** A USD cost as a fixed 4-decimal "$0.1234" label. Single source of truth for cost rendering
 *  across the usage surfaces. */
export function formatCost(usd: number): string {
  return `$${usd.toFixed(4)}`;
}

// ---------------------------------------------------------------------------------------------
// Date & time
// ---------------------------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;

export interface TaskTimeLabel {
  /** Compact relative label when the timestamp is within the last 24h ('45s','12m','3h'),
    * otherwise a locale-formatted date ('Jun 19, 14:02'). */
  label: string;
  /** Full absolute timestamp in the viewer's LOCAL time, for a title tooltip. DB timestamps
    * are UTC, so this converts them — otherwise the tooltip shows a confusing UTC clock. */
  title: string;
}

/** Render a DB (UTC) or ISO timestamp as an absolute local-time string ('Jun 19, 2026, 14:02').
 *  `seconds` adds the seconds field (tooltips want it; compact lists don't). Falls back to the raw
 *  input when it can't be parsed. Single source of truth for absolute local date/time rendering. */
export function localDateTime(iso: string, locale?: string, seconds = true): string {
  const ms = parseTs(iso);
  if (ms == null) return iso;
  return new Date(ms).toLocaleString(locale, {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', ...(seconds ? { second: '2-digit' } : {}),
  });
}

/** Format a task timestamp as a single, unambiguous time label: a compact relative
 *  elapsed when it's within the last 24h, otherwise a locale date. The absolute local
 *  time is returned alongside for a title tooltip so it's always reachable (and never
 *  shows raw UTC). Falls back to the input string when it cannot be parsed. */
export function formatTaskTime(iso: string | null | undefined, nowMs: number, locale?: string): TaskTimeLabel {
  if (!iso) return { label: '', title: '' };
  const ms = parseTs(iso);
  if (ms == null) return { label: iso, title: iso };
  const title = localDateTime(iso, locale);
  const delta = nowMs - ms;
  if (delta < DAY_MS) return { label: compactElapsed(delta), title };
  const label = new Date(ms).toLocaleString(locale, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  return { label, title };
}
