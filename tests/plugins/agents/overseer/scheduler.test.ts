import { describe, it, expect } from 'vitest';
import { projectHead, projectRangeDiff } from '../../../../src/integrations/projectFiles.js';

// The plugin engine/scheduler take read-only git helpers as a host seam; the core functions
// stand in (the same ones the pre-extraction core imported directly).
const gitSeam = { projectHead, projectRangeDiff };
import { render } from '../../../../src/prompts/index.js';
const promptSeam = { render: (n: string, v?: Record<string, string>) => render(n, v), rawTemplate: () => '' };
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { TaskStore } from '../../../../plugins/work/src/store/taskStore.js';
import { AgentStore } from '../../../../plugins/agents/src/store/agentStore.js';
import { SpawnService } from '../../../../plugins/agents/src/spawn/spawn.js';
import { ProjectStore } from '../../../../src/store/projectStore.js';
import { FakeTmuxDriver } from '../../../../src/tmux/fakeDriver.js';
import { EventBus } from '../../../../src/api/sse.js';
import { FakeClock } from '../../../../src/shared/clock.js';
import { Scheduler } from '../../../../plugins/agents/src/overseer/scheduler.js';
import { openAgentsDb } from '../../../helpers/agentsDb.js';

function setup(now: number) {
  const db = openAgentsDb(':memory:'); db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'elowen','/o')").run();
  const tasks = new TaskStore(db);
  const tmux = new FakeTmuxDriver();
  const spawn = new SpawnService({ prompts: promptSeam, tmux, agents: new AgentStore(db) });
  const scheduler = new Scheduler({ git: gitSeam, tasks, spawn, bus: new EventBus(), projects: new ProjectStore(db), fallback: { program: 'claude-code', model: 'sonnet' }, nameAgent: () => 'Nova', clock: new FakeClock(now) });
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
    expect(await tmux.list()).toContain('elowen-Nova');
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
    const db = openAgentsDb(':memory:'); db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'elowen','/o')").run();
    const tasks = new TaskStore(db);
    const tmux = new FakeTmuxDriver();
    let n = 0;
    const scheduler = new Scheduler({ git: gitSeam, tasks, spawn: new SpawnService({ prompts: promptSeam, tmux, agents: new AgentStore(db) }), bus: new EventBus(), projects: new ProjectStore(db), fallback: { program: 'claude-code', model: 'sonnet' }, nameAgent: () => `N${n++}`, clock: new FakeClock(t0 + 60_000) });
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
    const db = openAgentsDb(':memory:'); db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'elowen','/o')").run();
    const tasks = new TaskStore(db);
    const tmux = new FakeTmuxDriver();
    let statusAtAwait: string | undefined; // the task's status at the moment the lock body (first await) runs
    const gitLock = { run: async (_key: string, fn: () => Promise<unknown>) => { statusAtAwait = tasks.get('a')?.status; return fn(); } };
    const scheduler = new Scheduler({ git: gitSeam, tasks, spawn: new SpawnService({ prompts: promptSeam, tmux, agents: new AgentStore(db) }), bus: new EventBus(), projects: new ProjectStore(db), fallback: { program: 'claude-code', model: 'sonnet' }, nameAgent: () => 'Nova', clock: new FakeClock(t0 + 60_000), gitLock: gitLock as never });
    tasks.create({ id: 'a', project_id: 1, title: 'A', scheduled_at: '2026-06-17T12:00:00.000Z', autostart: 1 });
    await scheduler.tick();
    expect(statusAtAwait).toBe('in_progress'); // flipped before we yielded — the gate can't be raced across ticks
  });

  it('re-reads the busy set FRESH per task, so a checkout occupied mid-tick by another writer blocks a later task (C1 cross-tick)', async () => {
    // The scheduler and the mission engine tick concurrently. This reproduces the cross-tick race with a
    // single deterministic tick: while the scheduler is awaiting project 1's baseline (gitLock), another
    // writer claims project 2's checkout (flips x2 in_progress). A stale tick-start snapshot would miss
    // that and still launch project 2's due task; the fresh per-task read must hold it instead.
    const t0 = Date.parse('2026-06-17T12:00:00.000Z');
    const db = openAgentsDb(':memory:');
    db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'elowen','/o')").run();
    db.prepare("INSERT INTO projects (id,slug,path) VALUES (2,'other','/p2')").run();
    const tasks = new TaskStore(db);
    const tmux = new FakeTmuxDriver();
    tasks.create({ id: 'x2', project_id: 2, title: 'X2' }); // not due — just the checkout another writer claims
    tasks.create({ id: 'q', project_id: 1, title: 'Q', scheduled_at: '2026-06-17T12:00:00.000Z', autostart: 1 });
    tasks.create({ id: 'p', project_id: 2, title: 'P', scheduled_at: '2026-06-17T12:00:00.000Z', autostart: 1 });
    let flipped = false;
    const gitLock = { run: async (_key: string, fn: () => Promise<unknown>) => {
      if (!flipped) { flipped = true; tasks.setStatus('x2', 'in_progress'); } // /p2 claimed mid-tick, after the snapshot
      return fn();
    } };
    let n = 0;
    const scheduler = new Scheduler({ git: gitSeam, tasks, spawn: new SpawnService({ prompts: promptSeam, tmux, agents: new AgentStore(db) }), bus: new EventBus(), projects: new ProjectStore(db), fallback: { program: 'claude-code', model: 'sonnet' }, nameAgent: () => `N${n++}`, clock: new FakeClock(t0 + 60_000), gitLock: gitLock as never });
    await scheduler.tick();
    expect(tasks.get('q')?.status).toBe('in_progress'); // project 1 launched normally
    expect(tasks.get('p')?.status).toBe('open');        // project 2 was claimed mid-tick → fresh read holds it
  });

  it('launches tasks in DIFFERENT projects concurrently — separate checkouts never block each other', async () => {
    const t0 = Date.parse('2026-06-17T12:00:00.000Z');
    const db = openAgentsDb(':memory:');
    db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'elowen','/o')").run();
    db.prepare("INSERT INTO projects (id,slug,path) VALUES (2,'other','/p2')").run();
    const tasks = new TaskStore(db);
    const tmux = new FakeTmuxDriver();
    let n = 0;
    const scheduler = new Scheduler({ git: gitSeam, tasks, spawn: new SpawnService({ prompts: promptSeam, tmux, agents: new AgentStore(db) }), bus: new EventBus(), projects: new ProjectStore(db), fallback: { program: 'claude-code', model: 'sonnet' }, nameAgent: () => `N${n++}`, clock: new FakeClock(t0 + 60_000) });
    tasks.create({ id: 'a', project_id: 1, title: 'A', scheduled_at: '2026-06-17T12:00:00.000Z', autostart: 1 });
    tasks.create({ id: 'b', project_id: 2, title: 'B', scheduled_at: '2026-06-17T12:00:00.000Z', autostart: 1 });
    await scheduler.tick();
    expect(['a', 'b'].filter((id) => tasks.get(id)?.status === 'in_progress')).toHaveLength(2); // both fired — different checkouts
  });

  it('restores the schedule (and status open) when the spawn fails (O9)', async () => {
    const t0 = Date.parse('2026-06-17T12:00:00.000Z');
    const db = openAgentsDb(':memory:'); db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'elowen','/o')").run();
    const tasks = new TaskStore(db);
    const failingSpawn = { launch: async () => { throw new Error('tmux down'); } };
    const scheduler = new Scheduler({ git: gitSeam, tasks, spawn: failingSpawn as never, bus: new EventBus(), projects: new ProjectStore(db), fallback: { program: 'claude-code', model: 'sonnet' }, nameAgent: () => 'Nova', clock: new FakeClock(t0 + 60_000) });
    tasks.create({ id: 'f', project_id: 1, title: 'Will fail', scheduled_at: '2026-06-17T12:00:00.000Z', autostart: 1 });
    await scheduler.tick();
    expect(tasks.get('f')?.status).toBe('open');                          // rolled back, not stuck in_progress
    expect(tasks.get('f')?.scheduled_at).toBe('2026-06-17T12:00:00.000Z'); // schedule restored → retries next tick
  });

  it('does NOT republish change for a running task with no base label (no live-history thrash)', async () => {
    // Regression: a task in_progress without a `base:` label makes snapshotTaskChanges a no-op, so
    // head_sha stays null. The raw HEAD-vs-null compare would publish `change` every tick forever; the
    // re-read of the actually-stamped head_sha must keep it silent.
    const repo = mkdtempSync(join(tmpdir(), 'elowen-sched-'));
    const git = (...a: string[]) => execFileSync('git', ['-C', repo, ...a], { stdio: 'pipe' });
    git('init', '-q'); git('config', 'user.email', 't@t.io'); git('config', 'user.name', 'T');
    writeFileSync(join(repo, 'f.txt'), 'v0'); git('add', '-A'); git('commit', '-q', '-m', 'c0');
    try {
      const db = openAgentsDb(':memory:'); db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'r',?)").run(repo);
      const tasks = new TaskStore(db);
      const bus = new EventBus(); const changes: string[] = [];
      bus.subscribe((e) => { if (e.type === 'change') changes.push(e.taskId); });
      const scheduler = new Scheduler({ git: gitSeam, tasks, spawn: new SpawnService({ prompts: promptSeam, tmux: new FakeTmuxDriver(), agents: new AgentStore(db) }), bus, projects: new ProjectStore(db), fallback: { program: 'claude-code', model: 'sonnet' }, nameAgent: () => 'N', clock: new FakeClock(0) });
      tasks.create({ id: 'nb', project_id: 1, title: 'No base' }); tasks.setStatus('nb', 'in_progress');
      await scheduler.tick();
      await scheduler.tick();
      expect(changes).toEqual([]); // never thrashes
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });

  it('publishes a single change and refreshes the snapshot when a running task lands a new commit', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'elowen-sched-'));
    const git = (...a: string[]) => execFileSync('git', ['-C', repo, ...a], { stdio: 'pipe' });
    git('init', '-q'); git('config', 'user.email', 't@t.io'); git('config', 'user.name', 'T');
    writeFileSync(join(repo, 'f.txt'), 'v0'); git('add', '-A'); git('commit', '-q', '-m', 'c0');
    const base = git('rev-parse', 'HEAD').toString().trim();
    try {
      const db = openAgentsDb(':memory:'); db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'r',?)").run(repo);
      const tasks = new TaskStore(db);
      const bus = new EventBus(); const changes: string[] = [];
      bus.subscribe((e) => { if (e.type === 'change') changes.push(e.taskId); });
      const scheduler = new Scheduler({ git: gitSeam, tasks, spawn: new SpawnService({ prompts: promptSeam, tmux: new FakeTmuxDriver(), agents: new AgentStore(db) }), bus, projects: new ProjectStore(db), fallback: { program: 'claude-code', model: 'sonnet' }, nameAgent: () => 'N', clock: new FakeClock(0) });
      tasks.create({ id: 'wb', project_id: 1, title: 'With base' }); tasks.setStatus('wb', 'in_progress');
      tasks.markBase('wb', base);            // baseline stamped at spawn
      writeFileSync(join(repo, 'f.txt'), 'v1\nv2'); git('add', '-A'); git('commit', '-q', '-m', 'task commit');
      await scheduler.tick();
      expect(changes).toEqual(['wb']);                          // exactly one change
      expect(tasks.get('wb')?.changed_files.length).toBeGreaterThan(0); // snapshot refreshed mid-run
      await scheduler.tick();
      expect(changes).toEqual(['wb']);                          // HEAD unchanged → no republish
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });

  it('launches due autostart tasks across every project', async () => {
    const t0 = Date.parse('2026-06-17T12:00:00.000Z');
    const db = openAgentsDb(':memory:');
    db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'elowen','/o')").run();
    db.prepare("INSERT INTO projects (id,slug,path) VALUES (2,'other','/p2')").run();
    const tasks = new TaskStore(db);
    const tmux = new FakeTmuxDriver();
    let n = 0;
    const scheduler = new Scheduler({ git: gitSeam, tasks, spawn: new SpawnService({ prompts: promptSeam, tmux, agents: new AgentStore(db) }), bus: new EventBus(), projects: new ProjectStore(db), fallback: { program: 'claude-code', model: 'sonnet' }, nameAgent: () => `N${n++}`, clock: new FakeClock(t0 + 60_000) });
    tasks.create({ id: 'p1t', project_id: 1, title: 'P1', scheduled_at: '2026-06-17T12:00:00.000Z', autostart: 1 });
    tasks.create({ id: 'p2t', project_id: 2, title: 'P2', scheduled_at: '2026-06-17T12:00:00.000Z', autostart: 1 });
    await scheduler.tick();
    expect(tasks.get('p1t')?.status).toBe('in_progress');
    expect(tasks.get('p2t')?.status).toBe('in_progress'); // a different project's task also fired
    expect(tmux.commandFor('elowen-N1')).toContain('/p2'); // project 2 launched in its own path
  });
});
