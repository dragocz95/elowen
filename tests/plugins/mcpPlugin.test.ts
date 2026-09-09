import { describe, it, expect, vi, afterEach } from 'vitest';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { openPluginTablesDb } from '../helpers/pluginTablesDb.js';
import { makePluginDb } from '../../src/store/pluginDb.js';
import type { Db } from '../../src/store/db.js';
import { UserStore } from '../../src/store/userStore.js';
import { projectScopedTools } from '../../src/plugins/registry.js';
import { channelSessionId, contributionOwnerForSession } from '../../src/brain/sessionId.js';
import { composeSessionTools } from '../../src/brain/session/capabilities.js';
import { currentIdentity, runWithPolicy } from '../../src/plugins/policyContext.js';
// The plugin is a plain ESM module (no build step) — import it directly.
import { register, killTree, sanitize, mapResult, DetachedStdioTransport, configNumber, listMcpServers, reconnectMcpServer, mcpBridgeSnapshot } from '../../plugins/mcp/index.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const MOCK_SERVER = join(here, '../fixtures/mock-mcp-server.mjs');
const PAGINATED_MOCK_SERVER = join(here, '../fixtures/mock-mcp-paginated-server.mjs');
const LATENCY_MOCK_SERVER = join(here, '../fixtures/mock-mcp-latency-server.mjs');
const SLOW_INIT_MOCK_SERVER = join(here, '../fixtures/mock-mcp-slow-init-server.mjs');
const RESOURCE_MOCK_SERVER = join(here, '../fixtures/mock-mcp-resource-server.mjs');

const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn: () => boolean, ms = 3000) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await wait(50); } return fn(); };

/** A minimal PluginContext stand-in capturing the tools/hooks the plugin registers. `mcpBridgeSnapshot`
 *  is what a forked sub-agent runner is handed: present ⇒ declare these tools and connect nothing. */
function fakeCtx(config: Record<string, unknown>, mcpBridgeSnapshot?: unknown, db: Db = openPluginTablesDb(), identity: object | null | (() => object | null) = null, dataDir = mkdtempSync(join(tmpdir(), 'elowen-mcp-data-'))) {
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
    currentAccess: () => ({}),
    requestReload: vi.fn(),
    registerTool: (t: { name: string; execute: (id: string, args: unknown) => Promise<unknown> }, opts?: { ownerUserId?: number }) => tools.push({ ...t, ...opts }),
    registerHook: (h: { name: string; run: (p: unknown) => unknown }) => hooks.push(h),
    registerControl: (name: string, control: unknown) => controls.set(name, control),
    registerApiRoute: (route: { path: string; method?: string; handler: (req: unknown) => Promise<unknown> }) => apiRoutes.push(route),
    registerUserRemoved: (handler: (userId: number) => Promise<void> | void) => userRemoved.push(handler),
    dataDir: () => dataDir,
    tools, hooks, controls, apiRoutes, userRemoved, rawDb: db, dataDirPath: dataDir,
  };
}

describe('mcp plugin — bridged content parity', () => {
  it('downsamples a bridged image past the API dimension limit instead of forwarding it raw', async () => {
    const sharp = (await import('sharp')).default;
    const oversized = await sharp({ create: { width: 2400, height: 300, channels: 3, background: { r: 10, g: 120, b: 200 } } })
      .png().toBuffer();
    const raw = oversized.toString('base64');

    const mapped = await mapResult({ content: [{ type: 'image', data: raw, mimeType: 'image/png' }] });

    const part = mapped.content[0] as { type: string; data: string; mimeType: string };
    expect(part.type).toBe('image');
    expect(part.data).not.toBe(raw);
    const metadata = await sharp(Buffer.from(part.data, 'base64')).metadata();
    expect(metadata.width).toBeLessThanOrEqual(2000);
  });

  it('marks a bridged description that had to be cut instead of ending mid-sentence', async () => {
    const { bridgedDescription, MAX_MCP_DESCRIPTION_LENGTH } = await import('../../plugins/mcp/index.mjs') as {
      bridgedDescription: (server: string, tool: { name: string; description?: string }) => string;
      MAX_MCP_DESCRIPTION_LENGTH: number;
    };
    expect(MAX_MCP_DESCRIPTION_LENGTH).toBe(2048);
    const short = bridgedDescription('docs', { name: 'search', description: 'Search the docs.' });
    expect(short).toBe('[docs] Search the docs.');
    expect(short).not.toContain('[truncated]');

    const long = bridgedDescription('docs', { name: 'search', description: 'x'.repeat(5000) });
    expect(long).toHaveLength(MAX_MCP_DESCRIPTION_LENGTH + '… [truncated]'.length);
    expect(long.endsWith('… [truncated]')).toBe(true);
  });

  it('writes a resource blob to disk and hands back the path it can be read from', async () => {
    const { persistResourceBlob } = await import('../../plugins/mcp/index.mjs') as {
      persistResourceBlob: (dir: string, uri: string, mime: string, blob: string) => { path: string; bytes: number };
    };
    const dir = mkdtempSync(join(tmpdir(), 'elowen-mcp-blob-'));
    try {
      const payload = Buffer.from('%PDF-1.4 not really a pdf');
      const saved = persistResourceBlob(dir, 'file:///reports/q3.pdf', 'application/pdf', payload.toString('base64'));
      expect(saved.bytes).toBe(payload.length);
      expect(saved.path.endsWith('.pdf')).toBe(true);
      expect(existsSync(saved.path)).toBe(true);
      expect(readFileSync(saved.path)).toEqual(payload);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('mcp plugin — helpers', () => {
  it('sanitize produces a safe tool-name token', () => {
    expect(sanitize('Chrome DevTools!')).toBe('chrome_devtools');
    expect(sanitize('')).toBe('x');
  });

  it('mapResult maps MCP content to a brain tool result', async () => {
    expect(await mapResult({ content: [{ type: 'text', text: 'hi' }] })).toEqual({ content: [{ type: 'text', text: 'hi' }], details: { ok: true, isError: false } });
    expect((await mapResult({ content: [], isError: true })).details.isError).toBe(true);
    expect((await mapResult({ content: [], isError: true })).details.ok).toBe(false);
  });

  it('mapResult passes inline-supported image parts through as REAL image blocks', async () => {
    // Not a decodable image, so the resize pass cannot run and the original bytes travel unchanged.
    expect(await mapResult({ content: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }] }))
      .toEqual({ content: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }], details: { ok: true, isError: false } });
  });

  it('mapResult collapses non-inlineable parts to a short placeholder, never the raw payload', async () => {
    const audio = { type: 'audio', data: 'Q'.repeat(10_000), mimeType: 'audio/wav' };
    expect((await mapResult({ content: [audio] })).content).toEqual([{ type: 'text', text: '[audio content omitted]' }]);
    const resource = { type: 'resource', resource: { uri: 'file:///x', blob: 'Z'.repeat(10_000) } };
    expect((await mapResult({ content: [resource] })).content).toEqual([{ type: 'text', text: '[resource content omitted]' }]);
    // An image with an unsupported/inline-hostile mime type is placeholdered too, not stringified.
    expect((await mapResult({ content: [{ type: 'image', data: 'AAAA', mimeType: 'image/tiff' }] })).content)
      .toEqual([{ type: 'text', text: '[image content omitted]' }]);
    expect((await mapResult({ content: [{}] })).content).toEqual([{ type: 'text', text: '[unknown content omitted]' }]);
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
    (t as unknown as { onmessage: (m: unknown) => void }).onmessage = (m) => got.push(m);
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

    const server = listMcpServers().find((s: { name: string }) => s.name === 'paged')!;
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
    const disconnected = listMcpServers().find((s: { name: string }) => s.name === 'crashy')!;
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

  it('routes managed stdio tool calls through their project instead of the inherited host client', async () => {
    const ctx = fakeCtx({ servers: [{ name: 'mock', enabled: true, transport: 'stdio', command: process.execPath, args: [MOCK_SERVER] }] },
      [{ serverName: 'mock', tools: [{ name: 'echo', inputSchema: { type: 'object' } }] }]);
    const release = vi.fn();
    const prepareExecution = vi.fn(async () => ({
      mode: 'managed', projectRef: { kind: 'managed', projectId: 11 }, cwd: tmpdir(), displayCwd: '/workspace',
      launch: { type: 'argv', file: process.execPath, args: [MOCK_SERVER], env: {} },
      lease: { id: 'mcp-test', heartbeat() {}, release }, cancel: vi.fn(async () => {}), sanitizeOutput: (text: string) => text,
    }));
    const managed = { ...ctx, currentAccess: () => ({ projectRef: { kind: 'managed', projectId: 11 } }),
      currentAccountUserId: () => 1, defaultCwd: () => '/workspace', control: () => ({ prepareExecution }) };
    try {
      await register(managed as never);
      const result = await ctx.tools.find(t => t.name === 'mcp__mock__echo')!.execute('t', { text: 'guest reply' });
      expect(JSON.stringify(result)).toContain('guest reply');
      expect(prepareExecution).toHaveBeenCalledWith(expect.objectContaining({ leaseKind: 'mcp', projectRef: { kind: 'managed', projectId: 11 } }));
      expect(release).toHaveBeenCalledOnce();
    } finally { await teardown(ctx); ctx.rawDb.close(); rmSync(ctx.dataDirPath, { recursive: true, force: true }); }
  });

  it('routes managed resource listings and binary exports without using the central filesystem', async () => {
    const ctx = fakeCtx({ servers: [{ name: 'resources', enabled: true, transport: 'stdio', command: 'guest-resources' }] }, []);
    const release = vi.fn();
    const prepareExecution = vi.fn(async () => ({
      mode: 'managed', projectRef: { kind: 'managed', projectId: 12 }, cwd: tmpdir(), displayCwd: '/workspace',
      launch: { type: 'argv', file: process.execPath, args: [RESOURCE_MOCK_SERVER], env: {} },
      lease: { id: 'mcp-resource-test', heartbeat() {}, release }, cancel: vi.fn(async () => {}), sanitizeOutput: (text: string) => text,
    }));
    const projectFiles = vi.fn(async ({ operation }) => ({ kind: 'write', entry: { path: operation.path } }));
    const managed = { ...ctx, currentAccess: () => ({ projectRef: { kind: 'managed', projectId: 12 } }),
      currentAccountUserId: () => 1, defaultCwd: () => '/workspace', control: () => ({ prepareExecution, projectFiles }),
      dataDir: () => { throw new Error('HOST FILESYSTEM REACHED'); } };
    try {
      await register(managed as never);
      const listing = await ctx.tools.find(t => t.name === 'ListMcpResources')!.execute('list', {});
      expect(JSON.stringify(listing)).toContain('file:///picture.png');
      const read = await ctx.tools.find(t => t.name === 'ReadMcpResource')!.execute('read', { server: 'resources', uri: 'file:///picture.png' });
      expect(JSON.stringify(read)).toContain('/tmp/elowen-mcp-');
      expect(projectFiles).toHaveBeenCalledWith(expect.objectContaining({ project: { kind: 'managed', projectId: 12 }, accountUserId: 1,
        operation: expect.objectContaining({ kind: 'write', expectedVersion: null, base64: Buffer.from('binary-bytes').toString('base64') }) }));
      expect(release).toHaveBeenCalledTimes(2);
    } finally { await teardown(ctx); ctx.rawDb.close(); rmSync(ctx.dataDirPath, { recursive: true, force: true }); }
  });

  it('refuses centrally stored stdio credentials before requesting a managed launch', async () => {
    const ctx = fakeCtx({ servers: [{ name: 'mock', enabled: true, transport: 'stdio', command: process.execPath, args: [MOCK_SERVER], env: { PRIVATE_TOKEN: 'do-not-export' } }] },
      [{ serverName: 'mock', tools: [{ name: 'echo', inputSchema: { type: 'object' } }] }]);
    const control = vi.fn();
    const managed = { ...ctx, currentAccess: () => ({ projectRef: { kind: 'managed', projectId: 11 } }), control };
    try {
      await register(managed as never);
      const result = await ctx.tools.find(t => t.name === 'mcp__mock__echo')!.execute('t', { text: 'guest reply' });
      expect(JSON.stringify(result)).toContain('cannot import centrally stored');
      expect(JSON.stringify(result)).not.toContain('do-not-export');
      expect(control).not.toHaveBeenCalled();
    } finally { await teardown(ctx); ctx.rawDb.close(); rmSync(ctx.dataDirPath, { recursive: true, force: true }); }
  });

  const visibleTools = (ctx: ReturnType<typeof fakeCtx>, ownerUserId: number | null) => {
    const selected = new Map<string, (typeof ctx.tools)[number]>();
    for (const tool of ctx.tools) {
      if (tool.ownerUserId !== undefined && tool.ownerUserId !== ownerUserId) continue;
      const prior = selected.get(tool.name);
      if (!prior || tool.ownerUserId !== undefined) selected.set(tool.name, tool);
    }
    return [...selected.values()];
  };

  it('keeps a project-bound server schema out of accounts that cannot reach the project', async () => {
    // A stdio server bound to a managed project is admin-only, so it may be saved at INSTANCE scope —
    // owner_user_id NULL. Its bridged tool names, descriptions and input schemas are read from the
    // server running INSIDE that project, so they are project data. Calling one from elsewhere is
    // already refused; being able to READ it is the part that leaks, and a description or a schema
    // field name can carry as much as a call would return.
    const db = openPluginTablesDb();
    const bootstrap = fakeCtx({}, undefined, db);
    await register(bootstrap as never);
    await teardown(bootstrap);

    const users = new UserStore(db);
    const member = users.create('member', 'pw');
    const stranger = users.create('stranger', 'pw');
    const projectTools = [{
      name: 'deploy',
      description: 'Deploy the ACME billing pipeline',
      inputSchema: { type: 'object', properties: { acmeCustomerId: { type: 'string' } } },
    }];
    db.prepare('INSERT INTO p_mcp_servers (owner_user_id, name, spec_json, tools_json) VALUES (?, ?, ?, ?)').run(
      null, 'projsrv',
      JSON.stringify({ name: 'projsrv', enabled: true, transport: 'stdio', command: 'in-guest-server', projectRef: { kind: 'managed', projectId: 7 } }),
      JSON.stringify(projectTools),
    );

    const ctx = fakeCtx({}, undefined, db, { elowenUserId: member.id, admin: true, owner: true });
    try {
      await register(ctx as never);
      // The plugin must MARK the declaration as project data; the host cannot scope what is not marked.
      const bound = ctx.tools.find((tool) => tool.name === 'mcp__projsrv__deploy') as { projectId?: number } | undefined;
      expect(bound?.projectId).toBe(7);

      // …and the composer must then drop it outside that project. `projectScopedTools` is the exact
      // function the session composer runs, so this cannot pass while production diverges.
      const projectBound = new Map(ctx.tools.flatMap((tool) => {
        const id = (tool as { projectId?: number }).projectId;
        return typeof id === 'number' ? [[tool.name, id] as [string, number]] : [];
      }));
      const composeFor = (ownerUserId: number | null, selectedProjectId: number | null) =>
        projectScopedTools(visibleTools(ctx, ownerUserId), projectBound, selectedProjectId);

      // A stranger has no session in project 7 to begin with, and even an unscoped session of theirs
      // must not carry the declaration.
      const outside = JSON.stringify(composeFor(stranger.id, null));
      expect(outside).not.toContain('mcp__projsrv__deploy');
      expect(outside).not.toContain('ACME billing pipeline');
      expect(outside).not.toContain('acmeCustomerId');
      // Another project is not a loophole either.
      expect(JSON.stringify(composeFor(stranger.id, 8))).not.toContain('mcp__projsrv__deploy');
      // The admin who owns the binding does not get it outside the project either: the rule is the
      // project, not the person.
      expect(JSON.stringify(composeFor(member.id, null))).not.toContain('mcp__projsrv__deploy');

      // NEGATIVE CONTROL: inside the project the tool is still composed, so the assertions above
      // describe scoping rather than a tool that was never registered.
      expect(composeFor(member.id, 7).map((tool) => tool.name)).toContain('mcp__projsrv__deploy');
    } finally { await teardown(ctx); }
  });

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

    // A sub-agent delegated out of a shared room by an UNLINKED writer inherits nobody: the room's row
    // owner is only whoever opened it, and taking them would run their private server for a stranger.
    const sharedChildOwner = contributionOwnerForSession('brain-ch-subagent-test', 4, { parentSessionId: channelSessionId('discord-room') });
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

  it('throws a connect that fails at first call, so the host marks the result is_error', async () => {
    const ctx = fakeCtx({
      connectTimeoutMs: 5000,
      // A command that exits immediately: the transport closes and the connect rejects.
      servers: [{ name: 'dead', enabled: true, transport: 'stdio', command: process.execPath, args: ['-e', 'process.exit(1)'] }],
    }, [{ serverName: 'dead', tools: [{ name: 'ghost', description: 'never answers' }] }]);
    await register(ctx as never);

    const ghost = ctx.tools.find((t) => t.name === 'mcp__dead__ghost');
    expect(ghost, 'the tool is still DECLARED — the model sees the same surface either way').toBeTruthy();
    // A transport that never came up is a host fault, not an answer: it is thrown, and the message the
    // host renders as the errored result still names what happened.
    await expect(ghost!.execute('1', {})).rejects.toThrow();
    // The failure is not cached: a later call tries again rather than answering from a stale rejection.
    await expect(ghost!.execute('2', {})).rejects.toThrow();
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

  it('answers the resource tools in the reference JSON shape, blobs included', async () => {
    const ctx = fakeCtx({
      connectTimeoutMs: 10000,
      servers: [{ name: 'res', enabled: true, transport: 'stdio', command: process.execPath, args: [RESOURCE_MOCK_SERVER] }],
    });
    await register(ctx as never);

    const list = ctx.tools.find((t) => t.name === 'ListMcpResources');
    const listed = (await list!.execute('1', {})) as { content: { text: string }[]; details: { ok: boolean; count: number } };
    expect(listed.details.ok).toBe(true);
    const listing = JSON.parse(listed.content[0]!.text) as {
      resources: { uri: string; name: string; mimeType?: string; description?: string; server: string }[];
      errors?: unknown;
    };
    expect(listing.errors).toBeUndefined();
    expect(listing.resources).toContainEqual({
      uri: 'file:///notes.txt', name: 'notes', mimeType: 'text/plain', description: 'Some notes', server: 'res',
    });
    // An absent description is OMITTED, not blanked, so "none" is distinguishable from "empty".
    const picture = listing.resources.find((r) => r.uri === 'file:///picture.png');
    expect(picture).toEqual({ uri: 'file:///picture.png', name: 'blob', mimeType: 'image/png', server: 'res' });

    const read = ctx.tools.find((t) => t.name === 'ReadMcpResource');
    const text = (await read!.execute('2', { server: 'res', uri: 'file:///notes.txt' })) as { content: { text: string }[] };
    expect(JSON.parse(text.content[0]!.text)).toEqual({
      contents: [{ uri: 'file:///notes.txt', mimeType: 'text/plain', text: 'note body' }],
    });

    const blob = (await read!.execute('3', { server: 'res', uri: 'file:///picture.png' })) as { content: { text: string }[] };
    const parsed = JSON.parse(blob.content[0]!.text) as { contents: { uri: string; mimeType?: string; blobSavedTo?: string; text?: string }[] };
    const entry = parsed.contents[0]!;
    expect(entry.uri).toBe('file:///picture.png');
    expect(entry.mimeType).toBe('image/png');
    expect(entry.blobSavedTo).toBeTruthy();
    expect(readFileSync(entry.blobSavedTo!, 'utf-8')).toBe('binary-bytes');
    expect(entry.text).toContain('saved to');

    await teardown(ctx);
    rmSync(ctx.dataDirPath, { recursive: true, force: true });
  }, 30000);

  it('reports an unreachable server as data in the listing rather than losing it', async () => {
    const ctx = fakeCtx({
      connectTimeoutMs: 10000,
      servers: [{ name: 'res', enabled: true, transport: 'stdio', command: process.execPath, args: [RESOURCE_MOCK_SERVER] }],
    });
    await register(ctx as never);

    const list = ctx.tools.find((t) => t.name === 'ListMcpResources');
    const named = (await list!.execute('1', { server: 'nowhere' })) as { content: { text: string }[]; details: { ok: boolean } };
    // A server that is not there is an answer the model can act on, so it stays readable text.
    expect(named.details.ok).toBe(false);
    expect(named.content[0]!.text).toContain('is not connected');

    await teardown(ctx);
    rmSync(ctx.dataDirPath, { recursive: true, force: true });
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

/** Immutable managed stdio binding: a newly created stdio server whose creation turn had a managed project
 *  selected (or that was created with an explicit binding) is persisted with `{ kind: 'managed', projectId }`
 *  and EVERY later execution — management verify, tool call, resource read — runs inside exactly that
 *  project through Sandbox, never on the host. The binding never migrates an old row, never changes on
 *  update, and a row whose binding no longer validates fails CLOSED (dropped), never reinterpreted as a
 *  host command. The Sandbox side is faked at the `prepareExecution` contract (mode/projectRef/launch/
 *  lease/cancel) exactly as the managed environments provider implements it. */
describe('mcp plugin — immutable managed stdio binding', () => {
  let dirs: string[] = [];
  const tmpDir = (tag: string): string => { const p = mkdtempSync(join(tmpdir(), `elowen-${tag}-`)); dirs.push(p); return p; };
  afterEach(() => { for (const p of dirs) rmSync(p, { recursive: true, force: true }); dirs = []; });

  const resultText = (result: unknown) => (result as { content: { text: string }[] }).content[0]!.text;
  const starts = (log: string): number =>
    (existsSync(log) ? readFileSync(log, 'utf-8').split('\n').filter(Boolean).length : 0);
  const descriptor = [{ name: 'echo', description: 'Echo the text back', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }];

  /** A prepared managed execution, shaped exactly like the provider contract (see
   *  runManagedProjectExecution in src/integrations): mode/projectRef verified, host launch, lease with
   *  heartbeat/release, verified cancel callback, output sanitizer. */
  const managedPrepared = (projectId: number, launchArgs: string[], launchEnv: Record<string, string> = {}, release: () => unknown = vi.fn()) => ({
    mode: 'managed', projectRef: { kind: 'managed', projectId }, cwd: tmpdir(), displayCwd: '/workspace',
    launch: { type: 'argv', file: process.execPath, args: launchArgs, env: launchEnv },
    lease: { id: 'mcp-bind-test', heartbeat() {}, release },
    cancel: vi.fn(async () => {}), sanitizeOutput: (text: string) => text,
  });

  /** A fakeCtx with a managed project selected and a Sandbox control whose prepareExecution is the given
   *  mock and whose environmentFor authorizes the binding live (overridable to simulate revocation).
   *  `setAccess` re-points the selected project mid-test (wrong-project refusals). */
  const makeManaged = (opts: {
    projectId: number; prepareExecution: (...args: unknown[]) => Promise<unknown>;
    db?: Db; identity?: object | null; dataDir?: string;
    environmentFor?: (...args: unknown[]) => Promise<unknown>;
  }) => {
    const base = fakeCtx({}, undefined, opts.db ?? openPluginTablesDb(), opts.identity ?? { elowenUserId: 1, owner: true }, opts.dataDir);
    let access: { projectRef?: { kind: 'managed'; projectId: number } } = { projectRef: { kind: 'managed', projectId: opts.projectId } };
    const ctx = {
      ...base,
      currentAccess: () => access,
      currentAccountUserId: () => 1,
      defaultCwd: () => '/workspace',
      control: (name: string) => name === 'sandbox'
        ? {
          prepareExecution: opts.prepareExecution,
          environmentFor: opts.environmentFor ?? (async ({ project }: { project: { projectId: number } }) => ({ projectId: project.projectId, generation: 1, state: 'running' })),
        }
        : undefined,
    };
    return { ctx, setAccess: (next: { projectRef?: { kind: 'managed'; projectId: number } }) => { access = next; } };
  };

  const teardownCtx = async (ctx: { hooks: { name: string; run: (p: unknown) => unknown }[]; rawDb: Db; dataDirPath: string }): Promise<void> => {
    await ctx.hooks.find((h) => h.name === 'plugin.reload.before')!.run({});
    ctx.rawDb.close();
    rmSync(ctx.dataDirPath, { recursive: true, force: true });
  };

  /** Registers a throwaway ctx to run the plugin migration (creating p_mcp_servers), sharing the dataDir
   *  the test's real ctx will use so teardown removes exactly one temp dir. */
  const bootstrapDb = async (db: Db, dataDir: string): Promise<void> => {
    const bootstrap = fakeCtx({}, undefined, db, null, dataDir);
    await register(bootstrap as never);
    await bootstrap.hooks.find((h) => h.name === 'plugin.reload.before')!.run({});
  };

  it('persists an immutable managed binding captured from the selected project at creation', async () => {
    const db = openPluginTablesDb();
    const release = vi.fn();
    const prepareExecution = vi.fn(async () => managedPrepared(11, [MOCK_SERVER], {}, release));
    const { ctx } = makeManaged({ projectId: 11, db, prepareExecution });
    try {
      await register(ctx as never);
      const add = ctx.tools.find((t) => t.name === 'AddMcpServer')!;
      const added = await add.execute('1', { scope: 'instance', name: 'selbound', transport: 'stdio', command: process.execPath, args: [MOCK_SERVER] });
      expect(resultText(added)).toContain('Added instance MCP server "selbound"');

      // The binding is persisted exactly, canonical {kind:'managed', projectId}.
      const stored = JSON.parse((db.prepare('SELECT spec_json FROM p_mcp_servers WHERE name = ?').get('selbound') as { spec_json: string }).spec_json) as { projectRef: unknown };
      expect(stored.projectRef).toEqual({ kind: 'managed', projectId: 11 });

      // Creation verified INSIDE the guest through the managed provider, with the mcp lease kind.
      expect(prepareExecution).toHaveBeenCalledWith(expect.objectContaining({
        projectRef: { kind: 'managed', projectId: 11 }, leaseKind: 'mcp',
      }));

      // The binding is public metadata on the listed server.
      const listed = listMcpServers().find((s: { name: string }) => s.name === 'selbound') as { projectRef?: unknown };
      expect(listed.projectRef).toEqual({ kind: 'managed', projectId: 11 });
      expect(release).toHaveBeenCalledOnce();
    } finally { await teardownCtx(ctx); }
  }, 20000);

  it('refuses an explicit binding that differs from the selected project, before any launch', async () => {
    const db = openPluginTablesDb();
    const prepareExecution = vi.fn(async () => managedPrepared(11, [MOCK_SERVER]));
    const { ctx } = makeManaged({ projectId: 11, db, prepareExecution });
    try {
      await register(ctx as never);
      const add = ctx.tools.find((t) => t.name === 'AddMcpServer')!;
      const result = await add.execute('1', {
        scope: 'instance', name: 'crossbound', transport: 'stdio',
        command: process.execPath, args: [MOCK_SERVER], projectRef: { kind: 'managed', projectId: 12 },
      });
      expect(resultText(result)).toContain('differs from the selected project');
      expect((db.prepare('SELECT COUNT(*) AS n FROM p_mcp_servers').get() as { n: number }).n).toBe(0);
      expect(prepareExecution).not.toHaveBeenCalled();
    } finally { await teardownCtx(ctx); }
  }, 20000);

  it('honours an explicit managed binding when no project is selected', async () => {
    const db = openPluginTablesDb();
    const prepareExecution = vi.fn(async () => managedPrepared(41, [MOCK_SERVER]));
    const base = fakeCtx({}, undefined, db, { elowenUserId: 1, owner: true });
    const ctx = { ...base, currentAccess: () => ({}), currentAccountUserId: () => 1, defaultCwd: () => '/workspace',
      control: () => ({ prepareExecution, environmentFor: async ({ project }: { project: { projectId: number } }) => ({ projectId: project.projectId, generation: 1, state: 'running' }) }) };
    try {
      await register(ctx as never);
      const add = ctx.tools.find((t) => t.name === 'AddMcpServer')!;
      const added = await add.execute('1', {
        scope: 'instance', name: 'explbound', transport: 'stdio', command: process.execPath, args: [MOCK_SERVER],
        projectRef: { kind: 'managed', projectId: 41 },
      });
      expect(resultText(added)).toContain('Added instance MCP server "explbound"');
      const stored = JSON.parse((db.prepare('SELECT spec_json FROM p_mcp_servers WHERE name = ?').get('explbound') as { spec_json: string }).spec_json) as { projectRef: unknown };
      expect(stored.projectRef).toEqual({ kind: 'managed', projectId: 41 });
      expect(prepareExecution).toHaveBeenCalledWith(expect.objectContaining({ projectRef: { kind: 'managed', projectId: 41 }, leaseKind: 'mcp' }));
    } finally { await teardownCtx(ctx); }
  }, 20000);

  it('never launches a bound server on the host at boot, and declares its cached tools lazily', async () => {
    const log = join(tmpDir('mcp-bind-boot'), 'starts.log');
    const db = openPluginTablesDb();
    const dataDir = mkdtempSync(join(tmpdir(), 'elowen-mcp-bind-data-'));
    await bootstrapDb(db, dataDir);
    // The stored env is deliberate: an erroneous HOST launch runs through makeTransport with the spec's
    // own env, so SERVER_START_LOG catches it. There is no guest call in this test — the guest side is
    // covered by prepareExecution staying untouched.
    db.prepare('INSERT INTO p_mcp_servers (owner_user_id, name, spec_json, tools_json) VALUES (?, ?, ?, ?)')
      .run(null, 'bootbound',
        JSON.stringify({ name: 'bootbound', enabled: true, transport: 'stdio', command: process.execPath, args: [MOCK_SERVER], env: { SERVER_START_LOG: log }, projectRef: { kind: 'managed', projectId: 21 } }),
        JSON.stringify(descriptor));
    const prepareExecution = vi.fn();
    const { ctx } = makeManaged({ projectId: 21, db, prepareExecution, dataDir });
    try {
      await register(ctx as never);
      // The cached descriptor is declared (personal/managed rows advertise from the cache) …
      expect(ctx.tools.some((t) => t.name === 'mcp__bootbound__echo')).toBe(true);
      // …but boot launched NOTHING: not on the host (no server process in the start log) …
      expect(starts(log)).toBe(0);
      // …and not in a guest (no managed provisioning either).
      expect(prepareExecution).not.toHaveBeenCalled();
      expect(listMcpServers().find((s: { name: string }) => s.name === 'bootbound')?.status).toBe('disconnected');
      // And the bound row is excluded from the connect-all and background reconnect paths alike.
      await register(ctx as never);
      expect(starts(log)).toBe(0);
      expect(prepareExecution).not.toHaveBeenCalled();
    } finally { await teardownCtx(ctx); }
  }, 20000);

  it('routes a bound tool call to exactly the saved ref and refuses a different project before launch', async () => {
    const log = join(tmpDir('mcp-bind-call'), 'starts.log');
    const db = openPluginTablesDb();
    const dataDir = mkdtempSync(join(tmpdir(), 'elowen-mcp-bind-data-'));
    await bootstrapDb(db, dataDir);
    // Persisted exactly as creation left it: no central env (the managed provider refuses to import one),
    // cached descriptor beside the spec, binding {kind:'managed', projectId:31}.
    db.prepare('INSERT INTO p_mcp_servers (owner_user_id, name, spec_json, tools_json) VALUES (?, ?, ?, ?)')
      .run(null, 'callref',
        JSON.stringify({ name: 'callref', enabled: true, transport: 'stdio', command: process.execPath, args: [MOCK_SERVER], projectRef: { kind: 'managed', projectId: 31 } }),
        JSON.stringify(descriptor));
    const prepareExecution = vi.fn(async () => managedPrepared(31, [MOCK_SERVER], { SERVER_START_LOG: log }));
    const { ctx, setAccess } = makeManaged({ projectId: 31, db, prepareExecution, dataDir });
    try {
      await register(ctx as never);
      expect(starts(log)).toBe(0); // boot launched nothing
      const echo = ctx.tools.find((t) => t.name === 'mcp__callref__echo')!;

      // Matching selected project: the call runs in the guest against the SAVED ref.
      const res = (await echo.execute('1', { text: 'guest hi' })) as { content: { text: string }[] };
      expect(res.content[0]!.text).toBe('guest hi');
      expect(starts(log)).toBe(1);
      expect(prepareExecution).toHaveBeenLastCalledWith(expect.objectContaining({ projectRef: { kind: 'managed', projectId: 31 } }));

      // A DIFFERENT selected project is refused BEFORE any launch: no provider request, no process.
      setAccess({ projectRef: { kind: 'managed', projectId: 32 } });
      prepareExecution.mockClear();
      const refused = (await echo.execute('2', { text: 'nope' })) as { content: { text: string }[] };
      expect(refused.content[0]!.text).toContain('belongs to a different project');
      expect(prepareExecution).not.toHaveBeenCalled();

      // No selection at all fails closed the same way.
      setAccess({});
      const unselected = (await echo.execute('3', { text: 'nope' })) as { content: { text: string }[] };
      expect(unselected.content[0]!.text).toContain('belongs to a different project');
      expect(prepareExecution).not.toHaveBeenCalled();
      expect(starts(log)).toBe(1);
    } finally { await teardownCtx(ctx); }
  }, 30000);

  it('keeps the binding immutable across updates: no move, no deletion, no conversion to remote', async () => {
    const db = openPluginTablesDb();
    const prepareExecution = vi.fn(async () => managedPrepared(51, [MOCK_SERVER]));
    const { ctx } = makeManaged({ projectId: 51, db, prepareExecution });
    try {
      await register(ctx as never);
      const add = ctx.tools.find((t) => t.name === 'AddMcpServer')!;
      await add.execute('1', { scope: 'instance', name: 'frozen', transport: 'stdio', command: process.execPath, args: [MOCK_SERVER], enabled: false });
      const patch = ctx.apiRoutes.find((r) => r.path === 'servers' && r.method === 'PATCH')!;
      const storedRef = () => (JSON.parse((db.prepare('SELECT spec_json FROM p_mcp_servers WHERE name = ?').get('frozen') as { spec_json: string }).spec_json) as { projectRef: unknown }).projectRef;
      const patchBody = async (body: Record<string, unknown>) =>
        await patch.handler({ path: 'frozen', json: async () => body }) as { status?: number; body: { error?: string; server?: { projectRef?: unknown } } };

      // Moving it to another project is refused …
      const moved = await patchBody({ scope: 'instance', enabled: false, projectRef: { kind: 'managed', projectId: 99 } });
      expect(moved.status).toBe(409);
      expect(moved.body.error).toMatch(/immutable/);
      // … deleting the binding is refused (null) …
      const deleted = await patchBody({ scope: 'instance', enabled: false, projectRef: null });
      expect(deleted.body.error).toMatch(/immutable/);
      // … and converting to a remote server is refused — that would erase the binding.
      const converted = await patchBody({ scope: 'instance', enabled: false, transport: 'http', url: 'https://example.invalid/mcp' });
      expect(converted.body.error).toMatch(/only stdio MCP servers may have a project binding/);
      expect(storedRef()).toEqual({ kind: 'managed', projectId: 51 });

      // An ordinary update goes through and KEEPS the binding.
      const kept = await patchBody({ scope: 'instance', enabled: false, args: [MOCK_SERVER] });
      expect(kept.body.server!.projectRef).toEqual({ kind: 'managed', projectId: 51 });
      expect(storedRef()).toEqual({ kind: 'managed', projectId: 51 });
    } finally { await teardownCtx(ctx); }
  }, 20000);

  it('refuses a binding on remote transports at creation', async () => {
    const db = openPluginTablesDb();
    const base = fakeCtx({}, undefined, db, { elowenUserId: 1, owner: true });
    const ctx = { ...base, currentAccess: () => ({}) };
    try {
      await register(ctx as never);
      const add = ctx.tools.find((t) => t.name === 'AddMcpServer')!;
      const result = await add.execute('1', {
        scope: 'instance', name: 'remotebind', transport: 'http', url: 'https://example.invalid/mcp',
        projectRef: { kind: 'managed', projectId: 7 },
      });
      expect(resultText(result)).toContain('only stdio MCP servers may have a project binding');
      expect((db.prepare('SELECT COUNT(*) AS n FROM p_mcp_servers').get() as { n: number }).n).toBe(0);
    } finally { await teardownCtx(ctx); }
  }, 20000);

  it('drops stored rows whose binding no longer validates instead of ever running them on the host', async () => {
    const log = join(tmpDir('mcp-bind-corrupt'), 'starts.log');
    const db = openPluginTablesDb();
    const dataDir = mkdtempSync(join(tmpdir(), 'elowen-mcp-bind-data-'));
    await bootstrapDb(db, dataDir);
    const insert = db.prepare('INSERT INTO p_mcp_servers (owner_user_id, name, spec_json, tools_json) VALUES (?, ?, ?, ?)');
    const corrupt = (name: string, projectRef: unknown) => insert.run(null, name,
      JSON.stringify({ name, enabled: true, transport: 'stdio', command: process.execPath, args: [MOCK_SERVER], env: { SERVER_START_LOG: log }, projectRef }), '[]');
    // A projectId that stopped being an integer, and one that is null — the falsy case most likely to be
    // silently reinterpreted as "no binding" and therefore as a host command.
    corrupt('corrupt-str', { kind: 'managed', projectId: 'five' });
    corrupt('corrupt-null', null);
    const prepareExecution = vi.fn();
    const { ctx } = makeManaged({ projectId: 1, db, prepareExecution, dataDir });
    try {
      await register(ctx as never);
      // Neither row is declared, listed, prepared or spawned: fail closed, never reinterpreted.
      expect(ctx.tools.some((t) => t.name.startsWith('mcp__corrupt-'))).toBe(false);
      expect(listMcpServers().some((s: { name: string }) => s.name.startsWith('corrupt-'))).toBe(false);
      expect(prepareExecution).not.toHaveBeenCalled();
      expect(starts(log)).toBe(0);
      expect((ctx.logger.warn as ReturnType<typeof vi.fn>).mock.calls.some((c) => String(c[0]).includes('corrupt-str'))).toBe(true);
    } finally { await teardownCtx(ctx); }
  }, 20000);
});

describe('mcp plugin — managed binding validation and visibility', () => {
  let dirs: string[] = [];
  const tmpDir = (tag: string): string => { const p = mkdtempSync(join(tmpdir(), `elowen-${tag}-`)); dirs.push(p); return p; };
  afterEach(() => { for (const p of dirs) rmSync(p, { recursive: true, force: true }); dirs = []; });

  const resultText = (result: unknown) => (result as { content: { text: string }[] }).content[0]!.text;
  const descriptor = [{ name: 'echo', description: 'Echo the text back', inputSchema: { type: 'object' } }];

  const bootstrapDb = async (db: Db, dataDir: string): Promise<void> => {
    const bootstrap = fakeCtx({}, undefined, db, null, dataDir);
    await register(bootstrap as never);
    await bootstrap.hooks.find((h) => h.name === 'plugin.reload.before')!.run({});
  };
  const insertBound = (db: Db, name: string, projectId: number, spec: Record<string, unknown> = {}, tools: unknown[] = []) =>
    db.prepare('INSERT INTO p_mcp_servers (owner_user_id, name, spec_json, tools_json) VALUES (?, ?, ?, ?)')
      .run(null, name, JSON.stringify({ name, enabled: false, transport: 'stdio', command: process.execPath, args: [MOCK_SERVER], projectRef: { kind: 'managed', projectId }, ...spec }), JSON.stringify(tools));

  it('rejects a persisted binding parked on a remote transport, failing closed at load', async () => {
    const db = openPluginTablesDb();
    const dataDir = mkdtempSync(join(tmpdir(), 'elowen-mcp-bind-data-'));
    await bootstrapDb(db, dataDir);
    db.prepare('INSERT INTO p_mcp_servers (owner_user_id, name, spec_json, tools_json) VALUES (?, ?, ?, ?)')
      .run(null, 'httpbound', JSON.stringify({ name: 'httpbound', enabled: true, transport: 'http', url: 'https://example.invalid/mcp', projectRef: { kind: 'managed', projectId: 5 } }), '[]');
    const prepareExecution = vi.fn();
    const base = fakeCtx({}, undefined, db, { elowenUserId: 1, owner: true }, dataDir);
    const ctx = { ...base, currentAccess: () => ({ projectRef: { kind: 'managed', projectId: 5 } }), currentAccountUserId: () => 1, defaultCwd: () => '/workspace', control: () => ({ prepareExecution }) };
    try {
      await register(ctx as never);
      // A valid ref must not turn a malformed remote row into binding metadata around a host/remote path.
      expect(ctx.tools.some((t) => t.name.startsWith('mcp__httpbound__'))).toBe(false);
      expect(listMcpServers().some((s: { name: string }) => s.name === 'httpbound')).toBe(false);
      expect(prepareExecution).not.toHaveBeenCalled();
      expect((ctx.logger.warn as ReturnType<typeof vi.fn>).mock.calls.some((c) => String(c[0]).includes('httpbound'))).toBe(true);
    } finally { await ctx.hooks.find((h) => h.name === 'plugin.reload.before')!.run({}); ctx.rawDb.close(); rmSync(dataDir, { recursive: true, force: true }); }
  });

  it('authorizes the binding live at creation even when the server is saved disabled', async () => {
    // Revoked access and a nonexistent project are both refused BEFORE persistence, with nothing prepared.
    for (const [name, message] of [['revokedbind', 'access revoked'], ['ghostbind', 'project not found']] as const) {
      const db = openPluginTablesDb();
      const dataDir = mkdtempSync(join(tmpdir(), 'elowen-mcp-bind-data-'));
      const prepareExecution = vi.fn();
      const base = fakeCtx({}, undefined, db, { elowenUserId: 1, owner: true }, dataDir);
      const ctx = { ...base, currentAccess: () => ({ projectRef: { kind: 'managed', projectId: 71 } }), currentAccountUserId: () => 1, defaultCwd: () => '/workspace',
        control: () => ({ prepareExecution, environmentFor: async () => { throw new Error(message); } }) };
      try {
        await register(ctx as never);
        const add = ctx.tools.find((t) => t.name === 'AddMcpServer')!;
        const result = await add.execute('1', { scope: 'instance', name, transport: 'stdio', command: process.execPath, args: [MOCK_SERVER], enabled: false });
        expect(resultText(result), name).toContain(message);
        expect((db.prepare('SELECT COUNT(*) AS n FROM p_mcp_servers WHERE name = ?').get(name) as { n: number }).n).toBe(0);
        expect(prepareExecution).not.toHaveBeenCalled();
      } finally { await ctx.hooks.find((h) => h.name === 'plugin.reload.before')!.run({}); ctx.rawDb.close(); rmSync(dataDir, { recursive: true, force: true }); }
    }
  }, 20000);

  it('fails closed when the environment provider is missing, disabled binding included', async () => {
    const db = openPluginTablesDb();
    const dataDir = mkdtempSync(join(tmpdir(), 'elowen-mcp-bind-data-'));
    const base = fakeCtx({}, undefined, db, { elowenUserId: 1, owner: true }, dataDir);
    const ctx = { ...base, currentAccess: () => ({ projectRef: { kind: 'managed', projectId: 73 } }), currentAccountUserId: () => 1, defaultCwd: () => '/workspace', control: () => ({}) };
    try {
      await register(ctx as never);
      const add = ctx.tools.find((t) => t.name === 'AddMcpServer')!;
      const result = await add.execute('1', { scope: 'instance', name: 'noprovider', transport: 'stdio', command: process.execPath, args: [MOCK_SERVER], enabled: false });
      expect(resultText(result)).toContain('requires the Sandbox environment provider');
      expect((db.prepare('SELECT COUNT(*) AS n FROM p_mcp_servers').get() as { n: number }).n).toBe(0);
    } finally { await ctx.hooks.find((h) => h.name === 'plugin.reload.before')!.run({}); ctx.rawDb.close(); rmSync(dataDir, { recursive: true, force: true }); }
  }, 20000);

  it('re-checks the binding on update even when the row stays disabled', async () => {
    const db = openPluginTablesDb();
    const dataDir = mkdtempSync(join(tmpdir(), 'elowen-mcp-bind-data-'));
    await bootstrapDb(db, dataDir);
    insertBound(db, 'frozenupd', 81);
    const base = fakeCtx({}, undefined, db, { elowenUserId: 1, owner: true }, dataDir);
    const ctx = { ...base, currentAccess: () => ({}), currentAccountUserId: () => 1, defaultCwd: () => '/workspace',
      control: () => ({ prepareExecution: vi.fn(), environmentFor: async () => { throw new Error('access revoked'); } }) };
    try {
      await register(ctx as never);
      const patch = ctx.apiRoutes.find((r) => r.path === 'servers' && r.method === 'PATCH')!;
      const res = await patch.handler({ path: 'frozenupd', json: async () => ({ scope: 'instance', enabled: false }) }) as { status?: number; body: { error?: string } };
      expect(res.status).toBe(409);
      expect(res.body.error).toContain('access revoked');
      // Nothing moved: the binding and the revision survive the failed update untouched.
      const stored = JSON.parse((db.prepare('SELECT spec_json, revision FROM p_mcp_servers WHERE name = ?').get('frozenupd') as { spec_json: string; revision: number }).spec_json || '{}') as { projectRef?: { projectId: number } };
      expect(stored.projectRef).toEqual({ kind: 'managed', projectId: 81 });
      expect((db.prepare('SELECT revision FROM p_mcp_servers WHERE name = ?').get('frozenupd') as { revision: number }).revision).toBe(0);
    } finally { await ctx.hooks.find((h) => h.name === 'plugin.reload.before')!.run({}); ctx.rawDb.close(); rmSync(dataDir, { recursive: true, force: true }); }
  }, 20000);

  it('declares a bound server from its persisted cache only, never twice from a stale snapshot entry', async () => {
    const db = openPluginTablesDb();
    const dataDir = mkdtempSync(join(tmpdir(), 'elowen-mcp-bind-data-'));
    await bootstrapDb(db, dataDir);
    // A bound row whose name a STALE legacy snapshot entry (from before the binding existed) still carries.
    insertBound(db, 'legacydup', 91, { enabled: true }, descriptor);
    const prepareExecution = vi.fn();
    const base = fakeCtx({}, [{ serverName: 'legacydup', tools: descriptor }], db, { owner: true }, dataDir);
    const ctx = { ...base, currentAccess: () => ({}), currentAccountUserId: () => 1, defaultCwd: () => '/workspace', control: () => ({ prepareExecution }) };
    try {
      await register(ctx as never);
      const names = ctx.tools.filter((t) => t.name === 'mcp__legacydup__echo');
      expect(names).toHaveLength(1);
      expect(prepareExecution).not.toHaveBeenCalled();
    } finally { await ctx.hooks.find((h) => h.name === 'plugin.reload.before')!.run({}); ctx.rawDb.close(); rmSync(dataDir, { recursive: true, force: true }); }
  }, 20000);

  it('hides a bound resource server from a wrong project and lists it through its own project', async () => {
    const db = openPluginTablesDb();
    const dataDir = mkdtempSync(join(tmpdir(), 'elowen-mcp-bind-data-'));
    await bootstrapDb(db, dataDir);
    insertBound(db, 'resbound', 61, { enabled: true });
    const prepareExecution = vi.fn(async () => ({
      mode: 'managed', projectRef: { kind: 'managed', projectId: 61 }, cwd: tmpDir('mcp-bind-resource'), displayCwd: '/workspace',
      launch: { type: 'argv', file: process.execPath, args: [RESOURCE_MOCK_SERVER], env: {} },
      lease: { id: 'mcp-bind-resource', heartbeat() {}, release: vi.fn() },
      cancel: vi.fn(async () => {}), sanitizeOutput: (text: string) => text,
    }));
    const base = fakeCtx({}, undefined, db, { elowenUserId: 1, owner: true }, dataDir);
    let access: unknown = { projectRef: { kind: 'managed', projectId: 62 } }; // wrong project selected
    const ctx = { ...base, currentAccess: () => access, currentAccountUserId: () => 1, defaultCwd: () => '/workspace', control: () => ({ prepareExecution, environmentFor: async () => ({ projectId: 61, generation: 1, state: 'running' }) }) };
    try {
      await register(ctx as never);
      const list = ctx.tools.find((t) => t.name === 'ListMcpResources')!;

      // Wrong project: the bound server is filtered from the visible set entirely.
      const hidden = (await list.execute('1', { server: 'resbound' })) as { content: { text: string }[] };
      expect(hidden.content[0]!.text).toContain('is not connected');
      const full = (await list.execute('2', {})) as { content: { text: string }[] };
      expect(full.content[0]!.text).not.toContain('resbound');
      expect(prepareExecution).not.toHaveBeenCalled();

      // Matching project: listed through the guest.
      access = { projectRef: { kind: 'managed', projectId: 61 } };
      const listed = (await list.execute('3', {})) as { content: { text: string }[]; details: { ok: boolean } };
      expect(listed.details.ok).toBe(true);
      expect(listed.content[0]!.text).toContain('file:///notes.txt');
      expect(prepareExecution).toHaveBeenCalledWith(expect.objectContaining({ projectRef: { kind: 'managed', projectId: 61 }, leaseKind: 'mcp' }));
    } finally { await ctx.hooks.find((h) => h.name === 'plugin.reload.before')!.run({}); ctx.rawDb.close(); rmSync(dataDir, { recursive: true, force: true }); }
  }, 30000);
});
