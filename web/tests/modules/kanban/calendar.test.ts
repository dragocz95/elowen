import { describe, it, expect } from 'vitest';
import { dayKey, tasksByDay, countUnscheduled, startOfWeek, weekDays, monthMatrix, shift } from '../../../modules/kanban/calendar';
import type { Task } from '../../../lib/types';

const t = (id: string, scheduled_at: string | null): Task => ({ id, title: id, status: 'open', scheduled_at });

describe('calendar helpers', () => {
  it('groups scheduled tasks by local day and skips unscheduled', () => {
    const map = tasksByDay([t('a', '2026-06-17T09:00:00.000Z'), t('b', null), t('c', '2026-06-17T20:00:00.000Z')]);
    const day = new Date('2026-06-17T09:00:00.000Z');
    expect(map.get(dayKey(day))?.map((x) => x.id).sort()).toEqual(['a', 'c']);
    expect(countUnscheduled([t('a', '2026-06-17T09:00:00.000Z'), t('b', null)])).toBe(1);
  });

  it('places completed tasks on their closed day even without a schedule', () => {
    const closed: Task = { id: 'done', title: 'done', status: 'closed', scheduled_at: null, closed_at: '2026-06-15T14:00:00.000Z' };
    const map = tasksByDay([closed]);
    expect(map.get(dayKey(new Date('2026-06-15T14:00:00.000Z')))?.map((x) => x.id)).toEqual(['done']);
    expect(countUnscheduled([closed])).toBe(0); // has a calendar date now
  });

  it('startOfWeek returns the Monday', () => {
    const wed = new Date(2026, 5, 17); // Wed Jun 17 2026
    const mon = startOfWeek(wed);
    expect(mon.getDay()).toBe(1); // Monday
    expect(weekDays(wed)).toHaveLength(7);
    expect(weekDays(wed)[0]!.getDay()).toBe(1);
  });

  it('monthMatrix rows are 7 wide and include the month', () => {
    const weeks = monthMatrix(new Date(2026, 5, 17));
    expect(weeks.every((w) => w.length === 7)).toBe(true);
    expect(weeks.flat().some((d) => d.getMonth() === 5 && d.getDate() === 17)).toBe(true);
  });

  it('shift moves by day/week/month', () => {
    const ref = new Date(2026, 5, 17);
    expect(shift(ref, 'day', 1).getDate()).toBe(18);
    expect(shift(ref, 'week', -1).getDate()).toBe(10);
    expect(shift(ref, 'month', 1).getMonth()).toBe(6);
  });
});
