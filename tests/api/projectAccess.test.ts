import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it, expect } from 'vitest';
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

function setup(projectPath = process.cwd()) {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'elowen',?)").run(projectPath);
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

/** Fixture worktrees made for the branch projection; removed whatever the assertions did. */
const temporaryRoots: string[] = [];
afterEach(() => {
  while (temporaryRoots.length > 0) rmSync(temporaryRoots.pop()!, { recursive: true, force: true });
});

describe('project access gating', () => {
  it('admin sees all projects; an unassigned non-admin sees none', async () => {
    const { app, adminTok, bobTok } = setup();
    expect(((await (await app.request('/projects', auth(adminTok))).json()) as unknown[]).length).toBe(1);
    expect(((await (await app.request('/projects', auth(bobTok))).json()) as unknown[]).length).toBe(0);
  });

  it('projects expose their assigned members only to administrators', async () => {
    const { app, adminTok, bobTok, bob, userProjects } = setup();
    userProjects.assign(bob.id, 1);
    // A HOST project's member list stays administrator-only in BOTH shapes, and the default answer is
    // still the id list. The profile view is bounded to the identity a member row renders — never a
    // password hash, grants or anything else on the account.
    expect(await (await app.request('/projects/1/users', auth(adminTok))).json()).toEqual([bob.id]);
    expect(await (await app.request('/projects/1/users?view=profiles', auth(adminTok))).json())
      .toEqual([{ id: bob.id, username: 'bob', name: 'Bob', email: '', avatar: 'bob.png' }]);
    expect((await app.request('/projects/1/users', auth(bobTok))).status).toBe(403);
    expect((await app.request('/projects/1/users?view=profiles', auth(bobTok))).status).toBe(403);
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
    // The project of this fixture is the checkout the suite runs in, which may or may not be a
    // repository, so the branch is asserted on its own below rather than pinned here.
    const adminSummary = (await (await app.request('/projects/summary', auth(adminTok))).json() as {
      projectId: number; branch?: string;
      members?: { total: number; samples: { id: number; name: string; avatar: string }[] };
      indicators: { plugin: string; label: string; value?: string }[];
    }[]).map(({ branch: _branch, ...rest }) => rest);
    expect(adminSummary).toEqual([{
      projectId: 1,
      members: { total: 2, samples: [{ id: bob.id, username: 'bob', name: 'Bob', avatar: 'bob.png' }, { id: amy.id, username: 'amy', name: 'Amy', avatar: '' }] },
      indicators: adminIndicators,
    }]);

    const memberSummary = (await (await app.request('/projects/summary', auth(bobTok))).json() as { projectId: number; branch?: string; members?: unknown; indicators: unknown[] }[])
      .map(({ branch: _branch, ...rest }) => rest);
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


  // The register draws a branch per card, so the branch has to come from the ONE bounded projection that
  // already exists for it. A sweep of `/projects/:id/git` would be three git processes per card; this is
  // one memoized `.git/HEAD` read, bounded by the caller's own policy.
  it('serves the register a real branch per host project and none for a managed one', async () => {
    const root = mkdtempSync(join(tmpdir(), 'elowen-branch-'));
    temporaryRoots.push(root);
    mkdirSync(join(root, '.git'), { recursive: true });
    // A real repository layout, read directly. No `git` binary is involved, which is exactly why one
    // read per project is affordable in a batch.
    writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/release/2.0\n');

    const { app, adminTok } = setup(root);
    const summary = await (await app.request('/projects/summary', auth(adminTok))).json() as { projectId: number; branch?: string }[];
    expect(summary[0]!.branch).toBe('release/2.0');

    // A detached HEAD is a real state and reports the short commit rather than inventing a branch name.
    // Its own directory, because `gitBranch` memoizes a directory for a few seconds — which is the
    // property that makes this read affordable in a per-project batch, not something to work around.
    const headless = mkdtempSync(join(tmpdir(), 'elowen-detached-'));
    temporaryRoots.push(headless);
    mkdirSync(join(headless, '.git'), { recursive: true });
    writeFileSync(join(headless, '.git', 'HEAD'), `${'a1b2c3d'.padEnd(40, '0')}\n`);
    const detached = setup(headless);
    expect((await (await detached.app.request('/projects/summary', auth(detached.adminTok))).json() as { branch?: string }[])[0]!.branch)
      .toBe('a1b2c3d');

    // A directory that is not a repository reports NO branch, rather than an empty one that would read
    // as a repository with nothing checked out.
    const plain = mkdtempSync(join(tmpdir(), 'elowen-plain-'));
    temporaryRoots.push(plain);
    const bare = setup(plain);
    expect((await (await bare.app.request('/projects/summary', auth(bare.adminTok))).json() as Record<string, unknown>[])[0])
      .not.toHaveProperty('branch');
  });

  it('gates aggregate activity but lets the filtered live stream open without project access', async () => {
    const { app, adminTok, bobTok } = setup();
    expect((await app.request('/activity', auth(bobTok))).status).toBe(403);
    const stream = await app.request('/events', auth(bobTok));
    expect(stream.status).toBe(200);
    await stream.body?.cancel();
    expect((await app.request('/activity', auth(adminTok))).status).toBe(200);
  });

  it('refuses to delete the admin user (no adminless lockout / silent re-election)', async () => {
    const { app, adminTok } = setup();
    expect((await app.request('/users/1', { method: 'DELETE', headers: { authorization: `Bearer ${adminTok}` } })).status).toBe(400);
  });
});
