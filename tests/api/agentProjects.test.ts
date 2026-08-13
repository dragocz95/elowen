import { describe, it, expect } from 'vitest';
import { TaskRefs } from '../../src/store/taskRefs.js';
import { TaskStore } from '../../plugins/work/src/store/taskStore.js';
import { Readiness } from '../../plugins/work/src/store/readiness.js';
import { MissionStore } from '../../plugins/agents/src/store/missionStore.js';
import { EventBus } from '../../src/api/sse.js';
import { createRouteContext } from '../../src/api/context.js';
import { FakeClock } from '../../src/shared/clock.js';
import { ConfigStore } from '../../src/store/configStore.js';
import { openPluginTablesDb } from '../helpers/pluginTablesDb.js';

// agentProjects() is the confinement boundary for agent-scoped tokens (canAccessProject /
// accessibleProjects never admin-bypass them). It was rewritten from a per-mission/per-child
// `tasks.get()` N+1 to a single `tasks.list()` pass — this pins the exact set it must keep
// returning across that rewrite, group by group.
function setup() {
  const db = openPluginTablesDb(':memory:');
  db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'p1','/p1')").run();
  db.prepare("INSERT INTO projects (id,slug,path) VALUES (2,'p2','/p2')").run();
  db.prepare("INSERT INTO projects (id,slug,path) VALUES (3,'p3','/p3')").run();
  db.prepare("INSERT INTO projects (id,slug,path) VALUES (4,'p4','/p4')").run();
  const tasks = new TaskStore(db);
  const missions = new MissionStore(db);
  const ctx = createRouteContext({
    tasks, taskRefs: new TaskRefs(db), readiness: new Readiness(db), missions, bus: new EventBus(),
    engine: null as never, spawn: null as never, tmux: null as never,
    project: { id: 1, path: '/p1' }, fallback: { program: 'claude-code', model: 'sonnet' },
    clock: new FakeClock(0), config: new ConfigStore(db),
  });
  return { tasks, missions, ctx };
}

describe('agentProjects()', () => {
  it('includes the project of an in-progress agent-labelled task', () => {
    const { tasks, ctx } = setup();
    tasks.create({ id: 't1', project_id: 1, title: 'working' });
    tasks.setAgent('t1', 'Nova');
    tasks.setStatus('t1', 'in_progress');
    expect(ctx.agentProjects()).toEqual(new Set([1]));
  });

  it('excludes an in-progress task with no agent: label', () => {
    const { tasks, ctx } = setup();
    tasks.create({ id: 't1', project_id: 1, title: 'human-run' });
    tasks.setStatus('t1', 'in_progress');
    expect(ctx.agentProjects()).toEqual(new Set());
  });

  it('excludes a closed agent-labelled task (only in_progress counts for this group)', () => {
    const { tasks, ctx } = setup();
    tasks.create({ id: 't1', project_id: 1, title: 'done' });
    tasks.setAgent('t1', 'Nova');
    tasks.setStatus('t1', 'in_progress');
    tasks.setStatus('t1', 'closed');
    expect(ctx.agentProjects()).toEqual(new Set());
  });

  it('includes an active mission\'s epic project', () => {
    const { tasks, missions, ctx } = setup();
    tasks.create({ id: 'epic2', project_id: 2, title: 'E2', type: 'epic' });
    missions.create({ id: 'm2', epic_id: 'epic2', autonomy: 'L3', max_sessions: 1 });
    expect(ctx.agentProjects()).toEqual(new Set([2]));
  });

  it('excludes a mission that is not active', () => {
    const { tasks, missions, ctx } = setup();
    tasks.create({ id: 'epic2', project_id: 2, title: 'E2', type: 'epic' });
    const m = missions.create({ id: 'm2', epic_id: 'epic2', autonomy: 'L3', max_sessions: 1 });
    missions.setState(m.id, 'disengaged');
    expect(ctx.agentProjects()).toEqual(new Set());
  });

  it('includes a still-open epic that hosted an agent-labelled child, even after the child closed', () => {
    const { tasks, ctx } = setup();
    tasks.create({ id: 'epic3', project_id: 3, title: 'E3', type: 'epic' });
    tasks.create({ id: 'p3', project_id: 3, title: 'P3', parent_id: 'epic3' });
    tasks.setAgent('p3', 'Nova');
    tasks.setStatus('p3', 'closed'); // agent finished its own leaf — no longer in_progress
    expect(ctx.agentProjects()).toEqual(new Set([3]));
  });

  it('drops that epic once IT is closed or cancelled', () => {
    const { tasks, ctx } = setup();
    tasks.create({ id: 'epic3', project_id: 3, title: 'E3', type: 'epic' });
    tasks.create({ id: 'p3', project_id: 3, title: 'P3', parent_id: 'epic3' });
    tasks.setAgent('p3', 'Nova');
    tasks.setStatus('p3', 'closed');
    tasks.setStatus('epic3', 'closed');
    expect(ctx.agentProjects()).toEqual(new Set());
  });

  it('excludes a child with no agent: label even if its epic is open', () => {
    const { tasks, ctx } = setup();
    tasks.create({ id: 'epic3', project_id: 3, title: 'E3', type: 'epic' });
    tasks.create({ id: 'p3', project_id: 3, title: 'P3', parent_id: 'epic3' });
    expect(ctx.agentProjects()).toEqual(new Set());
  });

  it('unions all three groups across projects with no cross-contamination', () => {
    const { tasks, missions, ctx } = setup();
    tasks.create({ id: 't1', project_id: 1, title: 'working' });
    tasks.setAgent('t1', 'Nova');
    tasks.setStatus('t1', 'in_progress');
    tasks.create({ id: 'epic2', project_id: 2, title: 'E2', type: 'epic' });
    missions.create({ id: 'm2', epic_id: 'epic2', autonomy: 'L3', max_sessions: 1 });
    tasks.create({ id: 'epic3', project_id: 3, title: 'E3', type: 'epic' });
    tasks.create({ id: 'p3', project_id: 3, title: 'P3', parent_id: 'epic3' });
    tasks.setAgent('p3', 'Nova');
    tasks.setStatus('p3', 'closed');
    // project 4 has nothing agent-related — must stay out.
    tasks.create({ id: 't4', project_id: 4, title: 'idle' });
    expect(ctx.agentProjects()).toEqual(new Set([1, 2, 3]));
  });
});
