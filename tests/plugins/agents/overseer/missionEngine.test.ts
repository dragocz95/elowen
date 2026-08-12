import { describe, it, expect, vi } from 'vitest';
import { projectHead, projectRangeDiff } from '../../../../src/integrations/projectFiles.js';

// The plugin engine/scheduler take read-only git helpers as a host seam; the core functions
// stand in (the same ones the pre-extraction core imported directly).
const gitSeam = { projectHead, projectRangeDiff };
import { render } from '../../../../src/prompts/index.js';
const promptSeam = { render: (n: string, v?: Record<string, string>) => render(n, v), rawTemplate: () => '' };
import { TaskRefs } from '../../../../src/store/taskRefs.js';
import { TaskStore } from '../../../../plugins/work/src/store/taskStore.js';
import { Readiness } from '../../../../plugins/work/src/store/readiness.js';
import { AgentStore } from '../../../../plugins/agents/src/store/agentStore.js';
import { MissionStore } from '../../../../plugins/agents/src/store/missionStore.js';
import { ProjectStore } from '../../../../src/store/projectStore.js';
import { SpawnService } from '../../../../plugins/agents/src/spawn/spawn.js';
import { FakeTmuxDriver } from '../../../../src/tmux/fakeDriver.js';
import { MissionEngine } from '../../../../plugins/agents/src/overseer/missionEngine.js';
import type { MissionEngineDeps } from '../../../../plugins/agents/src/overseer/missionEngine.js';
import { EventBus } from '../../../../src/api/sse.js';
import { SystemClock } from '../../../../src/shared/clock.js';
import type { ElowenEvent } from '../../../../src/api/sse.js';
import { openAgentsDb } from '../../../helpers/agentsDb.js';

function setup(opts?: { summarize?: MissionEngineDeps['summarize'] }) {
  const db = openAgentsDb(':memory:'); db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'elowen','/o')").run();
  const tasks = new TaskStore(db);
  tasks.create({ id: 'epic', project_id: 1, title: 'E', type: 'epic' });
  tasks.create({ id: 't1', project_id: 1, title: 'one', parent_id: 'epic', labels: ['exec:ollama-cloud/deepseek-v4-flash'] });
  tasks.create({ id: 't2', project_id: 1, title: 'two', parent_id: 'epic', labels: ['exec:ollama-cloud/deepseek-v4-flash'] });
  tasks.addDep('t2', 't1');
  const tmux = new FakeTmuxDriver();
  const bus = new EventBus();
  const missions = new MissionStore(db);
  const engine = new MissionEngine({ git: gitSeam,
    tasks, taskRefs: new TaskRefs(db), readiness: new Readiness(db), missions,
    spawn: new SpawnService({ prompts: promptSeam, tmux, agents: new AgentStore(db) }), tmux, bus,
    projects: new ProjectStore(db), fallback: { program: 'claude-code', model: 'sonnet' },
    nameAgent: () => 'AgentX', clock: new SystemClock(), summarize: opts?.summarize,
  });
  return { tasks, tmux, engine, bus, missions };
}

describe('MissionEngine', () => {
  it('reverts a task to open (and publishes it) when spawn.launch throws', async () => {
    const db = openAgentsDb(':memory:'); db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'elowen','/o')").run();
    const tasks = new TaskStore(db);
    tasks.create({ id: 'epic', project_id: 1, title: 'E', type: 'epic' });
    tasks.create({ id: 't1', project_id: 1, title: 'one', parent_id: 'epic' });
    const bus = new EventBus();
    const events: ElowenEvent[] = []; bus.subscribe((e) => events.push(e));
    const engine = new MissionEngine({ git: gitSeam,
      tasks, taskRefs: new TaskRefs(db), readiness: new Readiness(db), missions: new MissionStore(db),
      spawn: { launch: vi.fn().mockRejectedValue(new Error('tmux down')) } as unknown as SpawnService,
      tmux: new FakeTmuxDriver(), bus, projects: new ProjectStore(db),
      fallback: { program: 'claude-code', model: 'sonnet' }, nameAgent: () => 'AgentX', clock: new SystemClock(),
    });
    await engine.engage({ epicId: 'epic', autonomy: 'L3', maxSessions: 1 });
    expect(tasks.get('t1')!.status).toBe('open'); // rolled back — not left in_progress burning relaunch budget
    expect(events.some((e) => e.type === 'task' && e.taskId === 't1' && e.status === 'open')).toBe(true);
  });

  it('engage clears a stale reviewfix budget so a re-engaged mission gets a fresh self-heal allowance', async () => {
    const { tasks, engine } = setup();
    tasks.addLabel('t1', 'reviewfix:2'); // left over from a prior aborted/buggy run
    await engine.engage({ epicId: 'epic', autonomy: 'L3', maxSessions: 1 });
    expect(tasks.get('t1')!.labels.some((l) => l.startsWith('reviewfix:'))).toBe(false); // reset → full budget again
  });

  it('publishes an in_progress task event after a successful spawn so the UI sees it running', async () => {
    const { tasks, engine, bus } = setup();
    const events: ElowenEvent[] = []; bus.subscribe((e) => events.push(e));
    await engine.engage({ epicId: 'epic', autonomy: 'L3', maxSessions: 1 });
    expect(tasks.get('t1')!.status).toBe('in_progress'); // t1 (no deps) was dispatched
    // Without the publish the DB flips to in_progress but the web cache never invalidates, so the task
    // stays hidden as "not running" until some unrelated event refreshes it.
    expect(events.some((e) => e.type === 'task' && e.taskId === 't1' && e.status === 'in_progress')).toBe(true);
  });

  it('serializes ready phases that share a non-PR checkout, even with max_sessions > 1 (C1)', async () => {
    const db = openAgentsDb(':memory:'); db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'elowen','/o')").run();
    const tasks = new TaskStore(db);
    tasks.create({ id: 'epic', project_id: 1, title: 'E', type: 'epic' });
    // Two independent (no dep) phases → both dependency-cleared and ready at once.
    tasks.create({ id: 'a', project_id: 1, title: 'A', parent_id: 'epic', labels: ['exec:ollama-cloud/deepseek-v4-flash'] });
    tasks.create({ id: 'b', project_id: 1, title: 'B', parent_id: 'epic', labels: ['exec:ollama-cloud/deepseek-v4-flash'] });
    let n = 0;
    const engine = new MissionEngine({ git: gitSeam,
      tasks, taskRefs: new TaskRefs(db), readiness: new Readiness(db), missions: new MissionStore(db),
      spawn: new SpawnService({ prompts: promptSeam, tmux: new FakeTmuxDriver(), agents: new AgentStore(db) }), tmux: new FakeTmuxDriver(),
      bus: new EventBus(), projects: new ProjectStore(db), fallback: { program: 'claude-code', model: 'sonnet' },
      nameAgent: () => `A${n++}`, clock: new SystemClock(),
    });
    await engine.engage({ epicId: 'epic', autonomy: 'L3', maxSessions: 2 }); // budget would allow 2 in parallel
    const live = ['a', 'b'].filter((id) => tasks.get(id)?.status === 'in_progress');
    expect(live).toHaveLength(1); // non-PR phases share project.path → serialized to one, despite max_sessions: 2
  });

  it('coalesces a tick requested while one is already in flight into exactly one extra pass (M1)', async () => {
    const db = openAgentsDb(':memory:'); db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'elowen','/o')").run();
    const tasks = new TaskStore(db);
    tasks.create({ id: 'epic', project_id: 1, title: 'E', type: 'epic' });
    tasks.create({ id: 't1', project_id: 1, title: 'one', parent_id: 'epic' });
    let ensureCalls = 0; // overseer.ensure runs once per tickOnce → a proxy for how many passes ran
    const overseer = { start: async () => {}, ensure: async () => { ensureCalls++; }, stop: async () => {} };
    const engine = new MissionEngine({ git: gitSeam,
      tasks, taskRefs: new TaskRefs(db), readiness: new Readiness(db), missions: new MissionStore(db),
      spawn: new SpawnService({ prompts: promptSeam, tmux: new FakeTmuxDriver(), agents: new AgentStore(db) }), tmux: new FakeTmuxDriver(),
      bus: new EventBus(), projects: new ProjectStore(db), fallback: { program: 'claude-code', model: 'sonnet' },
      nameAgent: () => 'A0', clock: new SystemClock(), overseer,
    });
    await engine.engage({ epicId: 'epic', autonomy: 'L3', maxSessions: 1 });
    ensureCalls = 0; // ignore the engage tick
    // Two ticks fired together: the 2nd lands while the 1st is in flight. It must not be dropped (which
    // would delay freed work up to 90s) — it coalesces into one extra pass after the 1st completes.
    await Promise.all([engine.tick('m-epic'), engine.tick('m-epic')]);
    expect(ensureCalls).toBe(2);
  });

  it('keeps review self-heal budgets on a PR-feedback re-engage but resets them on a fresh engage (M3)', async () => {
    const db = openAgentsDb(':memory:'); db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'elowen','/o')").run();
    const tasks = new TaskStore(db);
    tasks.create({ id: 'epic', project_id: 1, title: 'E', type: 'epic' });
    tasks.create({ id: 'a', project_id: 1, title: 'A', parent_id: 'epic', status: 'closed' }); // a finished phase…
    tasks.bumpReviewFix('a'); tasks.bumpReviewFix('a');                                          // …that burned 2 retries
    const hasBudget = () => tasks.get('a')!.labels.some((l) => l.startsWith('reviewfix:'));
    const engine = new MissionEngine({ git: gitSeam,
      tasks, taskRefs: new TaskRefs(db), readiness: new Readiness(db), missions: new MissionStore(db),
      spawn: new SpawnService({ prompts: promptSeam, tmux: new FakeTmuxDriver(), agents: new AgentStore(db) }), tmux: new FakeTmuxDriver(),
      bus: new EventBus(), projects: new ProjectStore(db), fallback: { program: 'claude-code', model: 'sonnet' },
      nameAgent: () => 'A0', clock: new SystemClock(),
    });
    await engine.engage({ epicId: 'epic', autonomy: 'L3', maxSessions: 1, preserveReviewBudget: true });
    expect(hasBudget()).toBe(true);  // PR-feedback continuation must NOT hand the burned phase a fresh budget
    await engine.engage({ epicId: 'epic', autonomy: 'L3', maxSessions: 1 });
    expect(hasBudget()).toBe(false); // a fresh engage clears stale reviewfix labels as before
  });

  it('stopTask kills the worker session of a single task so a re-open re-spawns cleanly', async () => {
    const { tasks, tmux, engine } = setup();
    tasks.setAgent('t1', 'Worker1');
    await tmux.spawn('elowen-Worker1', { command: 'sleep', cwd: '/o' });
    expect(await tmux.list()).toContain('elowen-Worker1');
    await engine.stopTask('t1'); // a worker that outlived its task close must be reaped before re-spawn
    expect(await tmux.list()).not.toContain('elowen-Worker1');
  });

  it('stopTask is a no-op for a task with no agent label or no live session', async () => {
    const { engine, tmux } = setup();
    await engine.stopTask('t2');                      // t2 has no agent label
    await engine.stopTask('missing');                 // task does not exist
    expect(await tmux.list()).toEqual([]);            // nothing killed, nothing thrown
  });

  it('a stalled (escalated) mission is frozen — a tick spawns nothing and leaves it stalled', async () => {
    const { engine, tmux, missions } = setup();
    missions.create({ id: 'm-epic', epic_id: 'epic', autonomy: 'L3', max_sessions: 1 });
    missions.setState('m-epic', 'stalled'); // escalated → waiting on a human
    await engine.tick('m-epic');
    expect(await tmux.list()).toEqual([]);                  // frozen: the ready head (t1) is NOT spawned
    expect(missions.get('m-epic')!.state).toBe('stalled');  // still frozen, no churn
  });

  it('resumeStalled un-freezes a stalled mission and ticks so the freed head spawns', async () => {
    const { engine, tmux, missions, bus } = setup();
    const events: ElowenEvent[] = []; bus.subscribe((e) => events.push(e));
    missions.create({ id: 'm-epic', epic_id: 'epic', autonomy: 'L3', max_sessions: 1 });
    missions.setState('m-epic', 'stalled');
    await engine.resumeStalled('m-epic');
    expect(missions.get('m-epic')!.state).toBe('active');                                  // un-frozen
    expect(events.some((e) => e.type === 'mission' && e.state === 'active')).toBe(true);   // announced
    expect(await tmux.list()).toContain('elowen-AgentX');                                    // ready head spawned
  });

  it('resumeStalled never resurrects a disengaged mission', async () => {
    const { engine, tmux, missions } = setup();
    missions.create({ id: 'm-epic', epic_id: 'epic', autonomy: 'L3', max_sessions: 1 });
    missions.setState('m-epic', 'disengaged');
    await engine.resumeStalled('m-epic');
    expect(missions.get('m-epic')!.state).toBe('disengaged'); // not flipped to active
    expect(await tmux.list()).toEqual([]);                    // and nothing spawned
  });

  it('L1 (Assist) auto-spawns the ready head', async () => {
    const { tmux, engine } = setup();
    await engine.engage({ epicId: 'epic', autonomy: 'L1', maxSessions: 1 });
    expect(await tmux.list()).toContain('elowen-AgentX'); // L1 dispatches work; the overseer gates its prompts later
  });

  it('picks a worker name clear of a lingering session (no duplicate-session crash)', async () => {
    const { tmux, engine } = setup();
    await tmux.spawn('elowen-AgentX', { cwd: '/o', command: 'zombie' }); // a stale worker session lingers
    await engine.engage({ epicId: 'epic', autonomy: 'L3', maxSessions: 1 });
    const live = await tmux.list();
    // The new worker avoids the live name entirely — its session is a distinct, non-colliding handle…
    const fresh = live.filter((s) => s !== 'elowen-AgentX' && s.startsWith('elowen-AgentX'));
    expect(fresh).toHaveLength(1);
    expect(fresh[0]).not.toBe('elowen-AgentX'); // …so `tmux new-session` can never see a duplicate
  });

  it('L0 (Recommend) spawns nothing — the plan only gets proposed', async () => {
    const { tasks, tmux, engine } = setup();
    await engine.engage({ epicId: 'epic', autonomy: 'L0', maxSessions: 1 });
    expect(await tmux.list()).not.toContain('elowen-AgentX');
    expect(tasks.get('t1')!.status).toBe('open'); // untouched
  });

  it('engages, spawns the ready head, advances on completion, auto-disengages', async () => {
    const { tasks, tmux, engine } = setup();
    const m = await engine.engage({ epicId: 'epic', autonomy: 'L3', maxSessions: 1 });
    expect(await tmux.list()).toContain('elowen-AgentX'); // t1 spawned
    // simulate t1 done
    tasks.setStatus('t1', 'closed'); await tmux.kill('elowen-AgentX');
    await engine.tick(m.id);
    expect(await tmux.list()).toContain('elowen-AgentX'); // t2 spawned
    tasks.setStatus('t2', 'closed'); await tmux.kill('elowen-AgentX');
    await engine.tick(m.id);
    expect(engine.isActive(m.id)).toBe(false); // auto-disengaged
  });

  it('on completion writes the overseer mission summary onto the epic before disengaging', async () => {
    const summarize = vi.fn().mockResolvedValue('Mise proběhla hladce, obě fáze hotové.');
    const { tasks, tmux, engine } = setup({ summarize });
    const m = await engine.engage({ epicId: 'epic', autonomy: 'L3', maxSessions: 1 });
    tasks.close('t1', { summary: 'first done', outcome: 'ok' }); await tmux.kill('elowen-AgentX');
    await engine.tick(m.id); // spawns t2
    tasks.close('t2', { summary: 'second done', outcome: 'ok' }); await tmux.kill('elowen-AgentX');
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
    tasks.close('t1', { summary: 'wrote the parser', outcome: 'ok' }); await tmux.kill('elowen-AgentX');
    await engine.tick(m.id);
    tasks.close('t2', { summary: 'added tests', outcome: 'ok' }); await tmux.kill('elowen-AgentX');
    await engine.tick(m.id);
    const epic = tasks.get('epic')!;
    expect(epic.status).toBe('closed');
    expect(epic.result_summary).toContain('one'); // both phase titles surface in the digest
    expect(epic.result_summary).toContain('two');
  });

  it('does not count unrelated global elowen- sessions against max_sessions', async () => {
    const { tmux, engine } = setup();
    await tmux.spawn('elowen-OtherProject', { cwd: '/x', command: 'sleep 1' }); // foreign session
    const m = await engine.engage({ epicId: 'epic', autonomy: 'L3', maxSessions: 1 });
    expect(engine.isActive(m.id)).toBe(true);
    expect(await tmux.list()).toContain('elowen-AgentX'); // head still spawned despite the foreign session
  });

  it('engage() publishes mission active event', async () => {
    const { engine, bus } = setup();
    const events: ElowenEvent[] = [];
    bus.subscribe(e => events.push(e));
    const m = await engine.engage({ epicId: 'epic', autonomy: 'L3', maxSessions: 1 });
    const missionEvents = events.filter(e => e.type === 'mission');
    expect(missionEvents[0]).toMatchObject({ type: 'mission', missionId: m.id, state: 'active' });
  });

  it('auto-disengage publishes mission disengaged event', async () => {
    const { tasks, tmux, engine, bus } = setup();
    const events: ElowenEvent[] = [];
    bus.subscribe(e => events.push(e));
    const m = await engine.engage({ epicId: 'epic', autonomy: 'L3', maxSessions: 1 });
    // close all tasks and tick to trigger auto-disengage
    tasks.setStatus('t1', 'closed'); await tmux.kill('elowen-AgentX');
    await engine.tick(m.id);
    tasks.setStatus('t2', 'closed'); await tmux.kill('elowen-AgentX');
    await engine.tick(m.id);
    const disengaged = events.filter(e => e.type === 'mission' && e.state === 'disengaged');
    expect(disengaged.length).toBeGreaterThanOrEqual(1);
    expect(disengaged[0]).toMatchObject({ type: 'mission', missionId: m.id, state: 'disengaged' });
  });

  it('disengage kills the running agent and reverts its task to open', async () => {
    const { tasks, tmux, engine } = setup();
    const m = await engine.engage({ epicId: 'epic', autonomy: 'L3', maxSessions: 1 });
    expect(await tmux.list()).toContain('elowen-AgentX');
    expect(tasks.get('t1')!.status).toBe('in_progress');
    await engine.disengage(m.id);
    expect(await tmux.list()).not.toContain('elowen-AgentX'); // session killed, not left running
    expect(tasks.get('t1')!.status).toBe('open');           // reverted so the UI no longer reads "running"
    expect(engine.isActive(m.id)).toBe(false);
  });

  it('pause stops the running agent and reverts its task (resume re-spawns it)', async () => {
    const { tasks, tmux, engine } = setup();
    const m = await engine.engage({ epicId: 'epic', autonomy: 'L3', maxSessions: 1 });
    await engine.pause(m.id);
    expect(await tmux.list()).not.toContain('elowen-AgentX');
    expect(tasks.get('t1')!.status).toBe('open');
    expect(engine.isActive(m.id)).toBe(false); // paused, not active
  });

  /** Two parallel in_progress children whose sessions are live; `kill` misbehaves for `elowen-a` per
   *  the injected `killA` (which may or may not actually end the session). */
  async function stopRunningSetup(killA: (base: FakeTmuxDriver) => void | Promise<void>) {
    const db = openAgentsDb(':memory:'); db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'elowen','/o')").run();
    const tasks = new TaskStore(db);
    tasks.create({ id: 'epic', project_id: 1, title: 'E', type: 'epic' });
    tasks.create({ id: 'a', project_id: 1, title: 'a', parent_id: 'epic' });
    tasks.create({ id: 'b', project_id: 1, title: 'b', parent_id: 'epic' });
    for (const id of ['a', 'b']) { tasks.setAgent(id, id); tasks.setStatus(id, 'in_progress'); }
    const base = new FakeTmuxDriver();
    await base.spawn('elowen-a', { cwd: '/o', command: 'x' });
    await base.spawn('elowen-b', { cwd: '/o', command: 'x' });
    const tmux = {
      list: () => base.list(),
      kill: async (s: string) => { if (s === 'elowen-a') return killA(base); return base.kill(s); },
    } as never;
    const engine = new MissionEngine({ git: gitSeam,
      tasks, taskRefs: new TaskRefs(db), readiness: new Readiness(db), missions: new MissionStore(db),
      spawn: new SpawnService({ prompts: promptSeam, tmux, agents: new AgentStore(db) }), tmux, bus: new EventBus(),
      projects: new ProjectStore(db), fallback: { program: 'claude-code', model: 'sonnet' },
      nameAgent: () => 'AgentX', clock: new SystemClock(),
    });
    return { tasks, base, engine };
  }

  it('stopRunning reverts a child whose session really did exit, even if its kill threw (O3)', async () => {
    // The session exited between list() and kill, so the driver rejects — the agent is genuinely gone.
    const { tasks, engine } = await stopRunningSetup(async (base) => {
      await base.kill('elowen-a');
      throw new Error('already gone');
    });
    const stopped = await engine.stopRunning('epic');
    expect(stopped).toBe(2);
    expect(tasks.get('a')!.status).toBe('open'); // a throwing kill did NOT strand the rest in_progress
    expect(tasks.get('b')!.status).toBe('open');
  });

  it('stopRunning leaves a child in_progress when its session survived the kill', async () => {
    // The kill failed for real (tmux unreachable): the agent is STILL writing in the checkout, so
    // advertising the task as 'open' would let a resume put a second agent on the same files.
    const { tasks, base, engine } = await stopRunningSetup(() => { throw new Error('tmux unreachable'); });
    const stopped = await engine.stopRunning('epic');
    expect(stopped).toBe(1);
    expect(await base.list()).toContain('elowen-a');
    expect(tasks.get('a')!.status).toBe('in_progress'); // not reverted while its agent is alive
    expect(tasks.get('b')!.status).toBe('open');        // the healthy sibling is still stopped
  });

  it('disengage and pause are idempotent — a repeat call emits no second event (O6)', async () => {
    const { engine, bus } = setup();
    const events: ElowenEvent[] = [];
    const m = await engine.engage({ epicId: 'epic', autonomy: 'L3', maxSessions: 1 });
    bus.subscribe((e) => events.push(e));
    await engine.disengage(m.id);
    await engine.disengage(m.id); // no-op: already disengaged
    expect(events.filter((e) => e.type === 'mission' && e.state === 'disengaged')).toHaveLength(1);
  });

  it('pause is idempotent — a repeat call emits no second paused event (O6)', async () => {
    const { engine, bus } = setup();
    const events: ElowenEvent[] = [];
    const m = await engine.engage({ epicId: 'epic', autonomy: 'L3', maxSessions: 1 });
    bus.subscribe((e) => events.push(e));
    await engine.pause(m.id);
    await engine.pause(m.id); // no-op: already paused
    expect(events.filter((e) => e.type === 'mission' && e.state === 'paused')).toHaveLength(1);
  });
});

describe('MissionEngine overseer lifecycle', () => {
  function setup(overseer?: { start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>; ensure?: ReturnType<typeof vi.fn> }) {
    const db = openAgentsDb(':memory:'); db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'elowen','/o')").run();
    const tasks = new TaskStore(db);
    tasks.create({ id: 'epic', project_id: 1, title: 'E', type: 'epic' });
    tasks.create({ id: 'g1', project_id: 1, title: 'Add auth login flow', parent_id: 'epic' });
    const tmux = new FakeTmuxDriver();
    const missions = new MissionStore(db);
    const engine = new MissionEngine({ git: gitSeam,
      tasks, taskRefs: new TaskRefs(db), readiness: new Readiness(db), missions,
      spawn: new SpawnService({ prompts: promptSeam, tmux, agents: new AgentStore(db) }), tmux, bus: new EventBus(),
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
    const db = openAgentsDb(':memory:');
    db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'elowen','/o')").run();
    db.prepare("INSERT INTO projects (id,slug,path) VALUES (2,'other','/p2')").run();
    const tasks = new TaskStore(db);
    tasks.create({ id: 'epic2', project_id: 2, title: 'E2', type: 'epic' });
    tasks.create({ id: 'x1', project_id: 2, title: 'work', parent_id: 'epic2', labels: ['exec:ollama-cloud/deepseek-v4-flash'] });
    const tmux = new FakeTmuxDriver();
    const engine = new MissionEngine({ git: gitSeam,
      tasks, taskRefs: new TaskRefs(db), readiness: new Readiness(db), missions: new MissionStore(db),
      spawn: new SpawnService({ prompts: promptSeam, tmux, agents: new AgentStore(db) }), tmux, bus: new EventBus(),
      projects: new ProjectStore(db), fallback: { program: 'claude-code', model: 'sonnet' },
      nameAgent: () => 'AgentX', clock: new SystemClock(),
    });
    await engine.engage({ epicId: 'epic2', autonomy: 'L3', maxSessions: 1 });
    expect(await tmux.list()).toContain('elowen-AgentX');
    expect(tmux.commandFor('elowen-AgentX')).toContain('/p2'); // launched in project 2, not the home '/o'
    expect(tasks.get('x1')!.status).toBe('in_progress');
  });
});
