import { describe, it, expect } from 'vitest';
import { PlanJobStore } from '../../src/overseer/planJob.js';

describe('PlanJobStore pruning (bounded memory)', () => {
  it('drops finished (done/failed) jobs older than the TTL, keeps in-flight ones', () => {
    let now = 0;
    const store = new PlanJobStore(() => now);

    // An old finished job.
    const a = store.create({ goal: 'a', projectId: 1, epicId: null, dryRun: false });
    store.setPhases(a.id, [{ title: 'P', type: 'task' }]); // → status 'done'

    // An old job still planning — must survive the prune.
    const b = store.create({ goal: 'b', projectId: 1, epicId: null, dryRun: false });

    // Advance past the TTL and create a new job to trigger prune().
    now = 11 * 60_000;
    const c = store.create({ goal: 'c', projectId: 1, epicId: null, dryRun: false });

    expect(store.get(a.id)).toBeNull();      // finished + expired → pruned
    expect(store.get(b.id)).not.toBeNull();  // still planning → kept
    expect(store.get(c.id)).not.toBeNull();  // fresh → kept
  });

  it('does not prune a recently-finished job', () => {
    let now = 0;
    const store = new PlanJobStore(() => now);
    const a = store.create({ goal: 'a', projectId: 1, epicId: null, dryRun: false });
    store.fail(a.id, 'boom');
    now = 60_000; // 1 min — under the 10 min TTL
    store.create({ goal: 'b', projectId: 1, epicId: null, dryRun: false });
    expect(store.get(a.id)).not.toBeNull();
  });
});
