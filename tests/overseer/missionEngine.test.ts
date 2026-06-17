import { describe, it, expect } from 'vitest';
import { openDb } from '../../src/store/db.js';
import { TaskStore } from '../../src/store/taskStore.js';
import { Readiness } from '../../src/store/readiness.js';
import { AgentStore } from '../../src/store/agentStore.js';
import { MissionStore } from '../../src/store/missionStore.js';
import { SpawnService } from '../../src/spawn/spawn.js';
import { FakeTmuxDriver } from '../../src/tmux/fakeDriver.js';
import { MissionEngine } from '../../src/overseer/missionEngine.js';
import { EventBus } from '../../src/api/sse.js';
import type { OrcaEvent } from '../../src/api/sse.js';

function setup() {
  const db = openDb(':memory:'); db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'orca','/o')").run();
  const tasks = new TaskStore(db);
  tasks.create({ id: 'epic', project_id: 1, title: 'E', type: 'epic' });
  tasks.create({ id: 't1', project_id: 1, title: 'one', parent_id: 'epic', labels: ['exec:ollama/deepseek-v4-flash'] });
  tasks.create({ id: 't2', project_id: 1, title: 'two', parent_id: 'epic', labels: ['exec:ollama/deepseek-v4-flash'] });
  tasks.addDep('t2', 't1');
  const tmux = new FakeTmuxDriver();
  const bus = new EventBus();
  const engine = new MissionEngine({
    tasks, readiness: new Readiness(db), missions: new MissionStore(db),
    spawn: new SpawnService({ tmux, agents: new AgentStore(db) }), tmux, bus,
    project: { id: 1, path: '/o' }, fallback: { program: 'claude-code', model: 'sonnet' },
    nameAgent: () => 'AgentX',
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
});
