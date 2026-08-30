import type { DayUsage } from '../../lib/types';

/** Local-calendar-month-to-date bounds for the dashboard's fixed usage widget: start of the current
 *  local month through "now" (open-ended upper bound — matches the rolling-preset convention in
 *  lib/dateRange.ts, where toMs stays Infinity so nothing can ever fall outside the window). Not a
 *  user-selectable range like Tasks/Stats' DateRangeFilter — there is no filter control on the
 *  dashboard, so this always reflects the current month. */
export function currentMonthBounds(now: number): { fromMs: number; toMs: number } {
  const d = new Date(now);
  return { fromMs: new Date(d.getFullYear(), d.getMonth(), 1).getTime(), toMs: Infinity };
}

/** Fill the trailing UTC days without changing the measured rows. The usage API omits empty days; the
 *  chart needs stable slots so its last point always means today. */
export function trailingDays(rows: DayUsage[] | undefined, now: number, days: number): DayUsage[] {
  const byDay = new Map((rows ?? []).map((day) => [day.day, day]));
  return Array.from({ length: days }, (_, index) => {
    const key = new Date(now - (days - 1 - index) * 86_400_000).toISOString().slice(0, 10);
    return byDay.get(key) ?? { day: key, tokens: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: null };
  });
}
