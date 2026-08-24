import { describe, it, expect } from 'vitest';
import { pendingEscalations } from '../../lib/escalations';
import type { ActivityEvent, Task } from '../../lib/types';

const ev = (over: Partial<ActivityEvent>): ActivityEvent => ({ id: 1, ts: '2026-06-22 10:00:00', type: 'review', target: 'p1', detail: 'escalated: bad', project_id: 1, label: '', actor_user_id: null, actor_label: '', actor_username: null, actor_avatar: null, surface: '', count: 1, last_ts: null, ...over });
const task = (over: Partial<Task> & { id: string }): Task => ({ title: over.id, status: 'open', ...over });

describe('pendingEscalations', () => {
  it('surfaces a rejected phase whose dependent is blocked, with rationale and the blocked dep', () => {
    const events = [ev({ id: 2, target: 'p1', detail: 'escalated: summary is wrong', label: 'Audit docs' })];
    const tasks = [
      task({ id: 'p1', title: 'Audit docs', status: 'closed', parent_id: 'epic1' }),
      task({ id: 'p2', title: 'Fix auth', status: 'blocked', parent_id: 'epic1' }),
    ];
    const deps = [{ task_id: 'p2', depends_on_id: 'p1' }];
    const out = pendingEscalations(events, tasks, deps);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ taskId: 'p1', title: 'Audit docs', rationale: 'summary is wrong', epicId: 'epic1' });
    expect(out[0]!.blocked.map((t) => t.id)).toEqual(['p2']);
  });

  it('ignores approvals and escalations that are already resolved (no blocked dep)', () => {
    const events = [
      ev({ id: 3, target: 'p1', detail: 'approved: looks good' }),       // approval — never an escalation
      ev({ id: 4, target: 'p3', detail: 'escalated: nope' }),            // escalation but nothing blocked now
    ];
    const tasks = [
      task({ id: 'p1', status: 'closed', parent_id: 'e' }),
      task({ id: 'p3', status: 'closed', parent_id: 'e' }),
      task({ id: 'p4', status: 'open', parent_id: 'e' }), // dependent already released
    ];
    const deps = [{ task_id: 'p4', depends_on_id: 'p3' }];
    expect(pendingEscalations(events, tasks, deps)).toEqual([]);
  });

  it('hides an L3 self-heal in flight: a re-opened phase is auto-fixing, not awaiting a human', () => {
    // The latest verdict rejected the phase, its dependent is still gated 'blocked', but the engine
    // re-opened the phase to re-run it with the feedback. That is autonomous self-heal — it must not
    // show in the human inbox. It only becomes a real escalation once the phase stays put (closed).
    const events = [ev({ id: 7, target: 'p1', detail: 'escalated: hygiene' })];
    const deps = [{ task_id: 'p2', depends_on_id: 'p1' }];
    const blockedDep = task({ id: 'p2', status: 'blocked', parent_id: 'e' });
    expect(pendingEscalations(events, [task({ id: 'p1', status: 'open', parent_id: 'e' }), blockedDep], deps)).toEqual([]);
    expect(pendingEscalations(events, [task({ id: 'p1', status: 'in_progress', parent_id: 'e' }), blockedDep], deps)).toEqual([]);
    // Budget spent → phase stays closed → it is now a real, standing escalation.
    expect(pendingEscalations(events, [task({ id: 'p1', status: 'closed', parent_id: 'e' }), blockedDep], deps)).toHaveLength(1);
  });

  it('keeps only the most recent escalation per phase (events are newest-first)', () => {
    const events = [
      ev({ id: 9, target: 'p1', detail: 'escalated: second take', ts: '2026-06-22 12:00:00' }),
      ev({ id: 5, target: 'p1', detail: 'escalated: first take', ts: '2026-06-22 10:00:00' }),
    ];
    const tasks = [
      task({ id: 'p1', status: 'closed', parent_id: 'e' }),
      task({ id: 'p2', status: 'blocked', parent_id: 'e' }),
    ];
    const deps = [{ task_id: 'p2', depends_on_id: 'p1' }];
    const out = pendingEscalations(events, tasks, deps);
    expect(out).toHaveLength(1);
    expect(out[0]!.rationale).toBe('second take');
  });
});
