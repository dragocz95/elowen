import type { Task, TaskStatus } from '../types';


const STATUSES: TaskStatus[] = ['open', 'in_progress', 'blocked', 'closed', 'cancelled'];

/** Buckets tasks by status. Pass `statusOf` to override a task's column (e.g. an epic shown
 *  under its mission's effective status while its true status is preserved elsewhere). */
export function groupByStatus(tasks: Task[], statusOf: (t: Task) => TaskStatus = (t) => t.status): Record<TaskStatus, Task[]> {
  const groups = Object.fromEntries(STATUSES.map((s) => [s, [] as Task[]])) as Record<TaskStatus, Task[]>;
  for (const task of tasks) {
    (groups[statusOf(task)] ??= []).push(task);
  }
  return groups;
}
