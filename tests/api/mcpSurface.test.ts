import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventBus } from '../../src/api/sse.js';
import { createServer } from '../../src/api/server.js';
import { FakeClock } from '../../src/shared/clock.js';
import { ConfigStore } from '../../src/store/configStore.js';
import { UserStore } from '../../src/store/userStore.js';
import { ProjectStore } from '../../src/store/projectStore.js';
import { UserProjectStore } from '../../src/store/userProjectStore.js';
import { FakeTmuxDriver } from '../../src/tmux/fakeDriver.js';
import { loadPlugins } from '../../src/plugins/loader.js';
import { PluginRegistryProvider } from '../../src/plugins/pluginsProvider.js';
import { CORE_MCP_TOOLS } from '../../src/mcp/tools.js';
import { openPluginTablesDb } from '../helpers/pluginTablesDb.js';
import { RefMissions, RefTaskStore } from '../helpers/refStores.js';

/** How the daemon's OWN /mcp server COMPOSES: its escape hatch plus whatever the loaded plugins
 *  contribute, and what happens to a plugin tool when its owner is switched off. The contributors are a
 *  fixture plugin written to disk here, because the rule under test is the composition — not which tools
 *  any particular product plugin ships (those are pinned beside them, in their own repository). */
const CORE_NAMES = CORE_MCP_TOOLS.map((t) => t.name);
const FIXTURE_TOOLS = ['fixture_list', 'fixture_create', 'fixture_probe'];

let pluginRoots: string[] = [];
afterEach(() => { for (const p of pluginRoots) rmSync(p, { recursive: true, force: true }); pluginRoots = []; });

/** An on-disk plugin contributing MCP tools, plus the dir it lives in — DISCOVERABLE in both shapes
 *  below, so "switched off" and "never existed" stay distinguishable. */
function fixturePluginDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'mcp-surface-'));
  pluginRoots.push(root);
  const dir = join(root, 'fixture');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'elowen-plugin.json'), JSON.stringify({
    name: 'fixture', version: '1.0.0', apiVersion: '1', description: 'contributes MCP tools',
    entry: 'index.mjs', userGrantable: true, provides: { mcpTools: FIXTURE_TOOLS },
  }));
  writeFileSync(join(dir, 'index.mjs'), `
    export function register(ctx){
      for (const name of ${JSON.stringify(FIXTURE_TOOLS)}) {
        ctx.registerMcpTool({ name, description: name + ' does a thing.', inputSchema: {}, run: async () => ({ ok: name }) });
      }
    }
  `);
  return root;
}

function makeApp(enabled: string[]) {
  const dirs = [fixturePluginDir()];
  const db = openPluginTablesDb(':memory:');
  db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'elowen','/o')").run();
  const users = new UserStore(db);
  const admin = users.create('admin', 'pw');
  const amy = users.create('amy', 'pw');
  const bob = users.create('bob', 'pw');
  users.setGrantedPlugins(bob.id, ['fixture']);
  const app = createServer({
    tasks: new RefTaskStore(db), missions: new RefMissions(db), bus: new EventBus(),
    tmux: new FakeTmuxDriver() as never,
    project: { id: 1, path: '/o' }, fallback: { program: 'claude-code', model: 'sonnet' },
    clock: new FakeClock(0), config: new ConfigStore(db), users, projects: new ProjectStore(db), userProjects: new UserProjectStore(db),
    plugins: new PluginRegistryProvider(() => loadPlugins({ dirs, enabled, logger: { info() {}, warn() {}, error() {} } })),
    pluginDirs: dirs,
  });
  return {
    app,
    token: users.issueToken(admin.id),
    amyToken: users.issueToken(amy.id),
    bobToken: users.issueToken(bob.id),
  };
}

const rpc = (token: string, method: string, params: unknown) => ({
  method: 'POST',
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 7, method, params }),
});

/** The single `data:` frame of an /mcp response, parsed. */
async function rpcResult(res: Response): Promise<{ tools?: { name: string }[]; isError?: boolean; content?: { text?: string }[] }> {
  expect(res.status).toBe(200);
  const dataLine = (await res.text()).split('\n').find((l) => l.startsWith('data:'));
  return JSON.parse(dataLine!.replace(/^data:\s*/, '')).result ?? {};
}
const toolNames = async (res: Response) => (await rpcResult(res)).tools?.map((t) => t.name) ?? [];

describe('/mcp surface composition (live plugin registry)', () => {
  it('with a contributing plugin enabled, tools/list serves core + plugin tools', async () => {
    const { app, token } = makeApp(['fixture']);
    const names = await toolNames(await app.request('/mcp', rpc(token, 'tools/list', {})));
    expect([...names].sort()).toEqual([...CORE_NAMES, ...FIXTURE_TOOLS].sort());
    // A contributed tool is really callable, not merely listed.
    const called = await rpcResult(await app.request('/mcp', rpc(token, 'tools/call', { name: 'fixture_probe', arguments: {} })));
    expect(called.isError).toBeFalsy();
    expect(String(called.content?.[0]?.text)).toContain('fixture_probe');
  });

  it('withholds a grantable plugin MCP surface from another account without its grant', async () => {
    const { app, amyToken, bobToken } = makeApp(['fixture']);
    expect(await toolNames(await app.request('/mcp', rpc(amyToken, 'tools/list', {})))).toEqual(CORE_NAMES);
    expect(await toolNames(await app.request('/mcp', rpc(bobToken, 'tools/list', {})))).toEqual([...CORE_NAMES, ...FIXTURE_TOOLS]);

    const refused = await rpcResult(await app.request('/mcp', rpc(amyToken, 'tools/call', { name: 'fixture_probe', arguments: {} })));
    expect(refused.isError).toBe(true);
    expect(String(refused.content?.[0]?.text)).toMatch(/Tool fixture_probe not found/);
  });

  it('with the plugin discovered-but-DISABLED, its tools vanish and the escape hatch stays', async () => {
    const { app, token } = makeApp([]);
    const names = await toolNames(await app.request('/mcp', rpc(token, 'tools/list', {})));
    expect(names).toEqual(CORE_NAMES);
    for (const n of FIXTURE_TOOLS) expect(names).not.toContain(n);

    // Calling a vanished tool answers a clear isError result, not a crash or a bare 503.
    const called = await rpcResult(await app.request('/mcp', rpc(token, 'tools/call', { name: 'fixture_probe', arguments: {} })));
    expect(called.isError).toBe(true);
    expect(String(called.content?.[0]?.text)).toMatch(/Tool fixture_probe not found/);
  });
});
