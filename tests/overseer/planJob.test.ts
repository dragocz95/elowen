import { describe, it, expect } from 'vitest';
import { PlanJobStore } from '../../src/overseer/planJob.js';

describe('PlanJobStore', () => {
  it('creates a planning job and reads it back', () => {
    const s = new PlanJobStore();
    const j = s.create({ goal: 'add export', projectId: 1, epicId: 'orca-ep', dryRun: false });
    expect(j.status).toBe('planning');
    expect(j.phases).toEqual([]);
    expect(s.get(j.id)).toMatchObject({ goal: 'add export', epicId: 'orca-ep' });
  });
  it('setPhases marks the job done', () => {
    const s = new PlanJobStore();
    const j = s.create({ goal: 'g', projectId: 1, epicId: null, dryRun: true });
    const done = s.setPhases(j.id, [{ title: 'A', type: 'task' }]);
    expect(done!.status).toBe('done');
    expect(done!.phases).toHaveLength(1);
  });
  it('fail marks the job failed with an error', () => {
    const s = new PlanJobStore();
    const j = s.create({ goal: 'g', projectId: 1, epicId: null, dryRun: false });
    expect(s.fail(j.id, 'timeout')!.status).toBe('failed');
    expect(s.get(j.id)!.error).toBe('timeout');
  });
  it('get returns null for unknown id', () => {
    expect(new PlanJobStore().get('nope')).toBeNull();
  });

  it('prunes settled jobs older than the TTL on the next create, but keeps in-flight ones (O27)', () => {
    let now = 0;
    const s = new PlanJobStore(() => now);
    const old = s.create({ goal: 'old', projectId: 1, epicId: null, dryRun: false });
    s.fail(old.id, 'done long ago'); // terminal
    const stillPlanning = s.create({ goal: 'wip', projectId: 1, epicId: null, dryRun: false }); // never settled
    now += 11 * 60_000; // advance past the 10-min TTL
    s.create({ goal: 'fresh', projectId: 1, epicId: null, dryRun: false }); // triggers prune
    expect(s.get(old.id)).toBeNull();              // long-settled job evicted
    expect(s.get(stillPlanning.id)).not.toBeNull(); // in-flight job retained regardless of age
  });
});
