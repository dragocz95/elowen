import { describe, it, expect } from 'vitest';
import { EventBus } from '../../src/api/sse.js';
import { createServer } from '../../src/api/server.js';
import { FakeClock } from '../../src/shared/clock.js';
import { ConfigStore } from '../../src/store/configStore.js';
import { UserStore } from '../../src/store/userStore.js';
import { ProjectStore } from '../../src/store/projectStore.js';
import { UserProjectStore } from '../../src/store/userProjectStore.js';
import { openDb } from '../../src/store/db.js';
import { PluginRegistry } from '../../src/plugins/registry.js';
import { PluginRegistryProvider } from '../../src/plugins/pluginsProvider.js';

function setup() {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'elowen',?)").run(process.cwd());
  const users = new UserStore(db);
  const admin = users.create('admin', 'pw'); // first user → is_admin
  const bob = users.create('bob', 'pw');
  const amy = users.create('amy', 'pw');
  users.setProfile(bob.id, { name: 'Bob' });
  users.setAvatar(bob.id, 'bob.png');
  users.setProfile(amy.id, { name: 'Amy' });
  const adminTok = users.issueToken(admin.id);
  const bobTok = users.issueToken(bob.id);
  const projects = new ProjectStore(db);
  const userProjects = new UserProjectStore(db);
  const config = new ConfigStore(db);
  const bus = new EventBus();
  const indicatorRequests: { projects: number[]; user: { id: number; isAdmin: boolean } | null }[] = [];
  const registry = new PluginRegistry();
  const demo = registry.contextFor('demo', {}, { info() {}, warn() {}, error() {} });
  demo.registerProjectIndicators(({ projects: visible, user }) => {
    indicatorRequests.push({ projects: visible.map((project) => project.id), user });
    return [
      { projectId: 1, label: 'Connected', value: 'main', icon: 'GitBranch', tone: 'success' },
      { projectId: 1, label: 'Storage', value: '20 GB', icon: 'Database', tone: 'accent' },
      { projectId: 1, label: 'x'.repeat(120), tone: 'warning' },
      { projectId: 1, label: 'Ignored overflow', tone: 'danger' },
      { projectId: 999, label: 'Leak', tone: 'danger' },
    ];
  });
  demo.registerProjectIndicators(() => [{ projectId: 1, label: 'Second provider overflow', tone: 'danger' }]);
  const privateIndicatorRequests: number[][] = [];
  registry.userGrantable.add('private');
  registry.contextFor('private', {}, { info() {}, warn() {}, error() {} }).registerProjectIndicators(({ projects: visible }) => {
    privateIndicatorRequests.push(visible.map((project) => project.id));
    return [{ projectId: 1, label: 'Private status', tone: 'accent' }];
  });
  const adminOnlyIndicatorRequests: number[][] = [];
  registry.webAdminOnly.add('admin-only');
  registry.contextFor('admin-only', {}, { info() {}, warn() {}, error() {} }).registerProjectIndicators(({ projects: visible }) => {
    adminOnlyIndicatorRequests.push(visible.map((project) => project.id));
    return [{ projectId: 1, label: 'Admin status', tone: 'warning' }];
  });
  const plugins = new PluginRegistryProvider(async () => registry);
  const app = createServer({
    bus,
    engine: null as never, spawn: null as never, tmux: null as never,
    project: { id: 1, path: process.cwd() }, fallback: { program: 'claude-code', model: 'sonnet' },
    clock: new FakeClock(0), config,
    users, projects, userProjects, plugins,
    // The demo plugin contributes display-only Project indicators; access to Projects, members, activity
    // and events remains the daemon's own tenancy decision.
  });
  return { app, adminTok, bobTok, bob, amy, userProjects, indicatorRequests, privateIndicatorRequests, adminOnlyIndicatorRequests };
}
const auth = (t: string) => ({ headers: { authorization: `Bearer ${t}` } });
const post = (t: string, body: unknown) => ({ method: 'POST', headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('project access gating', () => {
  it('admin sees all projects; an unassigned non-admin sees none', async () => {
    const { app, adminTok, bobTok } = setup();
    expect(((await (await app.request('/projects', auth(adminTok))).json()) as unknown[]).length).toBe(1);
    expect(((await (await app.request('/projects', auth(bobTok))).json()) as unknown[]).length).toBe(0);
  });

  it('projects expose their assigned members only to administrators', async () => {
    const { app, adminTok, bobTok, bob, userProjects } = setup();
    userProjects.assign(bob.id, 1);
    expect(await (await app.request('/projects/1/users', auth(adminTok))).json()).toEqual([bob.id]);
    expect((await app.request('/projects/1/users', auth(bobTok))).status).toBe(403);
  });

  it('projects summary batches bounded plugin indicators and never leaks member assignments', async () => {
    const { app, adminTok, bobTok, bob, amy, userProjects, indicatorRequests, privateIndicatorRequests, adminOnlyIndicatorRequests } = setup();
    userProjects.assign(bob.id, 1);
    userProjects.assign(amy.id, 1);

    const publicIndicators = [
      { plugin: 'demo', label: 'Connected', value: 'main', icon: 'GitBranch', tone: 'success' },
      { plugin: 'demo', label: 'Storage', value: '20 GB', icon: 'Database', tone: 'accent' },
      { plugin: 'demo', label: 'x'.repeat(80), tone: 'warning' },
    ];
    const adminIndicators = [
      ...publicIndicators,
      { plugin: 'private', label: 'Private status', tone: 'accent' },
      { plugin: 'admin-only', label: 'Admin status', tone: 'warning' },
    ];
    const adminSummary = await (await app.request('/projects/summary', auth(adminTok))).json() as {
      projectId: number; members?: { total: number; samples: { id: number; name: string; avatar: string }[] };
      indicators: { plugin: string; label: string; value?: string }[];
    }[];
    expect(adminSummary).toEqual([{
      projectId: 1,
      members: { total: 2, samples: [{ id: bob.id, username: 'bob', name: 'Bob', avatar: 'bob.png' }, { id: amy.id, username: 'amy', name: 'Amy', avatar: '' }] },
      indicators: adminIndicators,
    }]);

    const memberSummary = await (await app.request('/projects/summary', auth(bobTok))).json() as { projectId: number; members?: unknown; indicators: unknown[] }[];
    expect(memberSummary).toEqual([{ projectId: 1, indicators: publicIndicators }]);
    expect(memberSummary[0]).not.toHaveProperty('members');
    expect(indicatorRequests).toEqual([
      { projects: [1], user: { id: 1, isAdmin: true } },
      { projects: [1], user: { id: bob.id, isAdmin: false } },
    ]);
    expect(privateIndicatorRequests).toEqual([[1]]);
    expect(adminOnlyIndicatorRequests).toEqual([[1]]);
  });

  it('a non-admin cannot manage assignments, projects or server directories (no privilege escalation)', async () => {
    const { app, bobTok, bob } = setup();
    expect((await app.request(`/users/${bob.id}/projects`, post(bobTok, { projectId: 1 }))).status).toBe(403);
    expect((await app.request('/projects', post(bobTok, { slug: 'x', path: '/x' }))).status).toBe(403);
    expect((await app.request('/fs/dirs', post(bobTok, { parent: process.cwd(), name: 'blocked' }))).status).toBe(403);
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
