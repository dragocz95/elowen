import { describe, it, expect } from 'vitest';
import { epicChildren, phaseIds, epicProgress, epicLive } from '../../lib/taskTree';
import type { Task } from '../../lib/types';

const task = (over: Partial<Task> = {}): Task => ({ id: 't', title: 'T', status: 'open', ...over });

const tasks: Task[] = [
  task({ id: 'e', title: 'Epic', type: 'epic' }),
  task({ id: 'p2', title: 'Phase 2', parent_id: 'e', created_at: '2026-06-18 10:02:00' }),
  task({ id: 'p1', title: 'Phase 1', parent_id: 'e', created_at: '2026-06-18 10:01:00', status: 'closed' }),
  task({ id: 's', title: 'Standalone' }),
];

describe('epicChildren', () => {
  it('groups phases under their epic, oldest first', () => {
    const m = epicChildren(tasks);
    expect(m.get('e')?.map((t) => t.id)).toEqual(['p1', 'p2']);
    expect(m.has('s')).toBe(false);
  });
});

describe('phaseIds', () => {
  it('collects every epic-phase id (and excludes standalone tasks/epics)', () => {
    const ids = phaseIds(tasks);
    expect([...ids].sort()).toEqual(['p1', 'p2']);
    expect(ids.has('e')).toBe(false);
    expect(ids.has('s')).toBe(false);
  });
});

describe('epicProgress', () => {
  it('counts closed/cancelled as done', () => {
    expect(epicProgress(epicChildren(tasks).get('e')!)).toEqual({ done: 1, total: 2 });
  });
});

describe('epicLive', () => {
  it('counts running phases and those awaiting input', () => {
    const children = [
      task({ id: 'a', status: 'in_progress', labels: ['agent:nova'] }),
      task({ id: 'b', status: 'in_progress', labels: ['agent:atlas'] }),
    ];
    const live = epicLive(children, ['orca-nova', 'orca-atlas'], { 'orca-atlas': { type: 'needs_input', question: '?' } });
    expect(live).toEqual({ running: 2, needsInput: 1 });
  });
});
