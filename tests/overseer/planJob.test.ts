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
});
