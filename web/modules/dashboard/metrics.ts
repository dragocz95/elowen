import type { Task, Mission, TaskStatus } from '../../lib/types';

export interface DashboardMetrics {
  totalTasks: number;
  open: number;
  inProgress: number;
  blocked: number;
  closed: number;
  liveSessions: number;
  activeMissions: number;
  byStatus: Record<TaskStatus, number>;
}

export function deriveDashboardMetrics(
  tasks: Task[] | undefined,
  sessions: string[] | undefined,
  missions: Mission[] | undefined,
): DashboardMetrics {
  const t = tasks ?? [];
  const count = (s: Task['status']) => t.filter((x) => x.status === s).length;
  const byStatus: Record<TaskStatus, number> = {
    open: count('open'),
    in_progress: count('in_progress'),
    blocked: count('blocked'),
    closed: count('closed'),
    cancelled: count('cancelled'),
  };
  return {
    totalTasks: t.length,
    open: byStatus.open,
    inProgress: byStatus.in_progress,
    blocked: byStatus.blocked,
    closed: byStatus.closed,
    liveSessions: (sessions ?? []).length,
    activeMissions: (missions ?? []).filter((m) => m.state !== 'disengaged').length,
    byStatus,
  };
}
