import { runtime } from '../runtime';
import type { Mission, Task } from '../types';

const { epicChildren, epicEffectiveStatus, phaseIds } = runtime().utils;

export type TaskWorkspaceFilter = 'in_progress' | 'open' | 'blocked' | 'closed' | 'autopilot' | 'all';
export type TaskFilterCounts = Record<TaskWorkspaceFilter, number>;

export function taskFilterCounts(tasks: Task[], missions: Mission[]): TaskFilterCounts {
  const children = epicChildren(tasks);
  const phases = phaseIds(tasks);
  const counts: TaskFilterCounts = { in_progress: 0, open: 0, blocked: 0, closed: 0, autopilot: 0, all: 0 };

  for (const task of tasks) {
    if (phases.has(task.id)) continue;
    counts.all += 1;
    const kids = task.type === 'epic' ? (children.get(task.id) ?? []) : [];
    if (task.type === 'epic' && kids.length > 0) counts.autopilot += 1;
    const status = task.type === 'epic' ? epicEffectiveStatus(task, missions, kids) : task.status;
    if (status === 'in_progress' || status === 'open' || status === 'blocked' || status === 'closed') counts[status] += 1;
  }

  return counts;
}
