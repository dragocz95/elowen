import { describe, it, expect } from 'vitest';
import { TaskStore } from '../../plugins/work/src/store/taskStore.js';
import { Readiness } from '../../plugins/work/src/store/readiness.js';
import { MissionStore } from '../../plugins/agents/src/store/missionStore.js';
import { EventBus } from '../../src/api/sse.js';
import { createServer } from '../../src/api/server.js';
import { FakeClock } from '../../src/shared/clock.js';
import { ConfigStore } from '../../src/store/configStore.js';
import { UserStore } from '../../src/store/userStore.js';
import { ProjectStore } from '../../src/store/projectStore.js';
import { UserProjectStore } from '../../src/store/userProjectStore.js';
import { openPluginTablesDb } from '../helpers/pluginTablesDb.js';
import { join } from 'node:path';
import { loadPlugins } from '../../src/plugins/loader.js';
import { PluginRegistryProvider } from '../../src/plugins/pluginsProvider.js';
import { makePluginDb } from '../../src/store/pluginDb.js';
import { agentsTestHost } from '../helpers/testApp.js';
import { safeProjectPath } from '../../src/integrations/projectFiles.js';

function setup() {
  const db = openPluginTablesDb(':memory:');
  db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'elowen',?)").run(process.cwd());
  const users = new UserStore(db);
  const admin = users.create('admin', 'pw'); // first user → is_admin
  const bob = users.create('bob', 'pw');
  const adminTok = users.issueToken(admin.id);
  const bobTok = users.issueToken(bob.id);
  const projects = new ProjectStore(db);
  const tasks = new TaskStore(db);
  const readiness = new Readiness(db);
  const config = new ConfigStore(db);
  const bus = new EventBus();
  const app = createServer({
    tasks, missions: new MissionStore(db), bus,
    engine: null as never, spawn: null as never, tmux: null as never,
    project: { id: 1, path: process.cwd() }, fallback: { program: 'claude-code', model: 'sonnet' },
    clock: new FakeClock(0), config,
    users, projects, userProjects: new UserProjectStore(db),
    // The /tasks surface is plugin-served now — the work
    // plugin owns the task routes, so it has to be loaded for this file's task assertions to mean
    // anything. The agents plugin stays off: nothing here asserts a mission surface.
    plugins: new PluginRegistryProvider(() => loadPlugins({
      dirs: [join(process.cwd(), 'plugins')], enabled: ['work'], logger: { info() {}, warn() {}, error() {} },
      delegatedTurnsOutOfProcess: () => false,
      pluginDb: (plugin) => makePluginDb(db, plugin, { canMigrate: true }),
      publishEvent: (e) => bus.publish(e),
      subscribeEvents: (fn) => bus.subscribe(fn),
      host: { ...agentsTestHost({ db, tasks, readiness, config, projects, users }), projectFiles: { safe: safeProjectPath } } as never,
    })),
    pluginDirs: [join(process.cwd(), 'plugins')],
  });
  return { app, adminTok, bobTok, bob };
}
const auth = (t: string) => ({ headers: { authorization: `Bearer ${t}` } });
const post = (t: string, body: unknown) => ({ method: 'POST', headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('project access gating', () => {
  it('admin sees all projects; an unassigned non-admin sees none', async () => {
    const { app, adminTok, bobTok } = setup();
    expect(((await (await app.request('/projects', auth(adminTok))).json()) as unknown[]).length).toBe(1);
    expect(((await (await app.request('/projects', auth(bobTok))).json()) as unknown[]).length).toBe(0);
  });

  it('GET /tasks/ready is tenant-scoped — a user assigned only to another project cannot read the home queue', async () => {
    const { app, adminTok, bobTok, bob } = setup();
    // Seed a ready (open, non-epic, dep-free) task in the home project (id 1).
    expect((await app.request('/tasks', post(adminTok, { title: 'home ready', type: 'feature', project_id: 1 }))).status).toBe(201);
    // A second project, with bob assigned to it ONLY.
    const p2 = await (await app.request('/projects', post(adminTok, { slug: 'other', path: '/o2' }))).json() as { id: number };
    expect((await app.request(`/users/${bob.id}/projects`, post(adminTok, { projectId: p2.id }))).status).toBe(200);
    // Bob passes the ≥1-project gate but must NOT receive the home project's ready queue by default.
    expect(await (await app.request('/tasks/ready', auth(bobTok))).json()).toEqual([]);
    // The admin still sees the home project's ready task.
    expect(((await (await app.request('/tasks/ready', auth(adminTok))).json()) as unknown[]).length).toBe(1);
  });

  it('non-admin is 403 on the task surface until the admin assigns them', async () => {
    const { app, adminTok, bobTok, bob } = setup();
    expect((await app.request('/tasks', auth(bobTok))).status).toBe(403);
    expect((await app.request('/missions', auth(bobTok))).status).toBe(403);

    expect((await app.request(`/users/${bob.id}/projects`, post(adminTok, { projectId: 1 }))).status).toBe(200);

    expect((await app.request('/tasks', auth(bobTok))).status).toBe(200);
  });

  it('a non-admin cannot manage assignments or create projects (no privilege escalation)', async () => {
    const { app, bobTok, bob } = setup();
    expect((await app.request(`/users/${bob.id}/projects`, post(bobTok, { projectId: 1 }))).status).toBe(403);
    expect((await app.request('/projects', post(bobTok, { slug: 'x', path: '/x' }))).status).toBe(403);
  });

  it('the admin passes everywhere', async () => {
    const { app, adminTok } = setup();
    expect((await app.request('/tasks', auth(adminTok))).status).toBe(200);
    expect((await app.request('/tasks/ready', auth(adminTok))).status).toBe(200);
  });

  it('also gates the activity log and the live event stream (no cross-tenant leak)', async () => {
    const { app, adminTok, bobTok } = setup();
    expect((await app.request('/activity', auth(bobTok))).status).toBe(403);
    expect((await app.request('/events', auth(bobTok))).status).toBe(403); // 403 before the SSE stream opens
    expect((await app.request('/activity', auth(adminTok))).status).toBe(200);
  });

  it('refuses to delete the admin user (no adminless lockout / silent re-election)', async () => {
    const { app, adminTok } = setup();
    expect((await app.request('/users/1', { method: 'DELETE', headers: { authorization: `Bearer ${adminTok}` } })).status).toBe(400);
  });
});
