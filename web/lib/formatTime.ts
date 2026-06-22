import { parseTs } from './agentUtils';
import { compactElapsed } from './formatDuration';

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
