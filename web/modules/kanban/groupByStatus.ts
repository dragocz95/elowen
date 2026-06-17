import type { Task, TaskStatus } from '../../lib/types';

const STATUSES: TaskStatus[] = ['open', 'in_progress', 'blocked', 'closed', 'cancelled'];

export function groupByStatus(tasks: Task[]): Record<TaskStatus, Task[]> {
  const groups = Object.fromEntries(STATUSES.map((s) => [s, [] as Task[]])) as Record<TaskStatus, Task[]>;
  for (const task of tasks) {
    (groups[task.status] ??= []).push(task);
  }
  return groups;
}
