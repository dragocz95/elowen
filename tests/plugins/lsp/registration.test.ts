import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { openAgentsDb } from '../../helpers/agentsDb.js';
import { loadPlugins } from '../../../src/plugins/loader.js';
import { PluginRegistryProvider } from '../../../src/plugins/pluginsProvider.js';
import { createServer } from '../../../src/api/server.js';
import { ConfigStore } from '../../../src/store/configStore.js';
import { UserStore } from '../../../src/store/userStore.js';
import { TaskStore } from '../../../plugins/work/src/store/taskStore.js';
import { ProjectStore } from '../../../src/store/projectStore.js';
import { UserProjectStore } from '../../../src/store/userProjectStore.js';
import { MissionStore } from '../../../plugins/agents/src/store/missionStore.js';
import { Readiness } from '../../../plugins/work/src/store/readiness.js';
import { EventBus } from '../../../src/api/sse.js';
import { FakeClock } from '../../../src/shared/clock.js';

const PLUGINS_DIR = join(process.cwd(), 'plugins');
const LSP_TOOLS = [
  'LspDiagnostics', 'LspGoToDefinition', 'LspFindReferences', 'LspHover', 'LspDocumentSymbol', 'LspWorkspaceSymbol',
];

/** Load the REAL on-disk lsp plugin (plugins/lsp → dist/index.js, so `npm run build:ts` must have built
 *  it, exactly like the agents plugin's register test). */
const loadWith = (enabled: string[]) => loadPlugins({
  dirs: [PLUGINS_DIR], enabled, logger: { info() {}, warn() {}, error() {} },
});

function serverWith(enabled: string[]) {
  const db = openAgentsDb(':memory:');
  db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'elowen','/o')").run();
  const users = new UserStore(db);
  const admin = users.create('admin', 'pw');
  const app = createServer({
    tasks: new TaskStore(db), readiness: new Readiness(db), missions: new MissionStore(db), bus: new EventBus(),
    tmux: null as never,
    project: { id: 1, path: '/o' }, fallback: { program: 'claude-code', model: 'sonnet' },
    clock: new FakeClock(0), config: new ConfigStore(db), users, projects: new ProjectStore(db),
    userProjects: new UserProjectStore(db),
    plugins: new PluginRegistryProvider(() => loadWith(enabled)),
    pluginDirs: [PLUGINS_DIR],
  });
  return { app, tok: users.issueToken(admin.id) };
}

describe('lsp plugin ON', () => {
  it('contributes the six tools, their plan-safety and the state control to the live registry', async () => {
    const reg = await loadWith(['lsp']);
    expect(reg.tools.map((t) => t.name)).toEqual(LSP_TOOLS);
    // Plan mode composes from the manifest now that the core list no longer names them.
    for (const name of LSP_TOOLS) expect(reg.toolPlanSafe.has(name)).toBe(true);
    expect(reg.control('lsp')?.diagnosticsEnabled()).toBe(true);
    expect(reg.toolOwner.get('LspDiagnostics')).toBe('lsp');
  });

  it('serves the grandfathered GET /brain/lsp at its original URL', async () => {
    const { app, tok } = serverWith(['lsp']);
    const res = await app.request('/brain/lsp', { headers: { authorization: `Bearer ${tok}` } });
    expect(res.status).toBe(200);
    const body = await res.json() as { enabled: boolean; running: boolean; servers: { command: string; label: string; installable: boolean; installHint: string }[] };
    expect(body).toMatchObject({ enabled: true, running: false });
    expect(body.servers.find((s) => s.command === 'typescript-language-server'))
      .toMatchObject({ label: 'TypeScript', installable: true, installHint: 'npm install -g typescript-language-server typescript' });
    // A server that ships with its own toolchain is reported as not self-installable, with its hint.
    expect(body.servers.find((s) => s.command === 'gopls'))
      .toMatchObject({ installable: false, installHint: 'go install golang.org/x/tools/gopls@latest' });
  });

  it('refuses an unknown server and one Elowen does not manage, instead of shelling out', async () => {
    const { app, tok } = serverWith(['lsp']);
    const post = (path: string, body: unknown) => app.request(path, {
      method: 'POST', headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect((await post('/brain/lsp/install', { command: 'not-a-server' })).status).toBe(404);
    expect((await post('/brain/lsp/install', {})).status).toBe(400);
    const toolchain = await post('/brain/lsp/uninstall', { command: 'gopls' });
    expect(toolchain.status).toBe(400);
    expect(((await toolchain.json()) as { error: string }).error).toContain('go install');
  });
});

describe('lsp plugin OFF', () => {
  it('withdraws every tool from the composed set — no LSP names reach the model', async () => {
    const reg = await loadWith([]);
    expect(reg.tools.map((t) => t.name).filter((n) => n.startsWith('Lsp'))).toEqual([]);
    for (const name of LSP_TOOLS) expect(reg.toolPlanSafe.has(name)).toBe(false);
    expect(reg.control('lsp')).toBeUndefined();
  });

  it('answers an explicit 503 on all three routes — "off" is distinguishable from "no such endpoint"', async () => {
    const { app, tok } = serverWith([]);
    const auth = { authorization: `Bearer ${tok}` };
    const res = await app.request('/brain/lsp', { headers: auth });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'lsp plugin is disabled' });
    for (const path of ['/brain/lsp/install', '/brain/lsp/uninstall']) {
      const r = await app.request(path, {
        method: 'POST', headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({ command: 'typescript-language-server' }),
      });
      expect(r.status).toBe(503);
      expect(await r.json()).toEqual({ error: 'lsp plugin is disabled' });
    }
  });
});
