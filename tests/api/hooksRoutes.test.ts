import { describe, it, expect } from 'vitest';
import { TaskStore } from '../../plugins/work/src/store/taskStore.js';
import { Readiness } from '../../plugins/work/src/store/readiness.js';
import { MissionStore } from '../../plugins/agents/src/store/missionStore.js';
import { ProjectStore } from '../../src/store/projectStore.js';
import { UserStore } from '../../src/store/userStore.js';
import { UserProjectStore } from '../../src/store/userProjectStore.js';
import { ConfigStore } from '../../src/store/configStore.js';
import { EventBus } from '../../src/api/sse.js';
import { createServer } from '../../src/api/server.js';
import { PluginRegistry } from '../../src/plugins/registry.js';
import { PluginRegistryProvider } from '../../src/plugins/pluginsProvider.js';
import type { PluginHttpRoute } from '../../src/plugins/api.js';
import { openPluginTablesDb } from '../helpers/pluginTablesDb.js';

class FakeClock { constructor(private t: number) {} now(): number { return this.t; } }

/** A registry with hook mounts, registered through the real contextFor gate and merged the way the
 *  loader stages contributions — so the tests exercise the exact production path. */
function registryWith(routes: { plugin: string; declared: string[]; route: PluginHttpRoute }[]): PluginRegistry {
  const registry = new PluginRegistry();
  for (const { plugin, declared, route } of routes) {
    const staged = new PluginRegistry();
    staged.contextFor(
      plugin, {}, { info: () => {}, warn: () => {}, error: () => {} } as never,
      undefined, undefined, undefined, undefined, undefined,
      { httpRoutes: declared },
    ).registerHttpRoute(route);
    registry.merge(staged);
  }
  return registry;
}

function setup(registry: PluginRegistry | undefined) {
  const db = openPluginTablesDb(':memory:');
  db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'elowen','/o')").run();
  const users = new UserStore(db);
  const admin = users.create('admin', 'pw');
  const app = createServer({
    tasks: new TaskStore(db), readiness: new Readiness(db), missions: new MissionStore(db), bus: new EventBus(),
    engine: null as never, spawn: null as never, tmux: null as never,
    project: { id: 1, path: '/o' }, fallback: { program: 'claude-code', model: 'sonnet' },
    clock: new FakeClock(0) as never, config: new ConfigStore(db), users,
    projects: new ProjectStore(db), userProjects: new UserProjectStore(db),
    plugins: registry ? new PluginRegistryProvider(() => Promise.resolve(registry)) : undefined,
  });
  return { app, token: users.issueToken(admin.id) };
}

describe('hook routes', () => {
  it('dispatches to the registered mount without a bearer token', async () => {
    const seen: { path: string; method: string; body: unknown }[] = [];
    const registry = registryWith([{
      plugin: 'msteams', declared: ['messages'],
      route: { path: 'messages', handler: async (req) => { seen.push({ path: req.path, method: req.method, body: await req.json() }); return { status: 200, body: { ok: true } }; } },
    }]);
    const { app } = setup(registry);
    const res = await app.request('/hooks/msteams/messages', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'message' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(seen).toEqual([{ path: '', method: 'POST', body: { type: 'message' } }]);
  });

  it('routes a longer path to the longest declared prefix, passing the remainder', async () => {
    const paths: string[] = [];
    const registry = registryWith([{
      plugin: 'msteams', declared: ['messages'],
      route: { path: 'messages', handler: async (req) => { paths.push(req.path); return {}; } },
    }]);
    const { app } = setup(registry);
    expect((await app.request('/hooks/msteams/messages/sub/leaf', { method: 'POST' })).status).toBe(200);
    expect(paths).toEqual(['sub/leaf']);
  });

  it('404s an unknown mount and keeps bearer auth on non-hook routes', async () => {
    const { app, token } = setup(registryWith([]));
    expect((await app.request('/hooks/nope/messages', { method: 'POST' })).status).toBe(404);
    // The public carve-out is scoped to /hooks/ — a plugin admin route still requires auth.
    expect((await app.request('/plugins')).status).toBe(401);
    expect((await app.request('/plugins', { headers: { authorization: `Bearer ${token}` } })).status).toBe(200);
  });

  it('rejects an oversized body with 413 before the handler runs', async () => {
    let called = 0;
    const registry = registryWith([{
      plugin: 'msteams', declared: ['messages'],
      route: { path: 'messages', handler: async () => { called += 1; return {}; } },
    }]);
    const { app } = setup(registry);
    const res = await app.request('/hooks/msteams/messages', { method: 'POST', body: 'x'.repeat(1024 * 1024 + 1) });
    expect(res.status).toBe(413);
    expect(called).toBe(0);
  });

  it('stops reading an oversized chunked body instead of buffering it whole', async () => {
    // Webhook mounts are public and the dispatcher buffers the body (arrayBuffer) to hand it to the
    // plugin. A chunked request declares no content-length, so the cap must bound the READ itself —
    // checking the buffered length afterwards means the daemon already holds the whole payload.
    let called = 0;
    const registry = registryWith([{
      plugin: 'msteams', declared: ['messages'],
      route: { path: 'messages', handler: async () => { called += 1; return {}; } },
    }]);
    const { app } = setup(registry);
    let pulled = 0;
    const chunk = 64 * 1024;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulled >= 8 * 1024 * 1024) { controller.close(); return; }
        pulled += chunk;
        controller.enqueue(new Uint8Array(chunk).fill(0x78));
      },
    });
    const res = await app.request('/hooks/msteams/messages', { method: 'POST', body, duplex: 'half' });
    expect(res.status).toBe(413);
    expect(called).toBe(0);
    expect(pulled).toBeLessThan(2 * 1024 * 1024); // stopped near the 1 MB cap, not after the whole 8 MB
  });

  it('maps a handler throw to an opaque 500', async () => {
    const registry = registryWith([{
      plugin: 'msteams', declared: ['messages'],
      route: { path: 'messages', handler: async () => { throw new Error('secret internal detail'); } },
    }]);
    const { app } = setup(registry);
    const res = await app.request('/hooks/msteams/messages', { method: 'POST' });
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain('secret internal detail');
  });

  it('reflects a reloaded registry on the next request', async () => {
    const first = registryWith([]);
    const second = registryWith([{
      plugin: 'msteams', declared: ['messages'],
      route: { path: 'messages', handler: async () => ({ body: { v: 2 } }) },
    }]);
    let current = first;
    const provider = new PluginRegistryProvider(() => Promise.resolve(current));
    const db = openPluginTablesDb(':memory:');
    db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'elowen','/o')").run();
    const users = new UserStore(db);
    users.create('admin', 'pw');
    const app = createServer({
      tasks: new TaskStore(db), readiness: new Readiness(db), missions: new MissionStore(db), bus: new EventBus(),
      engine: null as never, spawn: null as never, tmux: null as never,
      project: { id: 1, path: '/o' }, fallback: { program: 'claude-code', model: 'sonnet' },
      clock: new FakeClock(0) as never, config: new ConfigStore(db), users,
      projects: new ProjectStore(db), userProjects: new UserProjectStore(db),
      plugins: provider,
    });
    expect((await app.request('/hooks/msteams/messages', { method: 'POST' })).status).toBe(404);
    current = second;
    provider.invalidate();
    expect((await app.request('/hooks/msteams/messages', { method: 'POST' })).status).toBe(200);
  });
});

describe('registry http-route gating', () => {
  it('refuses an undeclared or malformed mount, keeps a declared one', () => {
    const warns: string[] = [];
    const registry = new PluginRegistry();
    const ctx = registry.contextFor(
      'msteams', {}, { info: () => {}, warn: (m: string) => warns.push(m), error: () => {} } as never,
      undefined, undefined, undefined, undefined, undefined,
      { httpRoutes: ['messages'] },
    );
    ctx.registerHttpRoute({ path: 'messages', handler: async () => ({}) });
    ctx.registerHttpRoute({ path: 'undeclared', handler: async () => ({}) });
    ctx.registerHttpRoute({ path: '../escape', handler: async () => ({}) });
    ctx.registerHttpRoute({ path: 'Bad/Case', handler: async () => ({}) });
    expect([...registry.httpRoutes.keys()]).toEqual(['msteams/messages']);
    expect(warns.some((w) => w.includes("registerHttpRoute('undeclared') refused"))).toBe(true);
  });

  it('requires an explicit provides.httpRoutes declaration — no legacy fallback', () => {
    const registry = new PluginRegistry();
    const ctx = registry.contextFor(
      'legacy', {}, { info: () => {}, warn: () => {}, error: () => {} } as never,
    );
    ctx.registerHttpRoute({ path: 'messages', handler: async () => ({}) });
    expect(registry.httpRoutes.size).toBe(0);
  });
});
