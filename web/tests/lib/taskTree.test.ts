import { describe, it, expect } from 'vitest';
import { epicChildren, phaseIds, epicProgress, epicLive, epicCapacity, epicEffectiveStatus } from '../../lib/taskTree';
import type { Task, Mission } from '../../lib/types';

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

  // W19: a stale needs_input signal for a session that is no longer live must not be counted.
  it('ignores needs_input signals for dead (non-live) sessions', () => {
    const children = [task({ id: 'a', status: 'in_progress', labels: ['agent:nova'] })];
    const live = epicLive(children, [], { 'orca-nova': { type: 'needs_input', question: '?' } });
    expect(live).toEqual({ running: 0, needsInput: 0 });
  });
});

describe('epicCapacity', () => {
  it('counts live running phases against the session cap, with free slots', () => {
    const children = [
      task({ id: 'a', status: 'in_progress', labels: ['agent:nova'] }),
      task({ id: 'b', status: 'in_progress', labels: ['agent:atlas'] }),
      task({ id: 'c', status: 'open', labels: ['agent:orion'] }), // not running yet
      task({ id: 'd', status: 'in_progress', labels: ['agent:ghost'] }), // in_progress but no live session
    ];
    expect(epicCapacity(children, ['orca-nova', 'orca-atlas'], 2)).toEqual({ running: 2, max: 2, free: 0 });
    expect(epicCapacity(children, ['orca-nova', 'orca-atlas'], 3)).toEqual({ running: 2, max: 3, free: 1 });
    expect(epicCapacity(children, [], 2)).toEqual({ running: 0, max: 2, free: 2 });
  });

  it('clamps running to max (stale in_progress never over-reports) and floors max at 0', () => {
    const children = [task({ id: 'a', status: 'in_progress', labels: ['agent:nova'] }), task({ id: 'b', status: 'in_progress', labels: ['agent:atlas'] })];
    expect(epicCapacity(children, ['orca-nova', 'orca-atlas'], 1)).toEqual({ running: 1, max: 1, free: 0 });
    expect(epicCapacity(children, ['orca-nova', 'orca-atlas'], 0)).toEqual({ running: 0, max: 0, free: 0 });
    expect(epicCapacity(children, ['orca-nova', 'orca-atlas'], -2)).toEqual({ running: 0, max: 0, free: 0 });
  });

  // W20: non-finite maxSessions (undefined/NaN from malformed data) must not poison the meter.
  it('treats non-finite maxSessions as 0 instead of rendering NaN', () => {
    const children = [task({ id: 'a', status: 'in_progress', labels: ['agent:nova'] })];
    expect(epicCapacity(children, ['orca-nova'], NaN)).toEqual({ running: 0, max: 0, free: 0 });
    expect(epicCapacity(children, ['orca-nova'], undefined as unknown as number)).toEqual({ running: 0, max: 0, free: 0 });
  });
});

describe('epicEffectiveStatus', () => {
  const epic = (over: Partial<Task> = {}): Task => ({ id: 'e', title: 'Epic', status: 'open', type: 'epic', ...over });
  const mission = (over: Partial<Mission> = {}): Mission => ({ id: 'm', epic_id: 'e', autonomy: 'L3', max_sessions: 1, state: 'active', ...over });

  it('renders an epic as in_progress when an engaged mission exists (state != disengaged)', () => {
    expect(epicEffectiveStatus(epic(), [mission({ state: 'active' })])).toBe('in_progress');
    expect(epicEffectiveStatus(epic(), [mission({ state: 'paused' })])).toBe('in_progress');
  });

  it('keeps the true status when the mission is disengaged or there is no mission', () => {
    expect(epicEffectiveStatus(epic({ status: 'open' }), [mission({ state: 'disengaged' })])).toBe('open');
    expect(epicEffectiveStatus(epic({ status: 'closed' }), [mission({ state: 'disengaged' })])).toBe('closed');
    expect(epicEffectiveStatus(epic({ status: 'open' }), [])).toBe('open');
  });

  it('ignores missions for other epics', () => {
    expect(epicEffectiveStatus(epic({ id: 'e1' }), [mission({ epic_id: 'e2', state: 'active' })])).toBe('open');
  });

  it('returns the true status for non-epic tasks (no virtual mapping)', () => {
    expect(epicEffectiveStatus(task({ id: 't1', status: 'blocked' }), [mission({ epic_id: 't1', state: 'active' })])).toBe('blocked');
  });

  it('derives status from phases when there is no active mission (stale open epic)', () => {
    const e = epic({ status: 'open' });
    // all phases done → the epic is closed, not 'open'
    expect(epicEffectiveStatus(e, [], [task({ status: 'closed' }), task({ status: 'cancelled' })])).toBe('closed');
    // a running phase → in_progress
    expect(epicEffectiveStatus(e, [], [task({ status: 'closed' }), task({ status: 'in_progress' })])).toBe('in_progress');
    // a blocked phase (none running) → blocked
    expect(epicEffectiveStatus(e, [], [task({ status: 'closed' }), task({ status: 'blocked' })])).toBe('blocked');
    // still has open work → open
    expect(epicEffectiveStatus(e, [], [task({ status: 'closed' }), task({ status: 'open' })])).toBe('open');
  });
});
