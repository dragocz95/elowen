import { describe, it, expect } from 'vitest';
import { openDb } from '../../src/store/db.js';
import { TaskStore } from '../../src/store/taskStore.js';
import { AgentStore } from '../../src/store/agentStore.js';
import { SpawnService } from '../../src/spawn/spawn.js';
import { ProjectStore } from '../../src/store/projectStore.js';
import { FakeTmuxDriver } from '../../src/tmux/fakeDriver.js';
import { EventBus } from '../../src/api/sse.js';
import { FakeClock } from '../../src/shared/clock.js';
import { Scheduler } from '../../src/overseer/scheduler.js';

function setup(now: number) {
  const db = openDb(':memory:'); db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'orca','/o')").run();
  const tasks = new TaskStore(db);
  const tmux = new FakeTmuxDriver();
  const spawn = new SpawnService({ tmux, agents: new AgentStore(db) });
  const scheduler = new Scheduler({ tasks, spawn, bus: new EventBus(), projects: new ProjectStore(db), fallback: { program: 'claude-code', model: 'sonnet' }, nameAgent: () => 'Nova', clock: new FakeClock(now) });
  return { tasks, tmux, scheduler };
}

describe('Scheduler', () => {
  it('launches a due autostart task once its scheduled_at has passed and clears the schedule', async () => {
    const t0 = Date.parse('2026-06-17T12:00:00.000Z');
    const { tasks, tmux, scheduler } = setup(t0 + 60_000); // now is one minute after the schedule
    tasks.create({ id: 'a', project_id: 1, title: 'Scheduled', scheduled_at: '2026-06-17T12:00:00.000Z', autostart: 1 });
    await scheduler.tick();
    expect(tasks.get('a')?.status).toBe('in_progress');
    expect(tasks.get('a')?.scheduled_at).toBeNull(); // consumed
    expect(await tmux.list()).toContain('orca-Nova');
  });


  it('does not launch a due task without autostart (due-date marker only)', async () => {
    const t0 = Date.parse('2026-06-17T12:00:00.000Z');
    const { tasks, tmux, scheduler } = setup(t0 + 60_000); // past the schedule
    tasks.create({ id: 'd', project_id: 1, title: 'Due but manual', scheduled_at: '2026-06-17T12:00:00.000Z' });
    await scheduler.tick();
    expect(tasks.get('d')?.status).toBe('open');
    expect(tasks.get('d')?.scheduled_at).toBe('2026-06-17T12:00:00.000Z'); // kept as a due date
    expect(await tmux.list()).toHaveLength(0);
  });

  it('does not launch a task scheduled in the future', async () => {
    const t0 = Date.parse('2026-06-17T12:00:00.000Z');
    const { tasks, tmux, scheduler } = setup(t0); // now is before the schedule
    tasks.create({ id: 'b', project_id: 1, title: 'Later', scheduled_at: '2026-06-17T18:00:00.000Z' });
    await scheduler.tick();
    expect(tasks.get('b')?.status).toBe('open');
    expect(await tmux.list()).toHaveLength(0);
  });

  it('ignores tasks without a schedule', async () => {
    const { tasks, scheduler } = setup(Date.parse('2026-06-17T12:00:00.000Z'));
    tasks.create({ id: 'c', project_id: 1, title: 'Unscheduled' });
    await scheduler.tick();
    expect(tasks.get('c')?.status).toBe('open');
  });

  it('fires a task scheduled with a non-UTC zone for the same instant (#39)', async () => {
    // 10:00+02:00 === 08:00Z. Lexically '2026-06-17T10:00:00+02:00' > the UTC `now` string, so the old
    // string compare would wrongly judge it not-due. Epoch compare gets the instant right.
    const now = Date.parse('2026-06-17T08:00:30.000Z'); // 30s after the scheduled instant
    const { tasks, scheduler } = setup(now);
    tasks.create({ id: 'tz', project_id: 1, title: 'Zoned', scheduled_at: '2026-06-17T10:00:00+02:00', autostart: 1 });
    await scheduler.tick();
    expect(tasks.get('tz')?.status).toBe('in_progress'); // due by absolute time despite the zone
    expect(tasks.get('tz')?.scheduled_at).toBeNull();
  });

  it('serializes due tasks that share a non-PR checkout — one agent at a time (C1)', async () => {
    // 5 due tasks in one project share its working tree. A shared checkout is single-writer (parallel
    // agents would clobber each other's edits and muddle per-task change attribution), so each tick
    // launches at most one; the rest stay open and fire on later ticks once the checkout frees.
    const t0 = Date.parse('2026-06-17T12:00:00.000Z');
    const db = openDb(':memory:'); db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'orca','/o')").run();
    const tasks = new TaskStore(db);
    const tmux = new FakeTmuxDriver();
    let n = 0;
    const scheduler = new Scheduler({ tasks, spawn: new SpawnService({ tmux, agents: new AgentStore(db) }), bus: new EventBus(), projects: new ProjectStore(db), fallback: { program: 'claude-code', model: 'sonnet' }, nameAgent: () => `N${n++}`, clock: new FakeClock(t0 + 60_000) });
    for (let i = 0; i < 5; i++) tasks.create({ id: `s${i}`, project_id: 1, title: `S${i}`, scheduled_at: '2026-06-17T12:00:00.000Z', autostart: 1 });
    await scheduler.tick();
    const live = () => ['s0', 's1', 's2', 's3', 's4'].filter((id) => tasks.get(id)?.status === 'in_progress');
    expect(live()).toHaveLength(1);              // only one agent in the shared checkout
    expect((await tmux.list()).length).toBe(1);
    await scheduler.tick();
    expect(live()).toHaveLength(1);              // still occupied — the next task waits
    tasks.setStatus(live()[0], 'closed');        // first agent finishes → checkout frees
    await scheduler.tick();
    expect(live()).toHaveLength(1);              // the next one fires now
  });

  it('flips a task to in_progress BEFORE the baseline await, so a concurrent tick sees the checkout busy', async () => {
    // Cross-tick gate correctness: the scheduler yields at the gitLock await while stamping the baseline.
    // If the task were still 'open' at that point, a concurrent mission/scheduler tick computing `busy`
    // from the in_progress list would miss it and launch a second agent into the same shared checkout.
    const t0 = Date.parse('2026-06-17T12:00:00.000Z');
    const db = openDb(':memory:'); db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'orca','/o')").run();
    const tasks = new TaskStore(db);
    const tmux = new FakeTmuxDriver();
    let statusAtAwait: string | undefined; // the task's status at the moment the lock body (first await) runs
    const gitLock = { run: async (_key: string, fn: () => Promise<unknown>) => { statusAtAwait = tasks.get('a')?.status; return fn(); } };
    const scheduler = new Scheduler({ tasks, spawn: new SpawnService({ tmux, agents: new AgentStore(db) }), bus: new EventBus(), projects: new ProjectStore(db), fallback: { program: 'claude-code', model: 'sonnet' }, nameAgent: () => 'Nova', clock: new FakeClock(t0 + 60_000), gitLock: gitLock as never });
    tasks.create({ id: 'a', project_id: 1, title: 'A', scheduled_at: '2026-06-17T12:00:00.000Z', autostart: 1 });
    await scheduler.tick();
    expect(statusAtAwait).toBe('in_progress'); // flipped before we yielded — the gate can't be raced across ticks
  });

  it('launches tasks in DIFFERENT projects concurrently — separate checkouts never block each other', async () => {
    const t0 = Date.parse('2026-06-17T12:00:00.000Z');
    const db = openDb(':memory:');
    db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'orca','/o')").run();
    db.prepare("INSERT INTO projects (id,slug,path) VALUES (2,'other','/p2')").run();
    const tasks = new TaskStore(db);
    const tmux = new FakeTmuxDriver();
    let n = 0;
    const scheduler = new Scheduler({ tasks, spawn: new SpawnService({ tmux, agents: new AgentStore(db) }), bus: new EventBus(), projects: new ProjectStore(db), fallback: { program: 'claude-code', model: 'sonnet' }, nameAgent: () => `N${n++}`, clock: new FakeClock(t0 + 60_000) });
    tasks.create({ id: 'a', project_id: 1, title: 'A', scheduled_at: '2026-06-17T12:00:00.000Z', autostart: 1 });
    tasks.create({ id: 'b', project_id: 2, title: 'B', scheduled_at: '2026-06-17T12:00:00.000Z', autostart: 1 });
    await scheduler.tick();
    expect(['a', 'b'].filter((id) => tasks.get(id)?.status === 'in_progress')).toHaveLength(2); // both fired — different checkouts
  });

  it('restores the schedule (and status open) when the spawn fails (O9)', async () => {
    const t0 = Date.parse('2026-06-17T12:00:00.000Z');
    const db = openDb(':memory:'); db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'orca','/o')").run();
    const tasks = new TaskStore(db);
    const failingSpawn = { launch: async () => { throw new Error('tmux down'); } };
    const scheduler = new Scheduler({ tasks, spawn: failingSpawn as never, bus: new EventBus(), projects: new ProjectStore(db), fallback: { program: 'claude-code', model: 'sonnet' }, nameAgent: () => 'Nova', clock: new FakeClock(t0 + 60_000) });
    tasks.create({ id: 'f', project_id: 1, title: 'Will fail', scheduled_at: '2026-06-17T12:00:00.000Z', autostart: 1 });
    await scheduler.tick();
    expect(tasks.get('f')?.status).toBe('open');                          // rolled back, not stuck in_progress
    expect(tasks.get('f')?.scheduled_at).toBe('2026-06-17T12:00:00.000Z'); // schedule restored → retries next tick
  });

  it('launches due autostart tasks across every project', async () => {
    const t0 = Date.parse('2026-06-17T12:00:00.000Z');
    const db = openDb(':memory:');
    db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'orca','/o')").run();
    db.prepare("INSERT INTO projects (id,slug,path) VALUES (2,'other','/p2')").run();
    const tasks = new TaskStore(db);
    const tmux = new FakeTmuxDriver();
    let n = 0;
    const scheduler = new Scheduler({ tasks, spawn: new SpawnService({ tmux, agents: new AgentStore(db) }), bus: new EventBus(), projects: new ProjectStore(db), fallback: { program: 'claude-code', model: 'sonnet' }, nameAgent: () => `N${n++}`, clock: new FakeClock(t0 + 60_000) });
    tasks.create({ id: 'p1t', project_id: 1, title: 'P1', scheduled_at: '2026-06-17T12:00:00.000Z', autostart: 1 });
    tasks.create({ id: 'p2t', project_id: 2, title: 'P2', scheduled_at: '2026-06-17T12:00:00.000Z', autostart: 1 });
    await scheduler.tick();
    expect(tasks.get('p1t')?.status).toBe('in_progress');
    expect(tasks.get('p2t')?.status).toBe('in_progress'); // a different project's task also fired
    expect(tmux.commandFor('orca-N1')).toContain('/p2'); // project 2 launched in its own path
  });
});
