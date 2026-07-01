/** Local-calendar-month-to-date bounds for the dashboard's fixed usage widget: start of the current
 *  local month through "now" (open-ended upper bound — matches the rolling-preset convention in
 *  lib/dateRange.ts, where toMs stays Infinity so nothing can ever fall outside the window). Not a
 *  user-selectable range like Tasks/Stats' DateRangeFilter — there is no filter control on the
 *  dashboard, so this always reflects the current month. */
export function currentMonthBounds(now: number): { fromMs: number; toMs: number } {
  const d = new Date(now);
  return { fromMs: new Date(d.getFullYear(), d.getMonth(), 1).getTime(), toMs: Infinity };
}
