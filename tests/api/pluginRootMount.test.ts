import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeTestApp } from '../helpers/testApp.js';
import { loadPlugins } from '../../src/plugins/loader.js';
import { PluginRegistryProvider } from '../../src/plugins/pluginsProvider.js';

// The loader only reads real plugin folders, so the fixture is written to disk and swept afterwards.
let pluginRoots: string[] = [];
afterEach(() => { for (const p of pluginRoots) rmSync(p, { recursive: true, force: true }); pluginRoots = []; });

/** An on-disk plugin exercising ROOT-mounted routes: a mount with sub-paths and per-route access,
 *  a deliberate collision with the core '/tasks' surface, and an SSE stream. `marker` distinguishes
 *  plugin generations for the reload-idempotence test. */
function rootPluginProvider(marker = 'gen1'): { provider: PluginRegistryProvider; warnings: string[] } {
  const root = mkdtempSync(join(tmpdir(), 'plugin-root-'));
  pluginRoots.push(root);
  const dir = join(root, 'rooty');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'elowen-plugin.json'), JSON.stringify({
    name: 'rooty', version: '1.0.0', apiVersion: '1', description: 'root mount demo', entry: 'index.mjs',
    provides: { apiRoutes: ['/rooty', '/rooty/agent-poll', '/rooty/admin-knob', '/rooty/feed', '/tasks', '/plugins/rooty/:x', 'ns-ping'] },
  }));
  writeFileSync(join(dir, 'index.mjs'), `
    export function register(ctx){
      ctx.registerApiRoute({ rootMount: '/rooty', path: '', access: 'user', handler: async (req) => ({ body: { marker: '${marker}', remainder: req.path, auth: req.auth } }) });
      ctx.registerApiRoute({ rootMount: '/rooty', path: '', method: 'POST', access: 'user', handler: async (req) => ({ status: 201, body: { created: await req.json() } }) });
      ctx.registerApiRoute({ rootMount: '/rooty/agent-poll', path: '', access: 'agent', handler: async (req) => ({ body: { scope: req.auth.tokenScope } }) });
      ctx.registerApiRoute({ rootMount: '/rooty/admin-knob', path: '', access: 'admin', handler: async () => ({ body: { secret: 7 } }) });
      ctx.registerApiRoute({ rootMount: '/rooty/feed', path: '', access: 'user', handler: async () => ({ sse: async (send) => { await send('one', 'tick'); await send('two', 'tick'); } }) });
      // Collides with the core '/tasks' family — the dispatcher must skip it with a warning.
      ctx.registerApiRoute({ rootMount: '/tasks', path: '', access: 'user', handler: async () => ({ body: { hijacked: true } }) });
      // Same mount, but a METHOD core does not serve on /tasks — the skip is per method, so this lives.
      ctx.registerApiRoute({ rootMount: '/tasks', path: '', method: 'PUT', access: 'user', handler: async () => ({ body: { methodScoped: true } }) });
      // A PATTERN mount partially overlapped by core literals (GET /plugins/:name/icon etc.) — core
      // wins those literal paths by matching first; the mount still serves everything else.
      ctx.registerApiRoute({ rootMount: '/plugins/rooty/:x', path: '', method: 'GET', access: 'user', handler: async (req) => ({ body: { param: req.params.x } }) });
      // Root mount not declared in provides.apiRoutes — refused at register time.
      ctx.registerApiRoute({ rootMount: '/sneaky', path: '', access: 'user', handler: async () => ({ body: {} }) });
      // Namespaced route keeps working beside the root mounts.
      ctx.registerApiRoute({ path: 'ns-ping', access: 'user', handler: async () => ({ body: { ns: true } }) });
    }
  `);
  const warnings: string[] = [];
  const provider = new PluginRegistryProvider(() => loadPlugins({
    dirs: [root], enabled: ['rooty'], logger: { info() {}, warn(m: string) { warnings.push(m); }, error() {} },
  }));
  return { provider, warnings };
}

const auth = (token: string) => ({ headers: { authorization: `Bearer ${token}` } });

describe('root-mounted plugin API routes', () => {
  it('serves a root path with the same auth mechanics as the namespaced surface', async () => {
    const { provider } = rootPluginProvider();
    const { app, token } = await makeTestApp({ extra: { plugins: provider } });
    expect((await app.request('/rooty')).status).toBe(401); // bearer required — auth guards run first
    const res = await app.request('/rooty', auth(token));
    expect(res.status).toBe(200);
    const body = await res.json() as { marker: string; auth: { admin: boolean; tokenScope: string } };
    expect(body.marker).toBe('gen1');
    expect(body.auth.admin).toBe(true);
    // Method routing under the same mount.
    const posted = await app.request('/rooty', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{"a":1}' });
    expect(posted.status).toBe(201);
    expect(await posted.json()).toEqual({ created: { a: 1 } });
    // The namespaced surface still serves beside the root mounts.
    expect((await (await app.request('/plugins/rooty/api/ns-ping', auth(token))).json())).toEqual({ ns: true });
  });

  it('enforces declared access levels on root mounts (agent / admin)', async () => {
    const { provider } = rootPluginProvider();
    const { app, token, deps } = await makeTestApp({ extra: { plugins: provider } });
    // A user token may call an agent route; an agent token must NOT reach a plain user route.
    expect((await app.request('/rooty/agent-poll', auth(token))).status).toBe(200);
    const admin = deps.users.list()[0]!;
    const agentTok = deps.users.ensureAgentTokenForTask(admin.id, 'task-x');
    expect((await app.request('/rooty/agent-poll', auth(agentTok))).status).toBe(200); // declared access:'agent'
    expect((await app.request('/rooty', auth(agentTok))).status).toBe(403);
    expect((await app.request('/rooty/admin-knob', auth(token))).status).toBe(200); // admin user passes
  });

  it('skips a mount a core route owns, with a warning — core wins (mutation test)', async () => {
    const { provider, warnings } = rootPluginProvider();
    const { app, token } = await makeTestApp({ extra: { plugins: provider } });
    // Touch a plugin-served path first: plugin loading is lazy, and a core-answered /tasks request
    // never reaches the fallback dispatcher (that ordering IS the "core wins" guarantee).
    expect((await app.request('/rooty', auth(token))).status).toBe(200);
    const res = await app.request('/tasks', auth(token));
    expect(res.status).toBe(200);
    const body = await res.json() as unknown[];
    expect(Array.isArray(body)).toBe(true); // the core task list answered, not the hijacker
    expect(warnings.some((w) => w.includes("registerApiRoute('/sneaky') refused"))).toBe(true); // undeclared mount refused
  });

  it('the core-conflict skip is per METHOD, and a partial pattern overlap is not a conflict', async () => {
    const { provider } = rootPluginProvider();
    const { app, token } = await makeTestApp({ extra: { plugins: provider } });
    // GET /tasks is fully core-owned (skipped above); PUT /tasks is a method core never serves there,
    // so the plugin's method-scoped route answers instead of being dropped alongside the GET.
    const put = await app.request('/tasks', { method: 'PUT', ...auth(token) });
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({ methodScoped: true });
    // The pattern mount '/plugins/rooty/:x' overlaps core's '/plugins/:name/icon' only on the literal
    // 'icon' path. It must NOT be dropped: core answers 'icon' (it matched first), the plugin the rest.
    const other = await app.request('/plugins/rooty/whatever', auth(token));
    expect(other.status).toBe(200);
    expect(await other.json()).toEqual({ param: 'whatever' });
    const icon = await app.request('/plugins/rooty/icon', auth(token));
    expect(icon.status).toBe(404); // the CORE icon route answered (no plugin dirs wired here)
    expect(await icon.json()).toEqual({ error: 'unknown plugin' });
  });

  it('a plugin reload swaps handlers without stacking a second registration (single response)', async () => {
    const { provider } = rootPluginProvider();
    const { app, token } = await makeTestApp({ extra: { plugins: provider } });
    expect(((await (await app.request('/rooty', auth(token))).json()) as { marker: string }).marker).toBe('gen1');
    // Simulate the reload: a NEW plugin generation behind the same provider (invalidate + new loader).
    const gen2 = rootPluginProvider('gen2').provider;
    (provider as unknown as { load: () => Promise<unknown> }).load = () => gen2.get() as Promise<never>;
    provider.invalidate();
    const res = await app.request('/rooty', auth(token));
    expect(res.status).toBe(200);
    // The dispatcher itself is registered exactly once, so the swap can never stack a second handler:
    // the body parses as ONE json document served by the NEW generation.
    expect(((await res.json()) as { marker: string }).marker).toBe('gen2');
  });

  it('streams SSE from a root-mounted route', async () => {
    const { provider } = rootPluginProvider();
    const { app, token } = await makeTestApp({ extra: { plugins: provider } });
    const res = await app.request('/rooty/feed', auth(token));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const text = await res.text();
    expect(text).toContain('event: tick');
    expect(text).toContain('data: one');
    expect(text).toContain('data: two');
  });

  it('a DECLARED mount of a discovered-but-disabled plugin answers 503, not 404', async () => {
    // The plugin sits on disk (manifest declares its root mounts) but is NOT enabled — the registry
    // has no live handler. A caller must learn "subsystem off", not chase a phantom endpoint: the
    // CLI and spawned agents surface this error text verbatim.
    const root = mkdtempSync(join(tmpdir(), 'plugin-root-'));
    pluginRoots.push(root);
    const dir = join(root, 'rooty');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'elowen-plugin.json'), JSON.stringify({
      name: 'rooty', version: '1.0.0', apiVersion: '1', description: 'disabled demo', entry: 'index.mjs',
      provides: { apiRoutes: ['/rooty', '/tasks/:id/probe'] },
    }));
    writeFileSync(join(dir, 'index.mjs'), 'export function register(){}');
    const provider = new PluginRegistryProvider(() => loadPlugins({
      dirs: [root], enabled: [], logger: { info() {}, warn() {}, error() {} },
    }));
    const { app, token } = await makeTestApp({ extra: { plugins: provider, pluginDirs: [root] } });
    const res = await app.request('/rooty', auth(token));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'rooty plugin is disabled' });
    // Sub-paths and :param mounts resolve by the same prefix rules as the live dispatcher.
    expect((await app.request('/rooty/deep/sub', auth(token))).status).toBe(503);
    // An undeclared path is still a plain 404 — 503 never leaks beyond declared mounts.
    expect((await app.request('/rooty-nope', auth(token))).status).toBe(404);
  });

  it('unknown root path still 404s through the fallback', async () => {
    const { provider } = rootPluginProvider();
    const { app, token } = await makeTestApp({ extra: { plugins: provider } });
    expect((await app.request('/rooty-nope', auth(token))).status).toBe(404);
  });

  it('falls through to a route registered AFTER the dispatcher (the /ws/terminal pattern)', async () => {
    // daemon/index.ts registers the /ws/terminal upgrade on the app AFTER bootstrap built it — i.e.
    // after the root-mount dispatcher. A terminal catch-all would answer 404 before that handler
    // ever ran (a real regression: the terminal WS died); the dispatcher must be pass-through.
    const { provider } = rootPluginProvider();
    const { app, token } = await makeTestApp({ extra: { plugins: provider } });
    app.get('/registered-later', (c) => c.json({ late: true }));
    const res = await app.request('/registered-later', auth(token));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ late: true });
    // The plugin mount itself still answers — fall-through did not disable dispatch.
    expect((await app.request('/rooty', auth(token))).status).toBe(200);
  });
});
