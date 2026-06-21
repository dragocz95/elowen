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
