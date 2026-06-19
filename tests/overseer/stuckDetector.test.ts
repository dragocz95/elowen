import { describe, it, expect } from 'vitest';
import { openDb } from '../../src/store/db.js';
import { TaskStore } from '../../src/store/taskStore.js';
import { FakeTmuxDriver } from '../../src/tmux/fakeDriver.js';
import { EventBus } from '../../src/api/sse.js';
import type { OrcaEvent } from '../../src/api/sse.js';
import { sweepStuckTasks, deadAgentTasks } from '../../src/overseer/stuckDetector.js';

const NOW = Date.parse('2026-06-18T12:00:00.000Z');

function setup() {
  const db = openDb(':memory:'); db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'orca','/o')").run();
  const tasks = new TaskStore(db);
  const tmux = new FakeTmuxDriver();
  const bus = new EventBus();
  const events: OrcaEvent[] = [];
  bus.subscribe((e) => events.push(e));
  // Mark a task running: agent label + precise start time + in_progress (mirrors the launch path).
  const start = (id: string, agent: string, startedMs: number) => {
    tasks.create({ id, project_id: 1, title: id });
    tasks.setAgent(id, agent);
    tasks.markStarted(id, startedMs);
    tasks.setStatus(id, 'in_progress');
  };
  return { tasks, tmux, bus, events, start };
}

describe('sweepStuckTasks', () => {
  it('reverts an in_progress task whose agent session is gone (past grace)', async () => {
    const { tasks, tmux, bus, events, start } = setup();
    start('t1', 'Ghost', NOW - 300_000); // started 5 min ago, no live session
    const r = await sweepStuckTasks({ tmux, tasks, bus, now: NOW, graceMs: 120_000, maxRelaunch: 2 });
    expect(r.reverted).toEqual(['t1']);
    expect(tasks.get('t1')!.status).toBe('open');
    expect(events.some((e) => e.type === 'task' && e.taskId === 't1' && e.status === 'open')).toBe(true);
  });

  it('leaves a task whose agent session is still live', async () => {
    const { tasks, tmux, bus, start } = setup();
    start('t1', 'Alive', NOW - 300_000);
    await tmux.spawn('orca-Alive', { cwd: '/o', command: 'x' });
    const r = await sweepStuckTasks({ tmux, tasks, bus, now: NOW, graceMs: 120_000, maxRelaunch: 2 });
    expect(r.reverted).toEqual([]);
    expect(tasks.get('t1')!.status).toBe('in_progress');
  });

  it('spares a freshly-spawned task within the grace window', async () => {
    const { tasks, tmux, bus, start } = setup();
    start('t1', 'Fresh', NOW - 10_000); // started 10s ago, session not up yet
    const r = await sweepStuckTasks({ tmux, tasks, bus, now: NOW, graceMs: 120_000, maxRelaunch: 2 });
    expect(r.reverted).toEqual([]);
    expect(tasks.get('t1')!.status).toBe('in_progress'); // not reaped mid-launch
  });

  it('escalates to blocked once the relaunch budget is exhausted', async () => {
    const { tasks, tmux, bus, start } = setup();
    start('t1', 'Crasher', NOW - 300_000);
    // maxRelaunch:1 → first death reverts (count 1), second death (count 2 > 1) escalates.
    let r = await sweepStuckTasks({ tmux, tasks, bus, now: NOW, graceMs: 120_000, maxRelaunch: 1 });
    expect(r.reverted).toEqual(['t1']);
    tasks.markStarted('t1', NOW - 300_000); tasks.setStatus('t1', 'in_progress'); // simulate re-spawn + crash
    r = await sweepStuckTasks({ tmux, tasks, bus, now: NOW, graceMs: 120_000, maxRelaunch: 1 });
    expect(r.escalated).toEqual(['t1']);
    expect(tasks.get('t1')!.status).toBe('blocked');
  });

  it('ignores tasks that are not in_progress', async () => {
    const { tasks, tmux, bus, start } = setup();
    start('t1', 'Done', NOW - 300_000); tasks.setStatus('t1', 'closed');
    const r = await sweepStuckTasks({ tmux, tasks, bus, now: NOW, graceMs: 120_000, maxRelaunch: 2 });
    expect(r.reverted).toEqual([]);
    expect(r.escalated).toEqual([]);
  });
});

describe('deadAgentTasks', () => {
  it('flags in_progress tasks with no live session (or no agent label)', () => {
    const db = openDb(':memory:'); db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'orca','/o')").run();
    const tasks = new TaskStore(db);
    tasks.create({ id: 'live', project_id: 1, title: 'l', labels: ['agent:Live'] });
    tasks.create({ id: 'dead', project_id: 1, title: 'd', labels: ['agent:Dead'] });
    tasks.create({ id: 'bare', project_id: 1, title: 'b' }); // no agent label
    const live = new Set(['orca-Live']);
    const dead = deadAgentTasks(live, [tasks.get('live')!, tasks.get('dead')!, tasks.get('bare')!]);
    expect(dead.map((t) => t.id).sort()).toEqual(['bare', 'dead']);
  });
});
