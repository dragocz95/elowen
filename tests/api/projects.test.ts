import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskStore } from '../../src/store/taskStore.js';
import { Readiness } from '../../src/store/readiness.js';
import { MissionStore } from '../../plugins/agents/src/store/missionStore.js';
import { ProjectStore } from '../../src/store/projectStore.js';
import { FakeGitReader } from '../../src/git/gitReader.js';
import { FakeTmuxDriver } from '../../src/tmux/fakeDriver.js';
import { EventBus } from '../../src/api/sse.js';
import { createServer } from '../../src/api/server.js';
import { FakeClock } from '../../src/shared/clock.js';
import { ConfigStore } from '../../src/store/configStore.js';
import { openAgentsDb } from '../helpers/agentsDb.js';

function makeApp(extra: { engine?: unknown; missionGit?: unknown; tmux?: unknown } = {}) {
  const db = openAgentsDb(':memory:'); db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'elowen','/o')").run();
  const projects = new ProjectStore(db);
  const tasks = new TaskStore(db);
  const missions = new MissionStore(db);
  const git = new FakeGitReader({ isRepo: true, status: { branch: 'main', ahead: 0, behind: 0, dirty: 2, clean: false }, branches: [{ name: 'main', current: true }], commits: [{ hash: 'abc123', subject: 'init', author: 'me', relative: '1 hour ago' }] });
  const app = createServer({
    tasks, readiness: new Readiness(db), missions,
    bus: new EventBus(), engine: (extra.engine ?? null) as any, spawn: null as any, tmux: (extra.tmux ?? null) as any,
    missionGit: extra.missionGit as any,
    project: { id: 1, path: '/o' }, fallback: { program: 'claude-code', model: 'sonnet' },
    clock: new FakeClock(0), config: new ConfigStore(db), projects, git,
  });
  return { app, db, tasks, missions };
}

describe('projects api', () => {
  it('GET /projects lists, POST creates, duplicate slug 409', async () => {
    const { app } = makeApp();
    expect((await (await app.request('/projects')).json()).length).toBeGreaterThanOrEqual(1);
    const created = await app.request('/projects', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ slug: 'web', path: '/w', notes: 'fe' }) });
    expect(created.status).toBe(201);
    const dup = await app.request('/projects', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ slug: 'web', path: '/x' }) });
    expect(dup.status).toBe(409);
  });
  it('PATCH /projects/:id updates path and notes; slug stays immutable; 404 unknown', async () => {
    const { app } = makeApp();
    const patched = await app.request('/projects/1', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: '/moved', notes: 'pilot ctx', slug: 'hacked' }) });
    expect(patched.status).toBe(200);
    const body = await patched.json();
    expect(body).toMatchObject({ id: 1, slug: 'elowen', path: '/moved', notes: 'pilot ctx' });
    const missing = await app.request('/projects/999', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ notes: 'x' }) });
    expect(missing.status).toBe(404);
  });
  it('PATCH /projects/:id sets an icon from a real repo image and rejects an escaping path', async () => {
    const { app } = makeApp();
    const root = mkdtempSync(join(tmpdir(), 'elowen-proj-'));
    mkdirSync(join(root, 'assets'), { recursive: true });
    writeFileSync(join(root, 'assets/logo.png'), 'PNG');
    try {
      // Register a project whose path is a real dir, then set its icon to an image inside it.
      const created = await (await app.request('/projects', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ slug: 'icn', path: root }) })).json();
      const ok = await app.request(`/projects/${created.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ icon: 'assets/logo.png' }) });
      expect(ok.status).toBe(200);
      expect((await ok.json()).icon).toBe('assets/logo.png');
      // A traversal path is refused (and never persisted).
      const bad = await app.request(`/projects/${created.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ icon: '../../etc/passwd' }) });
      expect(bad.status).toBe(400);
      expect((await (await app.request('/projects')).json()).find((p: { id: number }) => p.id === created.id).icon).toBe('assets/logo.png');
      // '' clears the icon back to the default.
      const cleared = await app.request(`/projects/${created.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ icon: '' }) });
      expect((await cleared.json()).icon).toBe('');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('DELETE /projects/:id removes a non-home project; 404 unknown; 400 for the home project', async () => {
    const { app } = makeApp();
    await app.request('/projects', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ slug: 'gone', path: '/g' }) });
    const before = await (await app.request('/projects')).json();
    const target = before.find((p: { slug: string }) => p.slug === 'gone');
    const ok = await app.request(`/projects/${target.id}`, { method: 'DELETE' });
    expect(ok.status).toBe(200);
    const after = await (await app.request('/projects')).json();
    expect(after.some((p: { slug: string }) => p.slug === 'gone')).toBe(false);
    expect((await app.request('/projects/999', { method: 'DELETE' })).status).toBe(404);
    const home = await app.request('/projects/1', { method: 'DELETE' });
    expect(home.status).toBe(400);
    expect((await (await app.request('/projects')).json()).some((p: { id: number }) => p.id === 1)).toBe(true);
  });
  it('DELETE /projects/:id stops the project\'s running missions and agents before removing its rows', async () => {
    const disengage = vi.fn().mockResolvedValue(undefined);
    const cleanup = vi.fn().mockResolvedValue(undefined);
    const tmux = new FakeTmuxDriver();
    const { app, db, tasks } = makeApp({ engine: { disengage }, missionGit: { cleanup }, tmux });
    db.prepare("INSERT INTO projects (id,slug,path) VALUES (2,'doomed','/d')").run();
    tasks.create({ id: 'ep', project_id: 2, title: 'Epic', type: 'epic' });
    db.prepare("INSERT INTO missions (id,epic_id,autonomy,state) VALUES ('m-ep','ep','L3','active')").run();
    tasks.create({ id: 'standalone', project_id: 2, title: 'Standalone', labels: ['agent:Nova'] });
    tasks.setStatus('standalone', 'in_progress');
    tmux.setPane('elowen-Nova', ''); // simulate the live agent session

    const res = await app.request('/projects/2', { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(disengage).toHaveBeenCalledWith('m-ep');
    expect(cleanup).toHaveBeenCalledWith('m-ep');
    expect(await tmux.list()).not.toContain('elowen-Nova'); // the standalone task's agent was stopped too
    expect((await (await app.request('/projects')).json()).some((p: { id: number }) => p.id === 2)).toBe(false);
  });
  it('refuses to delete a project whose mission teardown cannot run or fails, keeping its rows', async () => {
    // The rows are the ONLY handle on a live agent or an on-disk worktree: delete them and a mission
    // that is still running becomes unreachable. So an unavailable engine (agents plugin off) and a
    // failing cleanup both stop the delete instead of proceeding quietly.
    const seedRunningMission = (db: ReturnType<typeof makeApp>['db'], tasks: ReturnType<typeof makeApp>['tasks']) => {
      db.prepare("INSERT INTO projects (id,slug,path) VALUES (2,'doomed','/d')").run();
      tasks.create({ id: 'ep', project_id: 2, title: 'Epic', type: 'epic' });
      db.prepare("INSERT INTO missions (id,epic_id,autonomy,state) VALUES ('m-ep','ep','L3','active')").run();
    };
    const stillThere = async (app: ReturnType<typeof makeApp>['app']) =>
      (await (await app.request('/projects')).json() as { id: number }[]).some((p) => p.id === 2);

    const off = makeApp({ missionGit: { cleanup: vi.fn() } }); // no engine ⇒ agents plugin disabled
    seedRunningMission(off.db, off.tasks);
    const refused = await off.app.request('/projects/2', { method: 'DELETE' });
    expect(refused.status).toBe(503);
    expect(await refused.json()).toEqual({ error: 'agents plugin is disabled' });
    expect(await stillThere(off.app)).toBe(true);

    const broken = makeApp({
      engine: { disengage: vi.fn().mockResolvedValue(undefined) },
      missionGit: { cleanup: vi.fn().mockRejectedValue(new Error('worktree busy')) },
    });
    seedRunningMission(broken.db, broken.tasks);
    const failed = await broken.app.request('/projects/2', { method: 'DELETE' });
    expect(failed.status).toBe(500);
    expect(await failed.json()).toEqual({ error: 'mission teardown failed' });
    expect(await stillThere(broken.app)).toBe(true);
  });
  it('PATCH /projects/:id round-trips the tri-state pr_enabled override', async () => {
    const { app } = makeApp();
    const on = await app.request('/projects/1', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pr_enabled: true }) });
    expect((await on.json()).pr_enabled).toBe(true);
    const off = await app.request('/projects/1', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pr_enabled: false }) });
    expect((await off.json()).pr_enabled).toBe(false);
    const inherit = await app.request('/projects/1', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pr_enabled: null }) });
    expect((await inherit.json()).pr_enabled).toBeNull();
  });
  it('GET /fs/dirs lists sub-directories of a server path and 400s on a bad path', async () => {
    const { app } = makeApp();
    const root = mkdtempSync(join(tmpdir(), 'elowen-fsdirs-'));
    mkdirSync(join(root, 'apps')); mkdirSync(join(root, 'libs')); writeFileSync(join(root, 'README.md'), '#');
    try {
      const res = await app.request(`/fs/dirs?path=${encodeURIComponent(root)}`);
      expect(res.status).toBe(200);
      const body = await res.json() as { entries: { name: string }[]; parent: string | null };
      const names = body.entries.map((e) => e.name);
      expect(names).toContain('apps');
      expect(names).toContain('libs');
      expect(names).not.toContain('README.md'); // directories only
      expect(body.parent).not.toBeNull();
      const bad = await app.request(`/fs/dirs?path=${encodeURIComponent(join(root, 'nope'))}`);
      expect(bad.status).toBe(400);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('GET /projects/:id/git returns the reader result; 404 unknown', async () => {
    const { app } = makeApp();
    expect((await app.request('/projects/999/git')).status).toBe(404);
    const git = await (await app.request('/projects/1/git')).json();
    expect(git.status.branch).toBe('main');
    expect(git.commits[0].hash).toBe('abc123');
  });
});
