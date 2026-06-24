import { describe, it, expect } from 'vitest';
import { openDb } from '../../src/store/db.js';
import { TaskStore } from '../../src/store/taskStore.js';
import { Readiness } from '../../src/store/readiness.js';
import { MissionStore } from '../../src/store/missionStore.js';
import { ProjectStore } from '../../src/store/projectStore.js';
import { ConfigStore } from '../../src/store/configStore.js';
import { MissionPrStore } from '../../src/store/missionPrStore.js';
import { MissionGit } from '../../src/overseer/missionGit.js';
import { createServer } from '../../src/api/server.js';
import { EventBus } from '../../src/api/sse.js';
import { SystemClock } from '../../src/shared/clock.js';
import type { FinishResult } from '../../src/overseer/missionGit.js';

function build(openPr: () => Promise<FinishResult>, withGit = true) {
  const db = openDb(':memory:');
  const projects = new ProjectStore(db);
  const project = projects.create({ slug: 'demo', path: '/o' });
  const tasks = new TaskStore(db);
  tasks.create({ id: 'epic', project_id: project.id, title: 'E', type: 'epic' });
  const missions = new MissionStore(db);
  missions.create({ id: 'm-epic', epic_id: 'epic', autonomy: 'L3', max_sessions: 1 });
  const missionGit = withGit ? ({ openPr } as unknown as MissionGit) : undefined;
  const app = createServer({
    tasks, readiness: new Readiness(db), missions, engine: null as never, spawn: null as never,
    tmux: null as never, bus: new EventBus(), missionGit, projects,
    project: { id: project.id, path: '/o' }, fallback: { program: 'claude-code', model: 'sonnet' },
    clock: new SystemClock(), config: new ConfigStore(db),
  });
  return app;
}
const openPr = (app: ReturnType<typeof build>, id = 'm-epic') => app.request(`/missions/${id}/pr`, { method: 'POST' });

describe('POST /missions/:id/pr', () => {
  it('returns the PR url + number when openPr opens one', async () => {
    const app = build(async () => ({ state: 'opened', url: 'https://github.com/o/r/pull/3', number: 3 }));
    const res = await openPr(app);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ url: 'https://github.com/o/r/pull/3', number: 3 });
  });

  it('maps a failed verify gate to 422 with its output', async () => {
    const app = build(async () => ({ state: 'verify-failed', output: 'tests failed' }));
    const res = await openPr(app);
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ output: 'tests failed' });
  });

  it('maps a missing remote to 422', async () => {
    const app = build(async () => ({ state: 'no-remote' }));
    expect((await openPr(app)).status).toBe(422);
  });

  it('404s for an unknown mission', async () => {
    const app = build(async () => ({ state: 'off' }));
    expect((await openPr(app, 'm-nope')).status).toBe(404);
  });

  it('400s when the PR workflow is not wired', async () => {
    const app = build(async () => ({ state: 'off' }), false);
    expect((await openPr(app)).status).toBe(400);
  });
});

describe('GET /missions surfaces a completed PR-native mission', () => {
  it('includes a DISENGAGED mission with a pending PR (so the Open PR affordance survives completion)', async () => {
    const db = openDb(':memory:');
    const projects = new ProjectStore(db);
    const project = projects.create({ slug: 'demo', path: '/o' });
    const tasks = new TaskStore(db);
    tasks.create({ id: 'epic', project_id: project.id, title: 'E', type: 'epic' });
    const missions = new MissionStore(db);
    missions.create({ id: 'm-epic', epic_id: 'epic', autonomy: 'L3', max_sessions: 1 });
    missions.setState('m-epic', 'disengaged'); // naturally completed → drops out of live()
    const prs = new MissionPrStore(db);
    prs.create({ mission_id: 'm-epic', branch: 'orca/demo-epic', worktree: '/wt' }); // pr pending (no url yet)
    const config = new ConfigStore(db);
    const missionGit = new MissionGit({ prs, config, projects, tasks });
    const app = createServer({
      tasks, readiness: new Readiness(db), missions, engine: null as never, spawn: null as never,
      tmux: null as never, bus: new EventBus(), missionGit, projects,
      project: { id: project.id, path: '/o' }, fallback: { program: 'claude-code', model: 'sonnet' },
      clock: new SystemClock(), config,
    });
    const list = await (await app.request('/missions')).json() as { id: string; state: string; pr: { branch: string } | null }[];
    const m = list.find((x) => x.id === 'm-epic');
    expect(m).toBeTruthy();
    expect(m!.state).toBe('disengaged');
    expect(m!.pr?.branch).toBe('orca/demo-epic');
  });

  it('drops a mission once its PR is merged', async () => {
    const db = openDb(':memory:');
    const projects = new ProjectStore(db);
    const project = projects.create({ slug: 'demo', path: '/o' });
    const tasks = new TaskStore(db);
    tasks.create({ id: 'epic', project_id: project.id, title: 'E', type: 'epic' });
    const missions = new MissionStore(db);
    missions.create({ id: 'm-epic', epic_id: 'epic', autonomy: 'L3', max_sessions: 1 });
    missions.setState('m-epic', 'disengaged');
    const prs = new MissionPrStore(db);
    prs.create({ mission_id: 'm-epic', branch: 'orca/demo-epic', worktree: '/wt' });
    prs.setPr('m-epic', { number: 1, url: 'u', state: 'merged' });
    const config = new ConfigStore(db);
    const app = createServer({
      tasks, readiness: new Readiness(db), missions, engine: null as never, spawn: null as never,
      tmux: null as never, bus: new EventBus(), missionGit: new MissionGit({ prs, config, projects, tasks }), projects,
      project: { id: project.id, path: '/o' }, fallback: { program: 'claude-code', model: 'sonnet' },
      clock: new SystemClock(), config,
    });
    const list = await (await app.request('/missions')).json() as { id: string }[];
    expect(list.find((x) => x.id === 'm-epic')).toBeUndefined(); // merged → no longer surfaced
  });
});
