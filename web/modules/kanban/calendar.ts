import type { Task } from '../../lib/types';

export type CalRange = 'day' | 'week' | 'month';

const pad = (n: number) => String(n).padStart(2, '0');

/** Local YYYY-MM-DD key for a date. */
export function dayKey(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function sameDay(a: Date, b: Date): boolean {
  return dayKey(a) === dayKey(b);
}

/** The date a task sits on in the calendar: its schedule, else when it completed.
 *  Lets finished (closed) tasks show up on their completion day without having been planned. */
export function taskCalDate(t: Task): string | null {
  return t.scheduled_at || t.closed_at || null;
}

/** Group tasks by their local calendar day (scheduled or completed). Tasks with neither are excluded. */
export function tasksByDay(tasks: Task[]): Map<string, Task[]> {
  const map = new Map<string, Task[]>();
  for (const t of tasks) {
    const iso = taskCalDate(t);
    if (!iso) continue;
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) continue;
    const k = dayKey(d);
    (map.get(k) ?? map.set(k, []).get(k)!).push(t);
  }
  for (const list of map.values()) list.sort((a, b) => (taskCalDate(a) ?? '').localeCompare(taskCalDate(b) ?? ''));
  return map;
}

export function countUnscheduled(tasks: Task[]): number {
  return tasks.filter((t) => !taskCalDate(t)).length;
}

/** Monday-of-week (local) for the given date. */
export function startOfWeek(ref: Date): Date {
  const d = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate());
  const dow = (d.getDay() + 6) % 7; // Mon=0 … Sun=6
  d.setDate(d.getDate() - dow);
  return d;
}

/** The 7 dates (Mon–Sun) of ref's week. */
export function weekDays(ref: Date): Date[] {
  const start = startOfWeek(ref);
  return Array.from({ length: 7 }, (_, i) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + i));
}

/** Weeks (each 7 dates) covering ref's month, padded to full weeks (Mon-start). */
export function monthMatrix(ref: Date): Date[][] {
  const first = new Date(ref.getFullYear(), ref.getMonth(), 1);
  const gridStart = startOfWeek(first);
  const weeks: Date[][] = [];
  const cursor = new Date(gridStart);
  // 6 weeks covers any month layout
  for (let w = 0; w < 6; w++) {
    const week: Date[] = [];
    for (let i = 0; i < 7; i++) { week.push(new Date(cursor)); cursor.setDate(cursor.getDate() + 1); }
    weeks.push(week);
    // stop after we've passed the month and completed a week
    if (week[6]!.getMonth() !== ref.getMonth() && week[0]!.getMonth() !== ref.getMonth()) break;
  }
  return weeks;
}

/** Shift a reference date by one period in the given range. */
export function shift(ref: Date, range: CalRange, dir: -1 | 1): Date {
  const d = new Date(ref);
  if (range === 'day') d.setDate(d.getDate() + dir);
  else if (range === 'week') d.setDate(d.getDate() + 7 * dir);
  else d.setMonth(d.getMonth() + dir);
  return d;
}
