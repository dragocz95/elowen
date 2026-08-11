import { describe, it, expect } from 'vitest';
import { PlanJobStore } from '../../../../src/api/planJobStore.js';

describe('PlanJobStore', () => {
  it('creates a planning job and reads it back', () => {
    const s = new PlanJobStore();
    const j = s.create({ goal: 'add export', projectId: 1, epicId: 'elowen-ep', dryRun: false });
    expect(j.status).toBe('planning');
    expect(j.phases).toEqual([]);
    expect(s.get(j.id)).toMatchObject({ goal: 'add export', epicId: 'elowen-ep' });
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

  it('setSession records the pilot tmux session so the client can live-preview it', () => {
    const s = new PlanJobStore();
    const j = s.create({ goal: 'g', projectId: 1, epicId: null, dryRun: false });
    expect(s.get(j.id)!.sessionName).toBeUndefined();
    s.setSession(j.id, 'elowen-pilot-Nova');
    expect(s.get(j.id)!.sessionName).toBe('elowen-pilot-Nova');
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

  it('settles an in-flight job whose Pilot never came back, instead of polling "planning" forever', () => {
    // Only the Pilot's `plan submit` settles a job. When its session dies (crash, killed pane) nothing
    // else ever does, so the client polls a job that will never answer and the map keeps it for the
    // daemon's lifetime. Past the planning window it must read as a definite failure.
    let now = 0;
    const s = new PlanJobStore(() => now);
    const j = s.create({ goal: 'g', projectId: 1, epicId: null, dryRun: false });
    now += 59 * 60_000;
    expect(s.get(j.id)!.status).toBe('planning'); // still within the window — a slow plan is untouched
    now += 2 * 60_000;
    expect(s.get(j.id)!.status).toBe('failed');
    expect(s.get(j.id)!.error).toBe('plan_timed_out');
  });

  it('prunes an in-flight job that timed out long ago (the map cannot grow unbounded)', () => {
    let now = 0;
    const s = new PlanJobStore(() => now);
    const abandoned = s.create({ goal: 'g', projectId: 1, epicId: null, dryRun: false });
    now += 61 * 60_000;
    s.create({ goal: 'fresh', projectId: 1, epicId: null, dryRun: false }); // triggers prune
    expect(s.get(abandoned.id)).toBeNull();
  });
});
