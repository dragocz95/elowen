import { describe, it, expect, vi, afterEach } from 'vitest';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { openPluginTablesDb } from '../helpers/pluginTablesDb.js';
import { makePluginDb } from '../../src/store/pluginDb.js';
import type { Db } from '../../src/store/db.js';
import { UserStore } from '../../src/store/userStore.js';
import { channelSessionId, skillOwnerForSession } from '../../src/brain/sessionId.js';
import { composeSessionTools } from '../../src/brain/session/capabilities.js';
import { currentIdentity, runWithPolicy } from '../../src/plugins/policyContext.js';
// The plugin is a plain ESM module (no build step) — import it directly.
// @ts-expect-error - .mjs plugin has no type declarations
import { register, killTree, sanitize, mapResult, DetachedStdioTransport, configNumber, listMcpServers, reconnectMcpServer, mcpBridgeSnapshot } from '../../plugins/mcp/index.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const MOCK_SERVER = join(here, '../fixtures/mock-mcp-server.mjs');
const PAGINATED_MOCK_SERVER = join(here, '../fixtures/mock-mcp-paginated-server.mjs');
const LATENCY_MOCK_SERVER = join(here, '../fixtures/mock-mcp-latency-server.mjs');
const SLOW_INIT_MOCK_SERVER = join(here, '../fixtures/mock-mcp-slow-init-server.mjs');

const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn: () => boolean, ms = 3000) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await wait(50); } return fn(); };

/** A minimal PluginContext stand-in capturing the tools/hooks the plugin registers. `mcpBridgeSnapshot`
 *  is what a forked sub-agent runner is handed: present ⇒ declare these tools and connect nothing. */
function fakeCtx(config: Record<string, unknown>, mcpBridgeSnapshot?: unknown, db: Db = openPluginTablesDb(), identity: object | null | (() => object | null) = null) {
  const tools: { name: string; execute: (id: string, args: unknown) => Promise<unknown>; ownerUserId?: number }[] = [];
  const hooks: { name: string; run: (p: unknown) => unknown }[] = [];
  const controls = new Map<string, unknown>();
  const apiRoutes: { path: string; method?: string; handler: (req: unknown) => Promise<unknown> }[] = [];
  const userRemoved: ((userId: number) => Promise<void> | void)[] = [];
  return {
    config,
    ...(mcpBridgeSnapshot ? { mcpBridgeSnapshot } : {}),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    db: () => makePluginDb(db, 'mcp', { canMigrate: true }),
    currentIdentity: () => typeof identity === 'function' ? identity() : identity,
    requestReload: vi.fn(),
    registerTool: (t: { name: string; execute: (id: string, args: unknown) => Promise<unknown> }, opts?: { ownerUserId?: number }) => tools.push({ ...t, ...opts }),
    registerHook: (h: { name: string; run: (p: unknown) => unknown }) => hooks.push(h),
    registerControl: (name: string, control: unknown) => controls.set(name, control),
    registerApiRoute: (route: { path: string; method?: string; handler: (req: unknown) => Promise<unknown> }) => apiRoutes.push(route),
    registerUserRemoved: (handler: (userId: number) => Promise<void> | void) => userRemoved.push(handler),
    tools, hooks, controls, apiRoutes, userRemoved, rawDb: db,
  };
}

describe('mcp plugin — helpers', () => {
  it('sanitize produces a safe tool-name token', () => {
    expect(sanitize('Chrome DevTools!')).toBe('chrome_devtools');
    expect(sanitize('')).toBe('x');
  });

  it('mapResult maps MCP content to a brain tool result', () => {
    expect(mapResult({ content: [{ type: 'text', text: 'hi' }] })).toEqual({ content: [{ type: 'text', text: 'hi' }], details: { ok: true, isError: false } });
    expect(mapResult({ content: [], isError: true }).details.isError).toBe(true);
    expect(mapResult({ content: [], isError: true }).details.ok).toBe(false);
  });

  it('mapResult passes inline-supported image parts through as REAL image blocks', () => {
    expect(mapResult({ content: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }] }))
      .toEqual({ content: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }], details: { ok: true, isError: false } });
  });

  it('mapResult collapses non-inlineable parts to a short placeholder, never the raw payload', () => {
    const audio = { type: 'audio', data: 'Q'.repeat(10_000), mimeType: 'audio/wav' };
    expect(mapResult({ content: [audio] }).content).toEqual([{ type: 'text', text: '[audio content omitted]' }]);
    const resource = { type: 'resource', resource: { uri: 'file:///x', blob: 'Z'.repeat(10_000) } };
    expect(mapResult({ content: [resource] }).content).toEqual([{ type: 'text', text: '[resource content omitted]' }]);
    // An image with an unsupported/inline-hostile mime type is placeholdered too, not stringified.
    expect(mapResult({ content: [{ type: 'image', data: 'AAAA', mimeType: 'image/tiff' }] }).content)
      .toEqual([{ type: 'text', text: '[image content omitted]' }]);
    expect(mapResult({ content: [{}] }).content).toEqual([{ type: 'text', text: '[unknown content omitted]' }]);
  });

  it('killTree kills the whole process group (negative pid)', () => {
    const spy = vi.spyOn(process, 'kill').mockImplementation(() => true as never);
    killTree({ pid: 4242 });
    expect(spy).toHaveBeenCalledWith(-4242, 'SIGKILL');
    spy.mockRestore();
  });

  it('configNumber falls back to the default when unset/invalid, passes through in-range overrides, and clamps out-of-range ones', () => {
    expect(configNumber(undefined, 15_000, 5000, 60_000)).toBe(15_000); // unset -> CONNECT_TIMEOUT_MS default
    expect(configNumber(30_000, 15_000, 5000, 60_000)).toBe(30_000); // in-range override
    expect(configNumber(1, 15_000, 5000, 60_000)).toBe(5000); // clamped to min
    expect(configNumber(999_999, 15_000, 5000, 60_000)).toBe(60_000); // clamped to max
    expect(configNumber(undefined, 120_000, 30_000, 300_000)).toBe(120_000); // unset -> CALL_TIMEOUT_MS default
  });

  it('DetachedStdioTransport frames messages by line', async () => {
    const listeners: Record<string, ((c: unknown) => void)[]> = {};
    const child = {
      stdout: { on: (ev: string, cb: (c: unknown) => void) => { (listeners[ev] ??= []).push(cb); } },
      stdin: { written: [] as string[], write(s: string) { this.written.push(s); } },
      on: () => {},
    };
    const t = new DetachedStdioTransport(child);
    const got: unknown[] = [];
    t.onmessage = (m: unknown) => got.push(m);
    await t.start();
    // Feed a complete JSON-RPC line + a split one.
    listeners.data![0]!(Buffer.from('{"jsonrpc":"2.0","id":1,"result":{}}\n{"jsonrpc":"2.0",'));
    listeners.data![0]!(Buffer.from('"id":2,"result":{}}\n'));
    expect(got).toEqual([{ jsonrpc: '2.0', id: 1, result: {} }, { jsonrpc: '2.0', id: 2, result: {} }]);
    await t.send({ jsonrpc: '2.0', id: 9, method: 'ping' });
    expect(child.stdin.written[0]).toContain('"method":"ping"');
    expect(child.stdin.written[0]!.endsWith('\n')).toBe(true);
  });
});

describe('mcp plugin — owner-scoped management tools', () => {
  const resultText = (result: unknown) => (result as { content: { text: string }[] }).content[0]!.text;

  it('requires an explicit scope in every management tool schema', async () => {
    const ctx = fakeCtx({});
    await register(ctx as never);
    for (const name of ['AddMcpServer', 'ListMcpServers', 'RemoveMcpServer', 'ReconnectMcpServer']) {
      const tool = ctx.tools.find((candidate) => candidate.name === name) as unknown as { parameters: { required?: string[] } };
      expect(tool.parameters.required).toContain('scope');
    }
    await ctx.hooks.find((hook) => hook.name === 'plugin.reload.before')!.run({});
  });

  it('refuses a shared-room non-owner before a personal stdio transport can start', async () => {
    const db = openPluginTablesDb();
    const member = new UserStore(db).create('shared-member', 'pw');
    const ctx = fakeCtx({}, undefined, db, () => currentIdentity());
    await register(ctx as never);
    const add = composeSessionTools({ kind: 'foreign-channel', pluginTools: ctx.tools as never })
      .find((tool) => tool.name === 'AddMcpServer')!;
    expect(add, 'management tool is advertised in the shared-channel session').toBeTruthy();

    const result = await runWithPolicy(
      { allowedProjectIds: 'all', allowedPaths: () => [] },
      () => add.execute('shared-call', {
        scope: 'personal', name: 'blocked-stdio', transport: 'stdio',
        command: process.execPath, args: [MOCK_SERVER],
      } as never, undefined, undefined, {} as never),
      { identity: { platform: 'discord', userId: 'member-7', elowenUserId: member.id, elowenUsername: member.username, admin: false, owner: false, conversation: 'shared' } },
    );
    expect(resultText(result)).toContain('local-process MCP servers can be managed only by administrators of this instance');
    expect((db.prepare('SELECT COUNT(*) AS n FROM p_mcp_servers').get() as { n: number }).n).toBe(0);
    await ctx.hooks.find((hook) => hook.name === 'plugin.reload.before')!.run({});
  }, 20000);

  it('refuses instance scope for a non-owner even when the account is an admin elsewhere', async () => {
    const ctx = fakeCtx({}, undefined, openPluginTablesDb(), { elowenUserId: 4, admin: true, owner: false });
    await register(ctx as never);
    const add = ctx.tools.find((tool) => tool.name === 'AddMcpServer')!;
    const result = await add.execute('1', { scope: 'instance', name: 'blocked', transport: 'stdio', command: process.execPath, enabled: false });
    expect(resultText(result)).toContain('instance MCP servers can be managed only by administrators of this instance');
    expect((ctx.rawDb.prepare('SELECT COUNT(*) AS n FROM p_mcp_servers').get() as { n: number }).n).toBe(0);
    await ctx.hooks.find((hook) => hook.name === 'plugin.reload.before')!.run({});
  });

  it('does not treat a caller with no account as the owner of instance rows', async () => {
    const ctx = fakeCtx({}, undefined, openPluginTablesDb(), { owner: false });
    await register(ctx as never);
    const list = ctx.tools.find((tool) => tool.name === 'ListMcpServers')!;
    expect(resultText(await list.execute('1', { scope: 'personal' }))).toContain('personal MCP servers require a linked Elowen account');
    await ctx.hooks.find((hook) => hook.name === 'plugin.reload.before')!.run({});
  });

  it('settings API returns only the caller personal servers and owner-visible instance servers', async () => {
    const db = openPluginTablesDb();
    const users = new UserStore(db);
    const amy = users.create('amy-api', 'pw');
    const bob = users.create('bob-api', 'pw');
    const bootstrap = fakeCtx({}, undefined, db, { elowenUserId: amy.id, owner: false });
    await register(bootstrap as never);
    await bootstrap.hooks.find((hook) => hook.name === 'plugin.reload.before')!.run({});
    const insert = db.prepare('INSERT INTO p_mcp_servers (owner_user_id, name, spec_json, tools_json) VALUES (?, ?, ?, ?)');
    const stored = (name: string) => JSON.stringify({ name, enabled: false, transport: 'stdio', command: process.execPath });
    insert.run(amy.id, 'amy-private', stored('amy-private'), '[]');
    insert.run(bob.id, 'bob-private', stored('bob-private'), '[]');
    insert.run(null, 'shared', stored('shared'), '[]');

    const amyCtx = fakeCtx({}, undefined, db, { elowenUserId: amy.id, owner: false });
    await register(amyCtx as never);
    const get = amyCtx.apiRoutes.find((route) => route.path === 'servers' && route.method === 'GET')!;
    const amyBody = (await get.handler({})) as { body: { personal: { name: string }[]; instance: { name: string }[]; canManageInstance: boolean } };
    expect(amyBody.body.personal.map((server) => server.name)).toEqual(['amy-private']);
    expect(amyBody.body.instance).toEqual([]);
    expect(amyBody.body.canManageInstance).toBe(false);
    await amyCtx.hooks.find((hook) => hook.name === 'plugin.reload.before')!.run({});

    const ownerCtx = fakeCtx({}, undefined, db, { elowenUserId: amy.id, owner: true });
    await register(ownerCtx as never);
    const ownerGet = ownerCtx.apiRoutes.find((route) => route.path === 'servers' && route.method === 'GET')!;
    const ownerBody = (await ownerGet.handler({})) as { body: { personal: { name: string }[]; instance: { name: string }[] } };
    expect(ownerBody.body.personal.map((server) => server.name)).toEqual(['amy-private']);
    expect(ownerBody.body.instance.map((server) => server.name)).toEqual(['shared']);
    await ownerCtx.userRemoved[0]!(amy.id);
    expect((db.prepare('SELECT name FROM p_mcp_servers ORDER BY name').all() as { name: string }[]).map((row) => row.name)).toEqual(['bob-private', 'shared']);
    await ownerCtx.hooks.find((hook) => hook.name === 'plugin.reload.before')!.run({});
  });

  // Moving a server between scopes is its own operation: PATCH resolves the row in the scope it is ASKED
  // for, so a request naming the new scope reads to it as a server that does not exist.
  describe('scope transfer', () => {
    const remote = (name: string, scope: 'personal' | 'instance') =>
      ({ scope, name, transport: 'http', url: 'https://example.invalid/mcp', enabled: false });
    const transferRoute = (ctx: ReturnType<typeof fakeCtx>) =>
      ctx.apiRoutes.find((route) => route.path === 'transfer' && route.method === 'POST')!;
    const move = (ctx: ReturnType<typeof fakeCtx>, fromScope: string, name: string, toScope: string) =>
      transferRoute(ctx).handler({ json: async () => ({ fromScope, name, toScope }) }) as Promise<{ status?: number; body: Record<string, unknown> }>;
    const ownerOf = (db: Db, name: string) =>
      (db.prepare('SELECT owner_user_id FROM p_mcp_servers WHERE name = ?').get(name) as { owner_user_id: number | null }).owner_user_id;

    it('moves a remote server between the instance set and the caller own set, in both directions', async () => {
      const db = openPluginTablesDb();
      const amy = new UserStore(db).create('amy-move', 'pw');
      const ctx = fakeCtx({}, undefined, db, { elowenUserId: amy.id, owner: true });
      await register(ctx as never);
      const add = ctx.tools.find((tool) => tool.name === 'AddMcpServer')!;
      await add.execute('1', remote('shared-remote', 'instance'));
      expect(ownerOf(db, 'shared-remote')).toBeNull();

      const taken = await move(ctx, 'instance', 'shared-remote', 'personal');
      expect(taken.body.server).toMatchObject({ name: 'shared-remote', scope: 'personal' });
      expect(ownerOf(db, 'shared-remote')).toBe(amy.id);
      // It really left the instance set: the tool that lists that scope no longer sees it.
      const list = ctx.tools.find((tool) => tool.name === 'ListMcpServers')!;
      expect(resultText(await list.execute('2', { scope: 'instance' }))).toBe('No instance MCP servers configured.');
      expect(resultText(await list.execute('3', { scope: 'personal' }))).toContain('shared-remote');

      const given = await move(ctx, 'personal', 'shared-remote', 'instance');
      expect(given.body.server).toMatchObject({ scope: 'instance' });
      expect(ownerOf(db, 'shared-remote')).toBeNull();
      await ctx.hooks.find((hook) => hook.name === 'plugin.reload.before')!.run({});
    });

    // Whether a local process may run is authority the DESTINATION owner needs, and this plugin cannot
    // ask — it has no view of accounts, and assertTransportAuthority reads the CALLER, who is the wrong
    // person the moment a server changes hands. A move would also hand over the stored env.
    it('refuses to move a local-process server, leaving it where it was', async () => {
      const db = openPluginTablesDb();
      const amy = new UserStore(db).create('amy-stdio-move', 'pw');
      const ctx = fakeCtx({}, undefined, db, { elowenUserId: amy.id, owner: true });
      await register(ctx as never);
      const add = ctx.tools.find((tool) => tool.name === 'AddMcpServer')!;
      await add.execute('1', { scope: 'instance', name: 'local-proc', transport: 'stdio', command: process.execPath, enabled: false });

      const refused = await move(ctx, 'instance', 'local-proc', 'personal');
      expect(refused.status).toBe(409);
      expect(String(refused.body.error)).toMatch(/local-process/);
      expect(ownerOf(db, 'local-proc')).toBeNull();
      await ctx.hooks.find((hook) => hook.name === 'plugin.reload.before')!.run({});
    });

    it('refuses a move onto a name the destination scope already holds', async () => {
      const db = openPluginTablesDb();
      const amy = new UserStore(db).create('amy-clash', 'pw');
      const ctx = fakeCtx({}, undefined, db, { elowenUserId: amy.id, owner: true });
      await register(ctx as never);
      const add = ctx.tools.find((tool) => tool.name === 'AddMcpServer')!;
      // Personal first: an instance row of that name would block creating the personal one.
      await add.execute('1', remote('dup', 'personal'));
      await add.execute('2', remote('dup', 'instance'));

      const refused = await move(ctx, 'instance', 'dup', 'personal');
      expect(refused.status).toBe(409);
      expect(String(refused.body.error)).toMatch(/already exists/);
      // Both rows survive, each in the scope it was created in.
      const owners = (db.prepare('SELECT owner_user_id FROM p_mcp_servers WHERE name = ? ORDER BY owner_user_id IS NULL').all('dup') as { owner_user_id: number | null }[]);
      expect(owners.map((row) => row.owner_user_id)).toEqual([amy.id, null]);
      await ctx.hooks.find((hook) => hook.name === 'plugin.reload.before')!.run({});
    });

    // Both directions touch the instance set, so both are an administrator's decision — the same rule
    // that governs creating one.
    it('refuses a non-administrator either direction', async () => {
      const db = openPluginTablesDb();
      const amy = new UserStore(db).create('amy-nonadmin', 'pw');
      const ownerCtx = fakeCtx({}, undefined, db, { elowenUserId: amy.id, owner: true });
      await register(ownerCtx as never);
      await ownerCtx.tools.find((tool) => tool.name === 'AddMcpServer')!.execute('1', remote('mine', 'personal'));
      await ownerCtx.hooks.find((hook) => hook.name === 'plugin.reload.before')!.run({});

      const ctx = fakeCtx({}, undefined, db, { elowenUserId: amy.id, owner: false });
      await register(ctx as never);
      const refused = await move(ctx, 'personal', 'mine', 'instance');
      expect(refused.status).toBe(403);
      expect(ownerOf(db, 'mine')).toBe(amy.id);
      await ctx.hooks.find((hook) => hook.name === 'plugin.reload.before')!.run({});
    });
  });

  it('adds, lists and removes a personal server only for its owning account', async () => {
    const db = openPluginTablesDb();
    const users = new UserStore(db);
    const amy = users.create('amy-mcp', 'pw');
    const bob = users.create('bob-mcp', 'pw');
    const amyCtx = fakeCtx({}, undefined, db, { elowenUserId: amy.id, owner: true });
    await register(amyCtx as never);
    const add = amyCtx.tools.find((tool) => tool.name === 'AddMcpServer')!;
    const added = await add.execute('1', {
      scope: 'personal', name: 'private', transport: 'stdio', command: process.execPath, args: [MOCK_SERVER],
    });
    expect(resultText(added)).toContain('Added personal MCP server "private" with 1 tool(s)');
    expect((db.prepare('SELECT owner_user_id FROM p_mcp_servers WHERE name = ?').get('private') as { owner_user_id: number }).owner_user_id).toBe(amy.id);
    const patch = amyCtx.apiRoutes.find((route) => route.path === 'servers' && route.method === 'PATCH')!;
    const updated = await patch.handler({
      path: 'private',
      json: async () => ({ scope: 'personal', transport: 'stdio', command: process.execPath, args: [MOCK_SERVER], enabled: false }),
    }) as { body: { server: { status: string; enabled: boolean } } };
    expect(updated.body.server).toMatchObject({ status: 'disabled', enabled: false });
    await amyCtx.hooks.find((hook) => hook.name === 'plugin.reload.before')!.run({});

    const bobCtx = fakeCtx({}, undefined, db, { elowenUserId: bob.id, owner: false });
    await register(bobCtx as never);
    const bobList = bobCtx.tools.find((tool) => tool.name === 'ListMcpServers')!;
    expect(resultText(await bobList.execute('2', { scope: 'personal' }))).toBe('No personal MCP servers configured.');
    await bobCtx.hooks.find((hook) => hook.name === 'plugin.reload.before')!.run({});

    const amyAgain = fakeCtx({}, undefined, db, { elowenUserId: amy.id, owner: false });
    await register(amyAgain as never);
    const remove = amyAgain.tools.find((tool) => tool.name === 'RemoveMcpServer')!;
    expect(resultText(await remove.execute('3', { scope: 'personal', name: 'private' }))).toContain('Removed personal MCP server "private"');
    expect((db.prepare('SELECT COUNT(*) AS n FROM p_mcp_servers WHERE name = ?').get('private') as { n: number }).n).toBe(0);
    await amyAgain.hooks.find((hook) => hook.name === 'plugin.reload.before')!.run({});
  }, 20000);
});

describe('mcp plugin — end-to-end connection + process-group cleanup', () => {
  // Each test kills its MCP server processes (reload.before hook) before it ends, so the pid-file dirs
  // are safe to remove after the test instead of leaving them in /tmp.
  let dirs: string[] = [];
  const tmpDir = (tag: string): string => { const p = mkdtempSync(join(tmpdir(), `elowen-${tag}-`)); dirs.push(p); return p; };
  afterEach(() => { for (const p of dirs) rmSync(p, { recursive: true, force: true }); dirs = []; });

  it('connects a stdio MCP server, bridges its tool, and reaps the process group on reload', async () => {
    const dir = tmpDir('mcp');
    const pidFile = join(dir, 'grandchild.pid');
    const ctx = fakeCtx({
      servers: [{
        name: 'mock', enabled: true, transport: 'stdio',
        command: process.execPath, args: [MOCK_SERVER], env: { GRANDCHILD_PID_FILE: pidFile },
      }],
    });

    await register(ctx as never);
    expect(ctx.controls.has('mcp')).toBe(true);

    // The server's `echo` tool is bridged, namespaced.
    const echo = ctx.tools.find((t) => t.name === 'mcp__mock__echo');
    expect(echo, 'bridged tool registered').toBeTruthy();
    const res = (await echo!.execute('1', { text: 'hello mcp' })) as { content: { text: string }[] };
    expect(res.content[0]!.text).toBe('hello mcp');

    // The mock spawned a grandchild — it must be alive now and dead after cleanup (group kill).
    await waitFor(() => existsSync(pidFile));
    const grandchild = Number(readFileSync(pidFile, 'utf-8').trim());
    expect(grandchild).toBeGreaterThan(0);
    expect(alive(grandchild)).toBe(true);

    // Fire the reload.before hook the plugin registered — it tears everything down.
    const hook = ctx.hooks.find((h) => h.name === 'plugin.reload.before');
    expect(hook, 'reload.before hook registered').toBeTruthy();
    hook!.run({});

    // No orphan: the grandchild (and its server) are gone.
    expect(await waitFor(() => !alive(grandchild))).toBe(true);
  }, 20000);

  it('applies a configured connectTimeoutMs override (fails fast against a server that never speaks MCP, instead of waiting the 15s default)', async () => {
    const ctx = fakeCtx({
      connectTimeoutMs: 5000, // schema min
      servers: [{
        name: 'hung', enabled: true, transport: 'stdio',
        // A process that never writes to stdout: client.connect() hangs until the timeout fires.
        command: process.execPath, args: ['-e', 'setInterval(() => {}, 100000)'],
      }],
    });
    const start = Date.now();
    await register(ctx as never);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(4900); // the 5s override, not an instant failure
    expect(elapsed).toBeLessThan(10_000); // well under the unconfigured 15s default -> the override was used
    expect(ctx.tools.find((t) => t.name.startsWith('mcp__hung__'))).toBeUndefined();
  }, 15000);

  // Regression: listTools() was called once and nextCursor was ignored, so a paginated server exposed
  // only its first page — silently, with the status reporting a wrong tool count.
  it('pages through tools/list until nextCursor is exhausted, bridging every tool from every page', async () => {
    const ctx = fakeCtx({
      servers: [{
        name: 'paged', enabled: true, transport: 'stdio',
        command: process.execPath, args: [PAGINATED_MOCK_SERVER],
      }],
    });
    await register(ctx as never);

    const bridged = ctx.tools.filter((t) => t.name.startsWith('mcp__paged__')).map((t) => t.name).sort();
    expect(bridged).toEqual(['mcp__paged__tool_a', 'mcp__paged__tool_b', 'mcp__paged__tool_c']);

    const server = listMcpServers().find((s: { name: string }) => s.name === 'paged');
    expect(server.status).toBe('connected');
    expect(server.toolCount).toBe(3);
    expect(server.tools.map((t: { name: string }) => t.name).sort()).toEqual(['tool_a', 'tool_b', 'tool_c']);

    const hook = ctx.hooks.find((h) => h.name === 'plugin.reload.before');
    await hook!.run({});
  }, 20000);

  // Regression: tools were registered as each server's listTools() answered, so the order in the prompt
  // followed response latency — nondeterministic across restarts, and tool order is part of the cached
  // prompt prefix. Two parallel servers answering in opposite orders must produce the same sorted order.
  it('registers tools sorted by name, not by which server answers listTools first', async () => {
    const run = async (delayA: number, delayB: number) => {
      const ctx = fakeCtx({
        servers: [
          { name: 'aa', enabled: true, transport: 'stdio', command: process.execPath, args: [LATENCY_MOCK_SERVER], env: { MOCK_TOOLS: 'zeta,alpha', LIST_TOOLS_DELAY_MS: String(delayA) } },
          { name: 'bb', enabled: true, transport: 'stdio', command: process.execPath, args: [LATENCY_MOCK_SERVER], env: { MOCK_TOOLS: 'echo,delta', LIST_TOOLS_DELAY_MS: String(delayB) } },
        ],
      });
      await register(ctx as never);
      const names = ctx.tools.filter((t) => t.name.startsWith('mcp__')).map((t) => t.name);
      const hook = ctx.hooks.find((h) => h.name === 'plugin.reload.before');
      await hook!.run({});
      return names;
    };
    const aaSlow = await run(300, 0); // 'bb' answers first
    const aaFast = await run(0, 300); // 'aa' answers first
    const expected = ['mcp__aa__alpha', 'mcp__aa__zeta', 'mcp__bb__delta', 'mcp__bb__echo'];
    expect(aaSlow).toEqual(expected);
    expect(aaFast).toEqual(expected);
  }, 20000);

  // Regression: nothing set client.onclose, so a dead stdio process left the state lying "connected",
  // tools kept failing against the dead client, and reconnectMcpServer no-opped because the state still
  // said "connected".
  it('detects an unexpected disconnect and lets a manual reconnect actually reconnect', async () => {
    const dir = tmpDir('mcp');
    const pidFile = join(dir, 'server.pid');
    const ctx = fakeCtx({
      servers: [{
        name: 'crashy', enabled: true, transport: 'stdio',
        command: process.execPath, args: [MOCK_SERVER], env: { SERVER_PID_FILE: pidFile },
      }],
    });
    await register(ctx as never);
    expect(listMcpServers().find((s: { name: string }) => s.name === 'crashy')?.status).toBe('connected');

    await waitFor(() => existsSync(pidFile));
    const serverPid = Number(readFileSync(pidFile, 'utf-8').trim());
    expect(alive(serverPid)).toBe(true);
    process.kill(serverPid, 'SIGKILL'); // simulate the server crashing, not a deliberate plugin cleanup

    expect(await waitFor(() => listMcpServers().find((s: { name: string }) => s.name === 'crashy')?.status === 'disconnected', 5000)).toBe(true);
    const disconnected = listMcpServers().find((s: { name: string }) => s.name === 'crashy');
    expect(disconnected.lastError).toBeTruthy();
    expect(disconnected.toolCount).toBe(0);

    // The bug: reconnect used to see status "connected" and return immediately, doing nothing.
    const reconnected = await reconnectMcpServer('crashy');
    expect(reconnected.status).toBe('connected');
    expect(ctx.tools.some((t) => t.name === 'mcp__crashy__echo')).toBe(true);

    const hook = ctx.hooks.find((h) => h.name === 'plugin.reload.before');
    await hook!.run({});
  }, 20000);
});

/** A forked sub-agent runner used to connect every configured MCP server at boot — its own copy of every
 *  one of them, in production a whole Chrome per runner. It does not have to: a tool must be DECLARED to
 *  the model, but the server behind it only has to exist when the tool is CALLED. Handed the daemon's
 *  bridged tool definitions, the plugin declares the identical tools and connects on first use.
 *
 *  The requirement these tests defend is PARITY: whichever path the plugin took, the model must be shown
 *  exactly the same tools. The tool list is part of the prompt-cache key, so drift here is silent and
 *  re-bills every delegated turn at full price. */
describe('mcp plugin — declaring bridged tools from an inherited snapshot', () => {
  let dirs: string[] = [];
  const tmpDir = (tag: string): string => { const p = mkdtempSync(join(tmpdir(), `elowen-${tag}-`)); dirs.push(p); return p; };
  afterEach(() => { for (const p of dirs) rmSync(p, { recursive: true, force: true }); dirs = []; });

  /** How many times the scripted server was LAUNCHED (one appended line per start). */
  const starts = (log: string): number =>
    (existsSync(log) ? readFileSync(log, 'utf-8').split('\n').filter(Boolean).length : 0);

  /** Everything about a registered tool that the MODEL sees. Compared field for field between the two
   *  registration paths, because "the same tool names" would still pass with a mangled schema. */
  const declarations = (ctx: ReturnType<typeof fakeCtx>): unknown[] =>
    ctx.tools.filter((t) => t.name.startsWith('mcp__'))
      .map((t) => { const { execute: _execute, ...rest } = t as Record<string, unknown> & { execute: unknown }; return rest; });

  const teardown = async (ctx: ReturnType<typeof fakeCtx>): Promise<void> => {
    await ctx.hooks.find((h) => h.name === 'plugin.reload.before')!.run({});
  };

  const visibleTools = (ctx: ReturnType<typeof fakeCtx>, ownerUserId: number | null) => {
    const selected = new Map<string, (typeof ctx.tools)[number]>();
    for (const tool of ctx.tools) {
      if (tool.ownerUserId !== undefined && tool.ownerUserId !== ownerUserId) continue;
      const prior = selected.get(tool.name);
      if (!prior || tool.ownerUserId !== undefined) selected.set(tool.name, tool);
    }
    return [...selected.values()];
  };

  it('keeps another account personal server out of shared-channel sub-agents and other accounts', async () => {
    const db = openPluginTablesDb();
    const bootstrap = fakeCtx({}, undefined, db);
    await register(bootstrap as never);
    await teardown(bootstrap);

    const users = new UserStore(db);
    for (let i = 1; i <= 4; i++) users.create(`user-${i}`, 'pw');
    const descriptor = [{ name: 'echo', description: 'Echo', inputSchema: { type: 'object' } }];
    const insert = db.prepare('INSERT INTO p_mcp_servers (owner_user_id, name, spec_json, tools_json) VALUES (?, ?, ?, ?)');
    insert.run(null, 'shared', JSON.stringify({ name: 'shared', enabled: true, command: process.execPath, args: [MOCK_SERVER] }), JSON.stringify(descriptor));
    insert.run(4, 'private', JSON.stringify({ name: 'private', enabled: true, command: process.execPath, args: [MOCK_SERVER] }), JSON.stringify(descriptor));

    const ctx = fakeCtx({}, [{ serverName: 'shared', tools: descriptor }], db);
    await register(ctx as never);
    expect(visibleTools(ctx, 4).map((tool) => tool.name)).toContain('mcp__private__echo');
    expect(visibleTools(ctx, 5).map((tool) => tool.name)).not.toContain('mcp__private__echo');

    const sharedChildOwner = skillOwnerForSession('brain-ch-subagent-test', 4, channelSessionId('discord-room'));
    expect(sharedChildOwner).toBeNull();
    expect(visibleTools(ctx, sharedChildOwner).map((tool) => tool.name)).toContain('mcp__shared__echo');
    expect(visibleTools(ctx, sharedChildOwner).map((tool) => tool.name)).not.toContain('mcp__private__echo');
    await teardown(ctx);
  });

  it('declares the same tools as a connected load, launches nothing at boot, and connects on the first call', async () => {
    const log = join(tmpDir('mcp-snapshot'), 'starts.log');
    const servers = [{
      name: 'mock', enabled: true, transport: 'stdio',
      command: process.execPath, args: [MOCK_SERVER], env: { SERVER_START_LOG: log },
    }];

    // 1. The DAEMON's load: connect at boot, and record what it registered.
    const daemonCtx = fakeCtx({ servers });
    await register(daemonCtx as never);
    const snapshot = mcpBridgeSnapshot();
    const daemonDeclarations = declarations(daemonCtx);
    expect(daemonDeclarations).toHaveLength(1);
    expect(starts(log)).toBe(1);
    await teardown(daemonCtx);

    // 2. The RUNNER's load: same config, plus the snapshot the daemon just produced.
    const runnerCtx = fakeCtx({ servers }, snapshot);
    await register(runnerCtx as never);
    expect(declarations(runnerCtx)).toEqual(daemonDeclarations);
    // …and it cost no server process at all. This is the whole point of the change.
    expect(starts(log)).toBe(1);

    // 3. Calling one connects it, once, and the call works.
    const echo = runnerCtx.tools.find((t) => t.name === 'mcp__mock__echo');
    const res = (await echo!.execute('1', { text: 'lazy hello' })) as { content: { text: string }[] };
    expect(res.content[0]!.text).toBe('lazy hello');
    expect(starts(log)).toBe(2);

    // 4. A SECOND call reuses the connection rather than launching another server.
    await echo!.execute('2', { text: 'again' });
    expect(starts(log)).toBe(2);
    await teardown(runnerCtx);
  }, 30000);

  it('shares ONE connect between concurrent first calls, and neither sees a half-connected client', async () => {
    // The server holds its `initialize` reply for 400 ms, so the second call lands squarely INSIDE the
    // first one's handshake rather than after it — the window where a broken lazy connect would show.
    // Both calls must come back with the server's real answers, off one server process.
    const log = join(tmpDir('mcp-singleflight'), 'starts.log');
    const snapshot = [{ serverName: 'mock', tools: [{ name: 'echo', description: 'Echo the text back', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }] }];
    const ctx = fakeCtx({
      servers: [{
        name: 'mock', enabled: true, transport: 'stdio', command: process.execPath,
        args: [SLOW_INIT_MOCK_SERVER], env: { SERVER_START_LOG: log, INIT_DELAY_MS: '400' },
      }],
    }, snapshot);
    await register(ctx as never);
    expect(starts(log)).toBe(0);

    const echo = ctx.tools.find((t) => t.name === 'mcp__mock__echo');
    const [a, b] = await Promise.all([
      echo!.execute('1', { text: 'first' }) as Promise<{ content: { text: string }[]; details: { ok: boolean } }>,
      echo!.execute('2', { text: 'second' }) as Promise<{ content: { text: string }[]; details: { ok: boolean } }>,
    ]);
    expect(a.details.ok, `first call failed: ${a.content[0]?.text}`).toBe(true);
    expect(b.details.ok, `second call failed: ${b.content[0]?.text}`).toBe(true);
    expect(a.content[0]!.text).toBe('first');
    expect(b.content[0]!.text).toBe('second');
    expect(starts(log), 'exactly one server process for two concurrent first calls').toBe(1);
    await teardown(ctx);
  }, 30000);

  it('surfaces a connect that fails at first call the way a dead server does — an error result, not a crash', async () => {
    const ctx = fakeCtx({
      connectTimeoutMs: 5000,
      // A command that exits immediately: the transport closes and the connect rejects.
      servers: [{ name: 'dead', enabled: true, transport: 'stdio', command: process.execPath, args: ['-e', 'process.exit(1)'] }],
    }, [{ serverName: 'dead', tools: [{ name: 'ghost', description: 'never answers' }] }]);
    await register(ctx as never);

    const ghost = ctx.tools.find((t) => t.name === 'mcp__dead__ghost');
    expect(ghost, 'the tool is still DECLARED — the model sees the same surface either way').toBeTruthy();
    const res = (await ghost!.execute('1', {})) as { content: { text: string }[]; details: { ok: boolean } };
    expect(res.details.ok).toBe(false);
    expect(res.content[0]!.text).toMatch(/^Error: /);
    // The failure is not cached: a later call tries again rather than answering from a stale rejection.
    const second = (await ghost!.execute('2', {})) as { details: { ok: boolean } };
    expect(second.details.ok).toBe(false);
    await teardown(ctx);
  }, 30000);

  it('connects on demand for the RESOURCE tools too, which have no declaration to ride on', async () => {
    // A bridged tool carries its schema in the snapshot; a resource listing can only come from a live
    // server. Under a snapshot, asking for resources is therefore itself the request to connect.
    const log = join(tmpDir('mcp-resources'), 'starts.log');
    const ctx = fakeCtx({
      servers: [{ name: 'mock', enabled: true, transport: 'stdio', command: process.execPath, args: [MOCK_SERVER], env: { SERVER_START_LOG: log } }],
    }, [{ serverName: 'mock', tools: [{ name: 'echo' }] }]);
    await register(ctx as never);
    expect(starts(log)).toBe(0);

    const list = ctx.tools.find((t) => t.name === 'ListMcpResources');
    await list!.execute('1', {});
    expect(starts(log), 'ListMcpResources brought the server up').toBe(1);

    // ReadMcpResource against the SAME server reuses that connection.
    const read = ctx.tools.find((t) => t.name === 'ReadMcpResource');
    const res = (await read!.execute('2', { server: 'mock', uri: 'file:///nope' })) as { details: { ok: boolean } };
    expect(res.details.ok).toBe(false); // the mock exposes no resources — but it was ASKED, not skipped
    expect(starts(log)).toBe(1);
    await teardown(ctx);
  }, 30000);

  it('bridgeSnapshot() reports only CONNECTED servers, with the fields registration reads', async () => {
    const ctx = fakeCtx({
      connectTimeoutMs: 5000,
      servers: [
        { name: 'mock', enabled: true, transport: 'stdio', command: process.execPath, args: [MOCK_SERVER] },
        { name: 'broken', enabled: true, transport: 'stdio', command: process.execPath, args: ['-e', 'process.exit(1)'] },
        { name: 'off', enabled: false, transport: 'stdio', command: process.execPath, args: [MOCK_SERVER] },
      ],
    });
    await register(ctx as never);
    const snapshot = mcpBridgeSnapshot() as { serverName: string; tools: { name: string; description?: string; inputSchema?: unknown }[] }[];
    // A server that failed to connect contributed no tools to THIS process either, so it must contribute
    // none to a runner — otherwise the runner would declare tools the daemon does not have.
    expect(snapshot.map((s) => s.serverName)).toEqual(['mock']);
    expect(snapshot[0]!.tools.map((t) => t.name)).toEqual(['echo']);
    expect(snapshot[0]!.tools[0]!.description).toBe('Echo the text back');
    expect(snapshot[0]!.tools[0]!.inputSchema).toMatchObject({ type: 'object' });
    await teardown(ctx);
  }, 30000);
});
