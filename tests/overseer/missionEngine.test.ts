import { describe, it, expect, vi } from 'vitest';
import { openDb } from '../../src/store/db.js';
import { TaskStore } from '../../src/store/taskStore.js';
import { Readiness } from '../../src/store/readiness.js';
import { AgentStore } from '../../src/store/agentStore.js';
import { MissionStore } from '../../src/store/missionStore.js';
import { ProjectStore } from '../../src/store/projectStore.js';
import { SpawnService } from '../../src/spawn/spawn.js';
import { FakeTmuxDriver } from '../../src/tmux/fakeDriver.js';
import { MissionEngine } from '../../src/overseer/missionEngine.js';
import type { MissionEngineDeps } from '../../src/overseer/missionEngine.js';
import { EventBus } from '../../src/api/sse.js';
import { SystemClock } from '../../src/shared/clock.js';
import type { OrcaEvent } from '../../src/api/sse.js';

function setup(opts?: { summarize?: MissionEngineDeps['summarize'] }) {
  const db = openDb(':memory:'); db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'orca','/o')").run();
  const tasks = new TaskStore(db);
  tasks.create({ id: 'epic', project_id: 1, title: 'E', type: 'epic' });
  tasks.create({ id: 't1', project_id: 1, title: 'one', parent_id: 'epic', labels: ['exec:ollama-cloud/deepseek-v4-flash'] });
  tasks.create({ id: 't2', project_id: 1, title: 'two', parent_id: 'epic', labels: ['exec:ollama-cloud/deepseek-v4-flash'] });
  tasks.addDep('t2', 't1');
  const tmux = new FakeTmuxDriver();
  const bus = new EventBus();
  const engine = new MissionEngine({
    tasks, readiness: new Readiness(db), missions: new MissionStore(db),
    spawn: new SpawnService({ tmux, agents: new AgentStore(db) }), tmux, bus,
    projects: new ProjectStore(db), fallback: { program: 'claude-code', model: 'sonnet' },
    nameAgent: () => 'AgentX', clock: new SystemClock(), summarize: opts?.summarize,
  });
  return { tasks, tmux, engine, bus };
}

describe('MissionEngine', () => {
  it('reverts a task to open (and publishes it) when spawn.launch throws', async () => {
    const db = openDb(':memory:'); db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'orca','/o')").run();
    const tasks = new TaskStore(db);
    tasks.create({ id: 'epic', project_id: 1, title: 'E', type: 'epic' });
    tasks.create({ id: 't1', project_id: 1, title: 'one', parent_id: 'epic' });
    const bus = new EventBus();
    const events: OrcaEvent[] = []; bus.subscribe((e) => events.push(e));
    const engine = new MissionEngine({
      tasks, readiness: new Readiness(db), missions: new MissionStore(db),
      spawn: { launch: vi.fn().mockRejectedValue(new Error('tmux down')) } as unknown as SpawnService,
      tmux: new FakeTmuxDriver(), bus, projects: new ProjectStore(db),
      fallback: { program: 'claude-code', model: 'sonnet' }, nameAgent: () => 'AgentX', clock: new SystemClock(),
    });
    await engine.engage({ epicId: 'epic', autonomy: 'L3', maxSessions: 1 });
    expect(tasks.get('t1')!.status).toBe('open'); // rolled back — not left in_progress burning relaunch budget
    expect(events.some((e) => e.type === 'task' && e.taskId === 't1' && e.status === 'open')).toBe(true);
  });

  it('L1 (Assist) auto-spawns the ready head', async () => {
    const { tmux, engine } = setup();
    await engine.engage({ epicId: 'epic', autonomy: 'L1', maxSessions: 1 });
    expect(await tmux.list()).toContain('orca-AgentX'); // L1 dispatches work; the overseer gates its prompts later
  });

  it('L0 (Recommend) spawns nothing — the plan only gets proposed', async () => {
    const { tasks, tmux, engine } = setup();
    await engine.engage({ epicId: 'epic', autonomy: 'L0', maxSessions: 1 });
    expect(await tmux.list()).not.toContain('orca-AgentX');
    expect(tasks.get('t1')!.status).toBe('open'); // untouched
  });

  it('engages, spawns the ready head, advances on completion, auto-disengages', async () => {
    const { tasks, tmux, engine } = setup();
    const m = await engine.engage({ epicId: 'epic', autonomy: 'L3', maxSessions: 1 });
    expect(await tmux.list()).toContain('orca-AgentX'); // t1 spawned
    // simulate t1 done
    tasks.setStatus('t1', 'closed'); await tmux.kill('orca-AgentX');
    await engine.tick(m.id);
    expect(await tmux.list()).toContain('orca-AgentX'); // t2 spawned
    tasks.setStatus('t2', 'closed'); await tmux.kill('orca-AgentX');
    await engine.tick(m.id);
    expect(engine.isActive(m.id)).toBe(false); // auto-disengaged
  });

  it('on completion writes the overseer mission summary onto the epic before disengaging', async () => {
    const summarize = vi.fn().mockResolvedValue('Mise proběhla hladce, obě fáze hotové.');
    const { tasks, tmux, engine } = setup({ summarize });
    const m = await engine.engage({ epicId: 'epic', autonomy: 'L3', maxSessions: 1 });
    tasks.close('t1', { summary: 'first done', outcome: 'ok' }); await tmux.kill('orca-AgentX');
    await engine.tick(m.id); // spawns t2
    tasks.close('t2', { summary: 'second done', outcome: 'ok' }); await tmux.kill('orca-AgentX');
    await engine.tick(m.id); // completion → summarize + close epic + disengage
    // The overseer model is handed the goal + each phase's outcome/summary, and its prose is stamped on the epic.
    expect(summarize).toHaveBeenCalledTimes(1);
    expect(summarize).toHaveBeenCalledWith(expect.objectContaining({
      goal: 'E',
      phases: expect.arrayContaining([expect.objectContaining({ title: 'one', summary: 'first done' })]),
    }));
    const epic = tasks.get('epic')!;
    expect(epic.status).toBe('closed');
    expect(epic.result_summary).toBe('Mise proběhla hladce, obě fáze hotové.');
    expect(engine.isActive(m.id)).toBe(false);
  });

  it('falls back to a deterministic phase digest on completion when no summarizer is wired', async () => {
    const { tasks, tmux, engine } = setup(); // no summarize dep → engine synthesises the digest itself
    const m = await engine.engage({ epicId: 'epic', autonomy: 'L3', maxSessions: 1 });
    tasks.close('t1', { summary: 'wrote the parser', outcome: 'ok' }); await tmux.kill('orca-AgentX');
    await engine.tick(m.id);
    tasks.close('t2', { summary: 'added tests', outcome: 'ok' }); await tmux.kill('orca-AgentX');
    await engine.tick(m.id);
    const epic = tasks.get('epic')!;
    expect(epic.status).toBe('closed');
    expect(epic.result_summary).toContain('one'); // both phase titles surface in the digest
    expect(epic.result_summary).toContain('two');
  });

  it('does not count unrelated global orca- sessions against max_sessions', async () => {
    const { tmux, engine } = setup();
    await tmux.spawn('orca-OtherProject', { cwd: '/x', command: 'sleep 1' }); // foreign session
    const m = await engine.engage({ epicId: 'epic', autonomy: 'L3', maxSessions: 1 });
    expect(engine.isActive(m.id)).toBe(true);
    expect(await tmux.list()).toContain('orca-AgentX'); // head still spawned despite the foreign session
  });

  it('engage() publishes mission active event', async () => {
    const { engine, bus } = setup();
    const events: OrcaEvent[] = [];
    bus.subscribe(e => events.push(e));
    const m = await engine.engage({ epicId: 'epic', autonomy: 'L3', maxSessions: 1 });
    const missionEvents = events.filter(e => e.type === 'mission');
    expect(missionEvents[0]).toMatchObject({ type: 'mission', missionId: m.id, state: 'active' });
  });

  it('auto-disengage publishes mission disengaged event', async () => {
    const { tasks, tmux, engine, bus } = setup();
    const events: OrcaEvent[] = [];
    bus.subscribe(e => events.push(e));
    const m = await engine.engage({ epicId: 'epic', autonomy: 'L3', maxSessions: 1 });
    // close all tasks and tick to trigger auto-disengage
    tasks.setStatus('t1', 'closed'); await tmux.kill('orca-AgentX');
    await engine.tick(m.id);
    tasks.setStatus('t2', 'closed'); await tmux.kill('orca-AgentX');
    await engine.tick(m.id);
    const disengaged = events.filter(e => e.type === 'mission' && e.state === 'disengaged');
    expect(disengaged.length).toBeGreaterThanOrEqual(1);
    expect(disengaged[0]).toMatchObject({ type: 'mission', missionId: m.id, state: 'disengaged' });
  });

  it('disengage kills the running agent and reverts its task to open', async () => {
    const { tasks, tmux, engine } = setup();
    const m = await engine.engage({ epicId: 'epic', autonomy: 'L3', maxSessions: 1 });
    expect(await tmux.list()).toContain('orca-AgentX');
    expect(tasks.get('t1')!.status).toBe('in_progress');
    await engine.disengage(m.id);
    expect(await tmux.list()).not.toContain('orca-AgentX'); // session killed, not left running
    expect(tasks.get('t1')!.status).toBe('open');           // reverted so the UI no longer reads "running"
    expect(engine.isActive(m.id)).toBe(false);
  });

  it('pause stops the running agent and reverts its task (resume re-spawns it)', async () => {
    const { tasks, tmux, engine } = setup();
    const m = await engine.engage({ epicId: 'epic', autonomy: 'L3', maxSessions: 1 });
    await engine.pause(m.id);
    expect(await tmux.list()).not.toContain('orca-AgentX');
    expect(tasks.get('t1')!.status).toBe('open');
    expect(engine.isActive(m.id)).toBe(false); // paused, not active
  });

  it('stopRunning reverts every in_progress child even if a tmux.kill throws (O3)', async () => {
    const db = openDb(':memory:'); db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'orca','/o')").run();
    const tasks = new TaskStore(db);
    tasks.create({ id: 'epic', project_id: 1, title: 'E', type: 'epic' });
    tasks.create({ id: 'a', project_id: 1, title: 'a', parent_id: 'epic' });
    tasks.create({ id: 'b', project_id: 1, title: 'b', parent_id: 'epic' });
    // Two parallel in_progress children; the first session's kill rejects (it exited already).
    for (const id of ['a', 'b']) { tasks.setAgent(id, id); tasks.setStatus(id, 'in_progress'); }
    const base = new FakeTmuxDriver();
    await base.spawn('orca-a', { cwd: '/o', command: 'x' });
    await base.spawn('orca-b', { cwd: '/o', command: 'x' });
    // Minimal driver: the first kill rejects (session exited between list() and kill); the rest delegate.
    const tmux = { list: () => base.list(), kill: (s: string) => { if (s === 'orca-a') throw new Error('already gone'); return base.kill(s); } } as never;
    const engine = new MissionEngine({
      tasks, readiness: new Readiness(db), missions: new MissionStore(db),
      spawn: new SpawnService({ tmux, agents: new AgentStore(db) }), tmux, bus: new EventBus(),
      projects: new ProjectStore(db), fallback: { program: 'claude-code', model: 'sonnet' },
      nameAgent: () => 'AgentX', clock: new SystemClock(),
    });
    const stopped = await engine.stopRunning('epic');
    expect(stopped).toBe(2);
    expect(tasks.get('a')!.status).toBe('open'); // a throwing kill did NOT strand the rest in_progress
    expect(tasks.get('b')!.status).toBe('open');
  });

  it('disengage and pause are idempotent — a repeat call emits no second event (O6)', async () => {
    const { engine, bus } = setup();
    const events: OrcaEvent[] = [];
    const m = await engine.engage({ epicId: 'epic', autonomy: 'L3', maxSessions: 1 });
    bus.subscribe((e) => events.push(e));
    await engine.disengage(m.id);
    await engine.disengage(m.id); // no-op: already disengaged
    expect(events.filter((e) => e.type === 'mission' && e.state === 'disengaged')).toHaveLength(1);
  });

  it('pause is idempotent — a repeat call emits no second paused event (O6)', async () => {
    const { engine, bus } = setup();
    const events: OrcaEvent[] = [];
    const m = await engine.engage({ epicId: 'epic', autonomy: 'L3', maxSessions: 1 });
    bus.subscribe((e) => events.push(e));
    await engine.pause(m.id);
    await engine.pause(m.id); // no-op: already paused
    expect(events.filter((e) => e.type === 'mission' && e.state === 'paused')).toHaveLength(1);
  });
});

describe('MissionEngine overseer lifecycle', () => {
  function setup(overseer?: { start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>; ensure?: ReturnType<typeof vi.fn> }) {
    const db = openDb(':memory:'); db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'orca','/o')").run();
    const tasks = new TaskStore(db);
    tasks.create({ id: 'epic', project_id: 1, title: 'E', type: 'epic' });
    tasks.create({ id: 'g1', project_id: 1, title: 'Add auth login flow', parent_id: 'epic' });
    const tmux = new FakeTmuxDriver();
    const missions = new MissionStore(db);
    const engine = new MissionEngine({
      tasks, readiness: new Readiness(db), missions,
      spawn: new SpawnService({ tmux, agents: new AgentStore(db) }), tmux, bus: new EventBus(),
      projects: new ProjectStore(db), fallback: { program: 'claude-code', model: 'sonnet' },
      nameAgent: () => 'AgentX', clock: new SystemClock(),
      // Default a no-op ensure so partial {start,stop} mocks still satisfy the tick watchdog.
      overseer: overseer ? ({ ensure: vi.fn().mockResolvedValue(undefined), ...overseer } as never) : undefined,
    });
    return { tasks, tmux, engine, missions };
  }

  it('starts the overseer on engage', async () => {
    const start = vi.fn().mockResolvedValue(undefined);
    const stop = vi.fn().mockResolvedValue(undefined);
    const { engine } = setup({ start, stop });
    await engine.engage({ epicId: 'epic', autonomy: 'L3', maxSessions: 1 });
    expect(start).toHaveBeenCalledWith('m-epic', 1, '/o');
  });

  it('stops the overseer on disengage', async () => {
    const stop = vi.fn().mockResolvedValue(undefined);
    const { engine } = setup({ start: vi.fn().mockResolvedValue(undefined), stop });
    const m = await engine.engage({ epicId: 'epic', autonomy: 'L3', maxSessions: 1 });
    await engine.disengage(m.id);
    expect(stop).toHaveBeenCalledWith(m.id);
  });

  it('stops the overseer when a mission completes on its own (no leak)', async () => {
    const stop = vi.fn().mockResolvedValue(undefined);
    const { tasks, engine } = setup({ start: vi.fn().mockResolvedValue(undefined), stop });
    const m = await engine.engage({ epicId: 'epic', autonomy: 'L3', maxSessions: 1 });
    tasks.setStatus('g1', 'closed'); // the only child closes → next tick self-disengages
    await engine.tick(m.id);
    expect(engine.isActive(m.id)).toBe(false);
    expect(stop).toHaveBeenCalledWith(m.id);
  });

  it('re-parks the overseer on every tick (watchdog) so a died overseer is restored mid-mission', async () => {
    // The parked overseer can exit on its own (full context / clean exit per its prompt). Nothing else
    // re-parks it mid-mission, so its post-phase reviews would silently stop. The tick must keep it alive.
    const ensure = vi.fn().mockResolvedValue(undefined);
    const { engine } = setup({ start: vi.fn().mockResolvedValue(undefined), stop: vi.fn().mockResolvedValue(undefined), ensure });
    const m = await engine.engage({ epicId: 'epic', autonomy: 'L3', maxSessions: 1 });
    ensure.mockClear();
    await engine.tick(m.id);
    expect(ensure).toHaveBeenCalledWith(m.id, 1, '/o');
  });

  it('does not re-park the overseer for a mission that completes on this tick (it is being stopped)', async () => {
    const ensure = vi.fn().mockResolvedValue(undefined);
    const { tasks, engine } = setup({ start: vi.fn().mockResolvedValue(undefined), stop: vi.fn().mockResolvedValue(undefined), ensure });
    const m = await engine.engage({ epicId: 'epic', autonomy: 'L3', maxSessions: 1 });
    tasks.setStatus('g1', 'closed'); // all kids closed → this tick self-disengages
    ensure.mockClear();
    await engine.tick(m.id);
    expect(ensure).not.toHaveBeenCalled();
  });
});

describe('MissionEngine multi-project', () => {
  it('drives a mission in a non-home project and spawns in that project\'s path', async () => {
    const db = openDb(':memory:');
    db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'orca','/o')").run();
    db.prepare("INSERT INTO projects (id,slug,path) VALUES (2,'other','/p2')").run();
    const tasks = new TaskStore(db);
    tasks.create({ id: 'epic2', project_id: 2, title: 'E2', type: 'epic' });
    tasks.create({ id: 'x1', project_id: 2, title: 'work', parent_id: 'epic2', labels: ['exec:ollama-cloud/deepseek-v4-flash'] });
    const tmux = new FakeTmuxDriver();
    const engine = new MissionEngine({
      tasks, readiness: new Readiness(db), missions: new MissionStore(db),
      spawn: new SpawnService({ tmux, agents: new AgentStore(db) }), tmux, bus: new EventBus(),
      projects: new ProjectStore(db), fallback: { program: 'claude-code', model: 'sonnet' },
      nameAgent: () => 'AgentX', clock: new SystemClock(),
    });
    await engine.engage({ epicId: 'epic2', autonomy: 'L3', maxSessions: 1 });
    expect(await tmux.list()).toContain('orca-AgentX');
    expect(tmux.commandFor('orca-AgentX')).toContain('/p2'); // launched in project 2, not the home '/o'
    expect(tasks.get('x1')!.status).toBe('in_progress');
  });
});
