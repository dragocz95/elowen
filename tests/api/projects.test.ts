import { describe, it, expect } from 'vitest';
import { openDb } from '../../src/store/db.js';
import { TaskStore } from '../../src/store/taskStore.js';
import { Readiness } from '../../src/store/readiness.js';
import { MissionStore } from '../../src/store/missionStore.js';
import { ProjectStore } from '../../src/store/projectStore.js';
import { FakeGitReader } from '../../src/git/gitReader.js';
import { EventBus } from '../../src/api/sse.js';
import { createServer } from '../../src/api/server.js';
import { FakeClock } from '../../src/shared/clock.js';
import { ConfigStore } from '../../src/store/configStore.js';

function makeApp() {
  const db = openDb(':memory:'); db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'orca','/o')").run();
  const projects = new ProjectStore(db);
  const git = new FakeGitReader({ isRepo: true, status: { branch: 'main', ahead: 0, behind: 0, dirty: 2, clean: false }, branches: [{ name: 'main', current: true }], commits: [{ hash: 'abc123', subject: 'init', author: 'me', relative: '1 hour ago' }] });
  const app = createServer({
    tasks: new TaskStore(db), readiness: new Readiness(db), missions: new MissionStore(db),
    bus: new EventBus(), engine: null as any, spawn: null as any, tmux: null as any,
    project: { id: 1, path: '/o' }, fallback: { program: 'claude-code', model: 'sonnet' },
    clock: new FakeClock(0), config: new ConfigStore(db), projects, git,
  });
  return { app };
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
    expect(body).toMatchObject({ id: 1, slug: 'orca', path: '/moved', notes: 'pilot ctx' });
    const missing = await app.request('/projects/999', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ notes: 'x' }) });
    expect(missing.status).toBe(404);
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
  it('GET /projects/:id/git returns the reader result; 404 unknown', async () => {
    const { app } = makeApp();
    expect((await app.request('/projects/999/git')).status).toBe(404);
    const git = await (await app.request('/projects/1/git')).json();
    expect(git.status.branch).toBe('main');
    expect(git.commits[0].hash).toBe('abc123');
  });
});
