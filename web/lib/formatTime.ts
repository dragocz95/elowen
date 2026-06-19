import { parseTs } from './agentUtils';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface TaskTimeLabel {
  /** Compact relative label when the timestamp is within the last 24h ('45s','12m','3h'),
    * otherwise a locale-formatted date ('Jun 19, 14:02'). */
  label: string;
  /** The full ISO timestamp, for a title tooltip. */
  title: string;
}

/** Format a task timestamp as a single, unambiguous time label: a compact relative
 *  elapsed when it's within the last 24h, otherwise a locale date. The full ISO is
 *  returned alongside for a title tooltip so the absolute time is always reachable.
 *  Falls back to the input string when it cannot be parsed. */
export function formatTaskTime(iso: string | null | undefined, nowMs: number, locale?: string): TaskTimeLabel {
  if (!iso) return { label: '', title: '' };
  const ms = parseTs(iso);
  if (ms == null) return { label: iso, title: iso };
  const delta = nowMs - ms;
  if (delta < DAY_MS) {
    if (delta < 0) return { label: '0s', title: iso };
    const secs = Math.floor(delta / 1000);
    if (secs < 60) return { label: `${secs}s`, title: iso };
    const mins = Math.floor(secs / 60);
    if (mins < 60) return { label: `${mins}m`, title: iso };
    const hours = Math.floor(mins / 60);
    return { label: `${hours}h`, title: iso };
  }
  const label = new Date(ms).toLocaleString(locale, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  return { label, title: iso };
}