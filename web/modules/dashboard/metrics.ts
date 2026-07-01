import type { Task, Mission } from '../../lib/types';

/** The metric cards the dashboard actually renders. Trimmed to the fields DashboardView reads —
 *  a fuller breakdown (totalTasks/closed/byStatus) was computed but never consumed. */
export interface DashboardMetrics {
  open: number;
  inProgress: number;
  blocked: number;
  liveSessions: number;
  activeMissions: number;
}

export function deriveDashboardMetrics(
  tasks: Task[] | undefined,
  sessions: string[] | undefined,
  missions: Mission[] | undefined,
): DashboardMetrics {
  const t = tasks ?? [];
  const count = (s: Task['status']) => t.filter((x) => x.status === s).length;
  return {
    open: count('open'),
    inProgress: count('in_progress'),
    blocked: count('blocked'),
    liveSessions: (sessions ?? []).length,
    activeMissions: (missions ?? []).filter((m) => m.state !== 'disengaged').length,
  };
}

/** Local-calendar-month-to-date bounds for the dashboard's fixed usage widget: start of the current
 *  local month through "now" (open-ended upper bound — matches the rolling-preset convention in
 *  lib/dateRange.ts, where toMs stays Infinity so nothing can ever fall outside the window). Not a
 *  user-selectable range like Tasks/Stats' DateRangeFilter — there is no filter control on the
 *  dashboard, so this always reflects the current month. */
export function currentMonthBounds(now: number): { fromMs: number; toMs: number } {
  const d = new Date(now);
  return { fromMs: new Date(d.getFullYear(), d.getMonth(), 1).getTime(), toMs: Infinity };
}
