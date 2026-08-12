import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { makeTestApp } from '../helpers/testApp.js';
import { AGENTS_MCP_TOOLS } from '../../plugins/agents/src/mcpTools.js';
import { TaskStore } from '../../plugins/work/src/store/taskStore.js';
import { Readiness } from '../../plugins/work/src/store/readiness.js';
import { MissionStore } from '../../plugins/agents/src/store/missionStore.js';
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
import { openAgentsDb } from '../helpers/agentsDb.js';

const AGENTS_NAMES = AGENTS_MCP_TOOLS.map((t) => t.name);

const rpc = (token: string, method: string, params: unknown) => ({
  method: 'POST',
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 7, method, params }),
});

async function toolNames(res: Response): Promise<string[]> {
  expect(res.status).toBe(200);
  const body = await res.text();
  const dataLine = body.split('\n').find((l) => l.startsWith('data:'));
  const parsed = JSON.parse(dataLine!.replace(/^data:\s*/, ''));
  return parsed.result?.tools?.map((t: { name: string }) => t.name) ?? [];
}

describe('/mcp surface composition (live plugin registry)', () => {
  it('with the agents plugin enabled, tools/list serves core + the agents dozen (19)', async () => {
    const { app, token } = await makeTestApp({});
    const names = await toolNames(await app.request('/mcp', rpc(token, 'tools/list', {})));
    expect(names).toHaveLength(19);
    for (const n of AGENTS_NAMES) expect(names).toContain(n);
  });

  it('with the plugin discovered-but-DISABLED, the agents tools vanish and core stays', async () => {
    const db = openAgentsDb(':memory:');
    db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'elowen','/o')").run();
    const users = new UserStore(db);
    const admin = users.create('admin', 'pw');
    const app = createServer({
      tasks: new TaskStore(db), readiness: new Readiness(db), missions: new MissionStore(db), bus: new EventBus(),
      tmux: new FakeTmuxDriver() as never,
      project: { id: 1, path: '/o' }, fallback: { program: 'claude-code', model: 'sonnet' },
      clock: new FakeClock(0), config: new ConfigStore(db), users, projects: new ProjectStore(db), userProjects: new UserProjectStore(db),
      plugins: new PluginRegistryProvider(() => loadPlugins({
        dirs: [join(process.cwd(), 'plugins')], enabled: [], logger: { info() {}, warn() {}, error() {} },
      })),
      pluginDirs: [join(process.cwd(), 'plugins')],
    });
    const token = users.issueToken(admin.id);
    const names = await toolNames(await app.request('/mcp', rpc(token, 'tools/list', {})));
    expect(names).toHaveLength(7);
    for (const n of AGENTS_NAMES) expect(names).not.toContain(n);
    expect(names).toContain('elowen_request');
    expect(names).toContain('elowen_plan');

    // Calling a vanished tool answers a clear isError result, not a crash or a bare 503.
    const res = await app.request('/mcp', rpc(token, 'tools/call', { name: 'elowen_missions', arguments: {} }));
    const body = await res.text();
    const dataLine = body.split('\n').find((l) => l.startsWith('data:'));
    const parsed = JSON.parse(dataLine!.replace(/^data:\s*/, ''));
    expect(parsed.result?.isError).toBe(true);
    expect(String(parsed.result?.content?.[0]?.text)).toMatch(/Tool elowen_missions not found/);
  });
});
