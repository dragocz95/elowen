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

/** An on-disk plugin exercising the authenticated API surface: one route per access level, a method-
 *  scoped route, a prefix mount, and one route deliberately NOT declared in provides.apiRoutes. */
function apiPluginProvider(): PluginRegistryProvider {
  const root = mkdtempSync(join(tmpdir(), 'plugin-api-'));
  pluginRoots.push(root);
  const dir = join(root, 'demo');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'elowen-plugin.json'), JSON.stringify({
    name: 'demo', version: '1.0.0', apiVersion: '1', description: 'demo', entry: 'index.mjs',
    provides: { apiRoutes: ['ping', 'admin-only', 'agent-work', 'items', 'echo'] },
  }));
  writeFileSync(join(dir, 'index.mjs'), `
    export function register(ctx){
      ctx.registerApiRoute({ path: 'ping', access: 'user', handler: async (req) => ({ body: { ok: true, auth: req.auth } }) });
      ctx.registerApiRoute({ path: 'admin-only', access: 'admin', handler: async () => ({ body: { secret: 42 } }) });
      ctx.registerApiRoute({ path: 'agent-work', access: 'agent', handler: async (req) => ({ body: { scope: req.auth.tokenScope, task: req.auth.agentTask } }) });
      ctx.registerApiRoute({ path: 'items', method: 'POST', access: 'user', handler: async (req) => ({ status: 201, body: { created: await req.json() } }) });
      ctx.registerApiRoute({ path: 'items', access: 'user', handler: async (req) => ({ body: { listed: true, remainder: req.path } }) });
      ctx.registerApiRoute({ path: 'echo', access: 'user', handler: async (req) => ({ body: { q: req.query } }) });
      // Undeclared path — the registry must refuse it at register time.
      ctx.registerApiRoute({ path: 'sneaky', access: 'user', handler: async () => ({ body: {} }) });
    }
  `);
  return new PluginRegistryProvider(() => loadPlugins({
    dirs: [root], enabled: ['demo'], logger: { info() {}, warn() {}, error() {} },
  }));
}

const makeApp = async () => makeTestApp({ extra: { plugins: apiPluginProvider() } });
const auth = (token: string) => ({ headers: { authorization: `Bearer ${token}` } });

describe('authenticated plugin API routes (/plugins/:name/api/*)', () => {
  it('requires a bearer and hands the handler a verified identity block', async () => {
    const { app, token } = await makeApp();
    expect((await app.request('/plugins/demo/api/ping')).status).toBe(401);
    const res = await app.request('/plugins/demo/api/ping', auth(token));
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; auth: { userId: number; admin: boolean; tokenScope: string; agentTask: string | null; accessibleProjects: number[] | null } };
    expect(body.ok).toBe(true);
    expect(body.auth.admin).toBe(true);
    expect(body.auth.tokenScope).toBe('user');
    expect(body.auth.agentTask).toBeNull();
    expect(body.auth.accessibleProjects).toBeNull(); // admin = unrestricted
  });

  it('404s an unknown plugin, an unknown path and an UNDECLARED path (deny-by-default)', async () => {
    const { app, token } = await makeApp();
    expect((await app.request('/plugins/ghost/api/ping', auth(token))).status).toBe(404);
    expect((await app.request('/plugins/demo/api/nope', auth(token))).status).toBe(404);
    // registered in code but missing from provides.apiRoutes → refused at register time → 404 here
    expect((await app.request('/plugins/demo/api/sneaky', auth(token))).status).toBe(404);
  });

  it('method routing: exact method wins, method-less catches the rest; prefix carries the remainder', async () => {
    const { app, token } = await makeApp();
    const created = await app.request('/plugins/demo/api/items', {
      method: 'POST', headers: { ...auth(token).headers, 'content-type': 'application/json' }, body: '{"a":1}',
    });
    expect(created.status).toBe(201);
    expect(await created.json()).toEqual({ created: { a: 1 } });
    const listed = await app.request('/plugins/demo/api/items/sub/path', auth(token));
    expect(await listed.json()).toEqual({ listed: true, remainder: 'sub/path' });
  });

  it('query params reach the handler', async () => {
    const { app, token } = await makeApp();
    const res = await app.request('/plugins/demo/api/echo?x=1&y=two', auth(token));
    expect(await res.json()).toEqual({ q: { x: '1', y: 'two' } });
  });

  // The agent service token runs with skipped permissions — it must reach ONLY a route that opted into
  // access:'agent'. This is the plugin-surface twin of the core agent allow-list.
  it("an agent token reaches only routes declaring access:'agent' (deny-by-default)", async () => {
    const { app, deps } = await makeApp();
    const admin = deps.users.list()[0]!;
    const agentTok = deps.users.ensureAgentTokenForTask(admin.id, 'task-x');
    expect((await app.request('/plugins/demo/api/ping', auth(agentTok))).status).toBe(403);
    expect((await app.request('/plugins/demo/api/admin-only', auth(agentTok))).status).toBe(403);
    const res = await app.request('/plugins/demo/api/agent-work', auth(agentTok));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ scope: 'agent', task: 'task-x' });
  });

  it('an admin route refuses a non-admin user and serves the admin', async () => {
    const { app, token, deps } = await makeApp();
    const amy = deps.users.create('amy', 'pw');
    const amyTok = deps.users.issueToken(amy.id);
    expect((await app.request('/plugins/demo/api/admin-only', auth(amyTok))).status).toBe(403);
    expect((await app.request('/plugins/demo/api/admin-only', auth(token))).status).toBe(200);
  });
});
