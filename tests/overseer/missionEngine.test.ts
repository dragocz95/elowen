import { describe, it, expect } from 'vitest';
import { openDb } from '../../src/store/db.js';
import { TaskStore } from '../../src/store/taskStore.js';
import { Readiness } from '../../src/store/readiness.js';
import { AgentStore } from '../../src/store/agentStore.js';
import { MissionStore } from '../../src/store/missionStore.js';
import { ProjectStore } from '../../src/store/projectStore.js';
import { SpawnService } from '../../src/spawn/spawn.js';
import { FakeTmuxDriver } from '../../src/tmux/fakeDriver.js';
import { MissionEngine } from '../../src/overseer/missionEngine.js';
import { EventBus } from '../../src/api/sse.js';
import { SystemClock } from '../../src/shared/clock.js';
import type { OrcaEvent } from '../../src/api/sse.js';

function setup() {
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
    nameAgent: () => 'AgentX', clock: new SystemClock(),
  });
  return { tasks, tmux, engine, bus };
}

describe('MissionEngine', () => {
  it('engages, spawns the ready head, advances on completion, auto-disengages', async () => {
    const { tasks, tmux, engine } = setup();
    const m = await engine.engage({ epicId: 'epic', autonomy: 'L3', maxSessions: 1, clearedGuardrails: [] });
    expect(await tmux.list()).toContain('orca-AgentX'); // t1 spawned
    // simulate t1 done
    tasks.setStatus('t1', 'closed'); await tmux.kill('orca-AgentX');
    await engine.tick(m.id);
    expect(await tmux.list()).toContain('orca-AgentX'); // t2 spawned
    tasks.setStatus('t2', 'closed'); await tmux.kill('orca-AgentX');
    await engine.tick(m.id);
    expect(engine.isActive(m.id)).toBe(false); // auto-disengaged
  });

  it('does not count unrelated global orca- sessions against max_sessions', async () => {
    const { tmux, engine } = setup();
    await tmux.spawn('orca-OtherProject', { cwd: '/x', command: 'sleep 1' }); // foreign session
    const m = await engine.engage({ epicId: 'epic', autonomy: 'L3', maxSessions: 1, clearedGuardrails: [] });
    expect(engine.isActive(m.id)).toBe(true);
    expect(await tmux.list()).toContain('orca-AgentX'); // head still spawned despite the foreign session
  });

  it('engage() publishes mission active event', async () => {
    const { engine, bus } = setup();
    const events: OrcaEvent[] = [];
    bus.subscribe(e => events.push(e));
    const m = await engine.engage({ epicId: 'epic', autonomy: 'L3', maxSessions: 1, clearedGuardrails: [] });
    const missionEvents = events.filter(e => e.type === 'mission');
    expect(missionEvents[0]).toMatchObject({ type: 'mission', missionId: m.id, state: 'active' });
  });

  it('auto-disengage publishes mission disengaged event', async () => {
    const { tasks, tmux, engine, bus } = setup();
    const events: OrcaEvent[] = [];
    bus.subscribe(e => events.push(e));
    const m = await engine.engage({ epicId: 'epic', autonomy: 'L3', maxSessions: 1, clearedGuardrails: [] });
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
    const m = await engine.engage({ epicId: 'epic', autonomy: 'L3', maxSessions: 1, clearedGuardrails: [] });
    expect(await tmux.list()).toContain('orca-AgentX');
    expect(tasks.get('t1')!.status).toBe('in_progress');
    await engine.disengage(m.id);
    expect(await tmux.list()).not.toContain('orca-AgentX'); // session killed, not left running
    expect(tasks.get('t1')!.status).toBe('open');           // reverted so the UI no longer reads "running"
    expect(engine.isActive(m.id)).toBe(false);
  });

  it('pause stops the running agent and reverts its task (resume re-spawns it)', async () => {
    const { tasks, tmux, engine } = setup();
    const m = await engine.engage({ epicId: 'epic', autonomy: 'L3', maxSessions: 1, clearedGuardrails: [] });
    await engine.pause(m.id);
    expect(await tmux.list()).not.toContain('orca-AgentX');
    expect(tasks.get('t1')!.status).toBe('open');
    expect(engine.isActive(m.id)).toBe(false); // paused, not active
  });
});

describe('MissionEngine overseer gate (decideTask)', () => {
  function gateSetup(decideTask?: (i: { guardrails: string[] }) => Promise<{ approve: boolean; destructive: boolean }>) {
    const db = openDb(':memory:'); db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'orca','/o')").run();
    const tasks = new TaskStore(db);
    tasks.create({ id: 'epic', project_id: 1, title: 'E', type: 'epic' });
    // Title trips the 'auth' guardrail, so the gate is consulted once that guardrail is cleared.
    tasks.create({ id: 'g1', project_id: 1, title: 'Add auth login flow', parent_id: 'epic' });
    const tmux = new FakeTmuxDriver();
    const engine = new MissionEngine({
      tasks, readiness: new Readiness(db), missions: new MissionStore(db),
      spawn: new SpawnService({ tmux, agents: new AgentStore(db) }), tmux, bus: new EventBus(),
      projects: new ProjectStore(db), fallback: { program: 'claude-code', model: 'sonnet' },
      nameAgent: () => 'AgentX', clock: new SystemClock(),
      decideTask: decideTask as never,
    });
    return { tasks, tmux, engine };
  }

  it('escalates a guardrail-triggering task to blocked when the overseer denies', async () => {
    const { tasks, tmux, engine } = gateSetup(async () => ({ approve: false, destructive: false }));
    await engine.engage({ epicId: 'epic', autonomy: 'L3', maxSessions: 1, clearedGuardrails: ['auth'] });
    expect(tasks.get('g1')!.status).toBe('blocked'); // escalated, not spawned
    expect(await tmux.list()).not.toContain('orca-AgentX');
  });

  it('escalates when the overseer flags the task destructive even if it approves', async () => {
    const { tasks, tmux, engine } = gateSetup(async () => ({ approve: true, destructive: true }));
    await engine.engage({ epicId: 'epic', autonomy: 'L3', maxSessions: 1, clearedGuardrails: ['auth'] });
    expect(tasks.get('g1')!.status).toBe('blocked'); // destructive verdict escalates despite approve
    expect(await tmux.list()).not.toContain('orca-AgentX');
  });

  it('dispatches normally when the overseer approves', async () => {
    const { tasks, tmux, engine } = gateSetup(async () => ({ approve: true, destructive: false }));
    await engine.engage({ epicId: 'epic', autonomy: 'L3', maxSessions: 1, clearedGuardrails: ['auth'] });
    expect(tasks.get('g1')!.status).toBe('in_progress');
    expect(await tmux.list()).toContain('orca-AgentX');
  });

  it('is a no-op gate without a hook: cleared guardrail task spawns (unchanged behaviour)', async () => {
    const { tasks, tmux, engine } = gateSetup(undefined);
    await engine.engage({ epicId: 'epic', autonomy: 'L3', maxSessions: 1, clearedGuardrails: ['auth'] });
    expect(tasks.get('g1')!.status).toBe('in_progress');
    expect(await tmux.list()).toContain('orca-AgentX');
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
    await engine.engage({ epicId: 'epic2', autonomy: 'L3', maxSessions: 1, clearedGuardrails: [] });
    expect(await tmux.list()).toContain('orca-AgentX');
    expect(tmux.commandFor('orca-AgentX')).toContain('/p2'); // launched in project 2, not the home '/o'
    expect(tasks.get('x1')!.status).toBe('in_progress');
  });
});
