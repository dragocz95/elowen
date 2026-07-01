/** Task-specific date helpers for the Tasks/Kanban date-range filter. The generic range math (presets,
 *  serialization, window bounds) lives in `lib/dateRange.ts` — this file only holds the bits that
 *  actually touch a `Task`. */
import type { Task } from '../../lib/types';

/** The epoch-ms date a task belongs to: its schedule, else when it closed, else when it was created.
 *  Returns 0 for tasks with no parseable date — the caller should treat 0 as "no date" (never hide). */
export function taskDayMs(task: Task): number {
  const iso = task.scheduled_at || task.closed_at || task.created_at;
  const ms = iso ? new Date(iso).getTime() : NaN;
  return Number.isNaN(ms) ? 0 : ms;
}

/** True when a task has no scheduled date and no closed date — i.e. it is open/in-progress/blocked
 *  work that has not been anchored to any specific day. Such tasks must always appear on the board
 *  regardless of the active date window, because hiding them would silently drop live work. */
export function isUnscheduled(task: Task): boolean {
  return !task.scheduled_at && !task.closed_at;
}
