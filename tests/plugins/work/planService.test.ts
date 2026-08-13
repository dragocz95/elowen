import { describe, it, expect } from 'vitest';
import { openDb } from '../../../src/store/db.js';
import { TaskStore } from '../../../plugins/work/src/store/taskStore.js';
import { ConfigStore } from '../../../src/store/configStore.js';
import type { ElowenEvent } from '../../../src/api/sse.js';
import { PlanJobStore } from '../../../plugins/work/src/api/planJobStore.js';
import { createPlanService } from '../../../plugins/work/src/api/planService.js';
import type { CreateTaskInput } from '../../../src/store/types.js';

function makeService() {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'elowen','/proj')").run();
  const tasks = new TaskStore(db);
  const events: ElowenEvent[] = [];
  const config = new ConfigStore(db);
  const planJobs = new PlanJobStore();
  const svc = createPlanService({
    tasks: () => tasks,
    planJobs: () => planJobs,
    planFlow: () => undefined, // agents plugin disabled — a plan is still an epic + its phases
    allowedExecs: () => config.get().allowedExecs,
    publishEvent: (e) => events.push(e),
    killSession: async () => {},
    pathFor: () => '/proj',
  });
  return { tasks, events, planJobs, svc };
}

describe('planService.persistPlan — atomicity (Tier 2 #15)', () => {
  it('rolls back the whole plan and publishes no events when a later phase fails to create', () => {
    const { tasks, events, planJobs, svc } = makeService();
    const job = planJobs.create({ goal: 'g', projectId: 1, epicId: null, dryRun: false, createdBy: null });
    job.phases = [
      { title: 'One', type: 'task' },
      { title: 'Two', type: 'task' },
      { title: 'Three', type: 'task' },
    ];

    // Force a failure creating the THIRD row written (epic = 1st, phase "One" = 2nd, phase "Two" = 3rd)
    // — a mid-plan disk error / id collision, exactly the scenario the review calls out.
    const originalCreate = tasks.create.bind(tasks);
    let calls = 0;
    tasks.create = ((input: CreateTaskInput) => {
      calls++;
      if (calls === 3) throw new Error('disk error');
      return originalCreate(input);
    }) as typeof tasks.create;

    expect(() => svc.persistPlan(job)).toThrow('disk error');
    // Nothing committed — not even the epic or phase "One", which were written before the failure.
    expect(tasks.list()).toEqual([]);
    // No event for a task the transaction rolled back — before the fix these fired inline, ahead of
    // the (later-failed) rest of the plan.
    expect(events).toEqual([]);
  });

  it('publishes one task event per created row only after the transaction commits', () => {
    const { tasks, events, planJobs, svc } = makeService();
    const job = planJobs.create({ goal: 'g', projectId: 1, epicId: null, dryRun: false, createdBy: null });
    job.phases = [{ title: 'One', type: 'task' }, { title: 'Two', type: 'task' }];

    const { epic, phases } = svc.persistPlan(job);
    expect(phases).toHaveLength(2);
    expect(tasks.get(epic.id)).not.toBeNull();
    const publishedIds = events.filter((e) => e.type === 'task').map((e) => (e as { taskId: string }).taskId);
    expect(publishedIds.sort()).toEqual([epic.id, ...phases.map((p) => p.id)].sort());
  });
});
