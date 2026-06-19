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
