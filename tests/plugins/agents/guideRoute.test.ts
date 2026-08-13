import { describe, it, expect } from 'vitest';
import { TaskRefs } from '../../../src/store/taskRefs.js';
import { TaskStore } from '../../../plugins/work/src/store/taskStore.js';
import { Readiness } from '../../../plugins/work/src/store/readiness.js';
import { MissionStore } from '../../../plugins/agents/src/store/missionStore.js';
import { EventBus } from '../../../src/api/sse.js';
import { createServer } from '../../../src/api/server.js';
import { FakeClock } from '../../../src/shared/clock.js';
import { ConfigStore } from '../../../src/store/configStore.js';
import { UserStore } from '../../../src/store/userStore.js';
import { ProjectStore } from '../../../src/store/projectStore.js';
import { FakeTmuxDriver } from '../../../src/tmux/fakeDriver.js';
import { agentsPluginProvider } from '../../helpers/testApp.js';
import { openPluginTablesDb } from '../../helpers/pluginTablesDb.js';

/** GET /tasks/:id/guide is served by the agents plugin (pattern root mount). With no prompts override
 *  the provider renders the real `agent-guide*.md` files from disk — so these tests also guard the
 *  shipped template content, exactly as the old guideService unit tests did. */
function setup(opts: { withMission?: boolean; prompts?: { render(name: string, vars?: Record<string, string>, userId?: number): string; rawTemplate(name: string): string }; createdBy?: number } = {}) {
  const db = openPluginTablesDb(':memory:');
  db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'elowen','/o')").run();
  const users = new UserStore(db);
  const admin = users.create('admin', 'pw');
  const tasks = new TaskStore(db);
  tasks.create({ id: 'e1', project_id: 1, title: 'E', type: 'epic' });
  const t1 = tasks.create({ id: 't1', project_id: 1, title: 'T', parent_id: opts.withMission !== undefined ? 'e1' : undefined });
  if (opts.createdBy) db.prepare('UPDATE tasks SET created_by = ? WHERE id = ?').run(opts.createdBy, t1.id);
  const missions = new MissionStore(db);
  if (opts.withMission) missions.create({ id: 'm-e1', epic_id: 'e1', autonomy: 'L3', max_sessions: 1 });
  const readiness = new Readiness(db);
  const config = new ConfigStore(db);
  const projects = new ProjectStore(db);
  const app = createServer({
    tasks, taskRefs: new TaskRefs(db), readiness, missions, bus: new EventBus(),
    engine: null as never, spawn: null as never, tmux: new FakeTmuxDriver() as never,
    project: { id: 1, path: '/o' }, fallback: { program: 'claude-code', model: 'sonnet' },
    clock: new FakeClock(0), config, users, projects,
    plugins: agentsPluginProvider({ db, tasks, readiness, config, projects, users, ...(opts.prompts ? { prompts: opts.prompts } : {}) }),
  });
  const tok = users.issueToken(admin.id);
  const guide = async (id: string) => app.request(`/tasks/${id}/guide`, { headers: { authorization: `Bearer ${tok}` } });
  return { guide };
}

describe('GET /tasks/:id/guide (plugin-served)', () => {
  it('renders the base control guide for a standalone task (no phase appendix)', async () => {
    const res = await setup().guide('t1');
    expect(res.status).toBe(200);
    const { text } = await res.json() as { text: string };
    expect(text).toContain('First read the project context'); // base how-to-work
    expect(text).toContain('elowen ask'); // the open-question channel, rendered with the resolved cli
    expect(text).toContain('elowen close t1 --summary'); // the close command embeds this task's id
    expect(text).not.toContain('ONE phase of mission'); // no phase appendix for a standalone task
  });

  it('appends the mission-phase guide when the task is a phase of an ACTIVE mission', async () => {
    const res = await setup({ withMission: true }).guide('t1');
    const { text } = await res.json() as { text: string };
    expect(text).toContain('ONE phase of mission e1');
    expect(text).toContain('elowen note ls e1'); // handoff notes, with the epic id
    expect(text).toContain('elowen close e1 --summary'); // the final phase closes the epic
    expect(text).toContain('do NOT run `git commit`'); // VCS is mission-managed
  });

  it('omits the phase appendix when the phase has no active mission', async () => {
    const res = await setup({ withMission: false }).guide('t1');
    const { text } = await res.json() as { text: string };
    expect(text).not.toContain('ONE phase of mission');
  });

  it('returns 404 for an unknown task', async () => {
    expect((await setup().guide('nope')).status).toBe(404);
  });

  it("renders through the owning user's prompt override (passes the resolved ownerId)", async () => {
    const prompts = {
      render: (name: string, vars?: Record<string, string>, userId?: number) =>
        (userId === 1 && name === 'agent-guide' ? `OVERRIDDEN ${vars?.closeCommand}` : `DEFAULT ${name}`),
      rawTemplate: () => '',
    };
    // created_by = 1 (the admin) → the guide renders with that owner's overrides.
    const res = await setup({ prompts, createdBy: 1 }).guide('t1');
    expect(((await res.json()) as { text: string }).text).toBe('OVERRIDDEN elowen close t1');
  });
});
