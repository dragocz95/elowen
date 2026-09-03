import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectStore } from '../../src/store/projectStore.js';
import { FakeGitReader } from '../../src/git/gitReader.js';
import { EventBus } from '../../src/api/sse.js';
import { createServer } from '../../src/api/server.js';
import { FakeClock } from '../../src/shared/clock.js';
import { ConfigStore } from '../../src/store/configStore.js';
import { openDb } from '../../src/store/db.js';
import { PluginRegistry } from '../../src/plugins/registry.js';
import { PluginRegistryProvider } from '../../src/plugins/pluginsProvider.js';

function makeApp(extra: { engine?: unknown; missionGit?: unknown; tmux?: unknown; projectRemoved?: (id: number) => void | Promise<void> } = {}) {
  const db = openDb(':memory:'); db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'elowen','/o')").run();
  const projects = new ProjectStore(db);
  const git = new FakeGitReader({ isRepo: true, status: { branch: 'main', head: 'abc123', upstream: null, ahead: 0, behind: 0, dirty: 2, untracked: 0, clean: false }, remotes: [], branches: [{ name: 'main', current: true }], commits: [{ hash: 'abc123', subject: 'init', author: 'me', relative: '1 hour ago' }] });
  const plugins = extra.projectRemoved ? (() => {
    const registry = new PluginRegistry();
    registry.contextFor('demo', {}, { info() {}, warn() {}, error() {} }).registerProjectRemoved(extra.projectRemoved!);
    return new PluginRegistryProvider(async () => registry);
  })() : undefined;
  const app = createServer({

    bus: new EventBus(), engine: (extra.engine ?? null) as any, spawn: null as any, tmux: (extra.tmux ?? null) as any,
    missionGit: extra.missionGit as any,
    project: { id: 1, path: '/o' }, fallback: { program: 'claude-code', model: 'sonnet' },
    clock: new FakeClock(0), config: new ConfigStore(db), projects, git, plugins,
  });
  return { app, db };
}

describe('projects api', () => {
  it('GET, POST and PATCH expose server-computed project path state without blocking missing paths', async () => {
    const { app } = makeApp();
    const root = mkdtempSync(join(tmpdir(), 'elowen-project-path-'));
    const missingPath = join(root, 'missing');
    try {
      const listed = await (await app.request('/projects')).json() as { slug: string; pathExists: boolean }[];
      expect(listed.find((project) => project.slug === 'elowen')).toMatchObject({ pathExists: false });

      const existing = await app.request('/projects', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ slug: 'web', path: root, notes: 'fe' }) });
      expect(existing.status).toBe(201);
      expect(await existing.json()).toMatchObject({ slug: 'web', path: root, pathExists: true });

      const missing = await app.request('/projects', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ slug: 'missing', path: missingPath }) });
      expect(missing.status).toBe(201);
      expect(await missing.json()).toMatchObject({ slug: 'missing', path: missingPath, pathExists: false });

      const dup = await app.request('/projects', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ slug: 'web', path: '/x' }) });
      expect(dup.status).toBe(409);

      const patched = await app.request('/projects/1', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: root, notes: 'pilot ctx', slug: 'hacked' }) });
      expect(patched.status).toBe(200);
      expect(await patched.json()).toMatchObject({ id: 1, slug: 'elowen', path: root, notes: 'pilot ctx', pathExists: true });
      const patchedMissing = await app.request('/projects/1', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: missingPath }) });
      expect(patchedMissing.status).toBe(200);
      expect(await patchedMissing.json()).toMatchObject({ path: missingPath, pathExists: false });

      const unknown = await app.request('/projects/999', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ notes: 'x' }) });
      expect(unknown.status).toBe(404);
    } finally { rmSync(root, { recursive: true, force: true }); }
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
  it('notifies loaded plugins before a Project row is removed', async () => {
    let db!: ReturnType<typeof openDb>;
    const seen: number[] = [];
    const built = makeApp({ projectRemoved: (id) => {
      seen.push(id);
      expect(db.prepare('SELECT 1 FROM projects WHERE id = ?').get(id)).toBeTruthy();
    } });
    db = built.db;
    const created = await (await built.app.request('/projects', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ slug: 'plugin-owned', path: '/p' }),
    })).json() as { id: number };
    expect((await built.app.request(`/projects/${created.id}`, { method: 'DELETE' })).status).toBe(200);
    expect(seen).toEqual([created.id]);
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
  it('POST /fs/dirs creates one child atomically and maps invalid, duplicate and missing-parent requests', async () => {
    const { app } = makeApp();
    const root = mkdtempSync(join(tmpdir(), 'elowen-fsdirs-create-'));
    try {
      const created = await app.request('/fs/dirs', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ parent: root, name: 'new-app' }),
      });
      expect(created.status).toBe(201);
      expect(await created.json()).toEqual({ path: join(root, 'new-app') });
      expect(existsSync(join(root, 'new-app'))).toBe(true);

      for (const name of ['', '.', '..', '.git', 'nested/path', 'nested\\path', 'bad\0name', 'x'.repeat(256), 'é'.repeat(128)]) {
        const invalid = await app.request('/fs/dirs', {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ parent: root, name }),
        });
        expect(invalid.status, name).toBe(400);
      }

      const duplicate = await app.request('/fs/dirs', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ parent: root, name: 'new-app' }),
      });
      expect(duplicate.status).toBe(409);
      expect(await duplicate.json()).toEqual({ error: 'directory already exists' });

      const missingParent = await app.request('/fs/dirs', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ parent: join(root, 'missing'), name: 'child' }),
      });
      expect(missingParent.status).toBe(400);
      expect(await missingParent.json()).toEqual({ error: 'invalid parent directory' });

      const tooLongForOs = await app.request('/fs/dirs', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ parent: `/${'x'.repeat(300)}`, name: 'child' }),
      });
      expect(tooLongForOs.status).toBe(400);
      expect(await tooLongForOs.json()).toEqual({ error: 'invalid directory name' });
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
