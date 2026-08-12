import { describe, it, expect } from 'vitest';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { register } from '../../../plugins/lsp/src/index.js';
import { LspManager } from '../../../plugins/lsp/src/manager.js';
import type { LspTransport, JsonRpcMessage } from '../../../plugins/lsp/src/client.js';
import type { PluginApiRoute, PluginContext, PluginControl, PluginService } from '../../../src/plugins/api.js';
import { runWithPolicy } from '../../../src/plugins/policyContext.js';
import { allowedRoots, assertPathAllowed, defaultCwd, isAllAccess } from '../../../src/plugins/pathGuard.js';
import { currentWorkDir } from '../../../src/plugins/policyContext.js';

/** A language server that answers didOpen with a clean verdict, and records being disposed. This is
 *  what "no orphaned language server" is measured against: in production `dispose()` is what kills the
 *  child process, so a teardown that never calls it is a leaked server. */
function fakeServer(): LspTransport & { disposed: () => boolean } {
  let onMsg: (m: JsonRpcMessage) => void = () => {};
  let disposed = false;
  return {
    send: (framed) => {
      const msg = JSON.parse(framed.split('\r\n\r\n')[1]!) as JsonRpcMessage;
      if (msg.method === 'initialize' && typeof msg.id === 'number') {
        queueMicrotask(() => onMsg({ jsonrpc: '2.0', id: msg.id, result: { capabilities: {} } }));
      } else if (msg.method === 'textDocument/didOpen') {
        const uri = (msg.params as { textDocument: { uri: string } }).textDocument.uri;
        queueMicrotask(() => onMsg({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri, diagnostics: [] } }));
      }
    },
    onMessage: (cb) => { onMsg = cb; },
    onExit: () => {},
    dispose: () => { disposed = true; },
    disposed: () => disposed,
  };
}

/** Register the plugin exactly as the host does, capturing every contribution, with a manager whose
 *  servers are fake transports (so nothing spawns a real tsserver). */
function registerPlugin(config: Record<string, unknown> = {}) {
  const spawned: ReturnType<typeof fakeServer>[] = [];
  const managers: LspManager[] = [];
  const tools: ToolDefinition[] = [];
  const services: PluginService[] = [];
  const controls = new Map<string, PluginControl>();
  const routes: PluginApiRoute[] = [];
  const ctx = {
    config,
    logger: { info() {}, warn() {}, error() {} },
    assertPathAllowed, allowedRoots, defaultCwd, workDir: currentWorkDir, isAdminSession: isAllAccess,
    registerTool: (t: ToolDefinition) => { tools.push(t); },
    registerService: (s: PluginService) => { services.push(s); },
    registerControl: (name: string, c: PluginControl) => { controls.set(name, c); },
    registerApiRoute: (r: PluginApiRoute) => { routes.push(r); },
  } as unknown as PluginContext;
  register(ctx, {
    createManager: () => {
      const m = new LspManager({
        spawn: () => { const t = fakeServer(); spawned.push(t); return t; },
        readFile: () => 'const a = 1;\n',
        exists: () => true,
      });
      managers.push(m);
      return m;
    },
  });
  return { tools, services, controls, routes, spawned, managers };
}

/** Type-check one file through the registered tool, inside a turn scoped to `root`. */
async function check(tools: ToolDefinition[], root: string): Promise<void> {
  const tool = tools.find((t) => t.name === 'LspDiagnostics')!;
  await runWithPolicy(
    { allowedProjectIds: new Set([1]), allowedPaths: () => [root] },
    () => tool.execute('c1', { path: `${root}/a.ts` }, undefined as never, undefined as never),
  );
}

describe('lsp plugin lifecycle', () => {
  it('registers the tools, the grandfathered routes, the service and the state control', () => {
    const { tools, services, controls, routes } = registerPlugin();
    expect(tools.map((t) => t.name)).toEqual([
      'LspDiagnostics', 'LspGoToDefinition', 'LspFindReferences', 'LspHover', 'LspDocumentSymbol', 'LspWorkspaceSymbol',
    ]);
    expect(services.map((s) => s.name)).toEqual(['diagnostics']);
    expect([...controls.keys()]).toEqual(['lsp']);
    // The URLs the CLI already calls, with the access levels they had as core routes.
    expect(routes.map((r) => `${r.method} ${r.rootMount} ${r.access}`)).toEqual([
      'GET /brain/lsp user',
      'POST /brain/lsp/install admin',
      'POST /brain/lsp/uninstall admin',
    ]);
  });

  it('seeds the live state from its own config slice, and reports it through the control', () => {
    expect(registerPlugin({ diagnosticsEnabled: false }).controls.get('lsp')!.diagnosticsEnabled()).toBe(false);
    expect(registerPlugin({ diagnosticsEnabled: true }).controls.get('lsp')!.diagnosticsEnabled()).toBe(true);
    expect(registerPlugin().controls.get('lsp')!.diagnosticsEnabled()).toBe(true); // unset → on, as in core
  });

  // THE regression this extraction exists for: the pre-extraction manager was a module singleton that
  // lived until the process died, so a disable/reload left its language servers running.
  it('stopping the service disposes every live language server (no orphans across a reload)', async () => {
    const { tools, services, spawned, managers } = registerPlugin();
    const service = services[0]!;
    await service.start();
    await check(tools, '/tmp');
    expect(spawned).toHaveLength(1);
    expect(managers[0]!.isRunning()).toBe(true);

    await service.stop();
    expect(spawned[0]!.disposed()).toBe(true);
    expect(managers[0]!.isRunning()).toBe(false);
  });

  it('a reload starts from a fresh manager instead of the stopped one', async () => {
    const { tools, services, spawned, managers } = registerPlugin();
    const service = services[0]!;
    await service.start();
    await check(tools, '/tmp');
    await service.stop();

    // Second cycle: the host re-runs start() after swapping the registry.
    await service.start();
    await check(tools, '/tmp');
    expect(managers).toHaveLength(2);
    expect(spawned).toHaveLength(2);
    expect(spawned[1]!.disposed()).toBe(false);

    await service.stop();
    expect(spawned[1]!.disposed()).toBe(true);
  });

  it('a stopped generation stays stopped — a late call cannot resurrect its manager', async () => {
    const { tools, services, controls, spawned, managers } = registerPlugin({ diagnosticsEnabled: false });
    const service = services[0]!;
    await service.start();
    await service.stop();

    // A reload runs stop() BEFORE the registry swap, so a request can still reach this generation. It
    // must NOT build a manager nobody will ever stop again.
    await check(tools, '/tmp');
    expect(managers).toHaveLength(1); // only the one start() made
    expect(spawned).toHaveLength(0);
    // The control keeps answering — from the persisted slice, since there is no live manager to ask.
    expect(controls.get('lsp')!.diagnosticsEnabled()).toBe(false);
  });

  it('disposes on process exit too, for a runner that never runs plugin services', async () => {
    const before = process.listeners('exit').length;
    const { tools, spawned } = registerPlugin();
    const added = process.listeners('exit').slice(before);
    expect(added).toHaveLength(1);

    // A sub-agent runner loads the plugin and calls tools, but PluginServiceRunner never runs there —
    // so this listener is the only thing between a spawned language server and an orphan.
    await check(tools, '/tmp');
    expect(spawned).toHaveLength(1);
    (added[0] as () => void)();
    expect(spawned[0]!.disposed()).toBe(true);
    process.off('exit', added[0] as () => void);
  });

  it('with diagnostics off, no server is spawned at all and the tool says why', async () => {
    const { tools, services, spawned } = registerPlugin({ diagnosticsEnabled: false });
    await services[0]!.start();
    const tool = tools.find((t) => t.name === 'LspDiagnostics')!;
    const res = await runWithPolicy(
      { allowedProjectIds: new Set([1]), allowedPaths: () => ['/tmp'] },
      () => tool.execute('c1', { path: '/tmp/a.ts' }, undefined as never, undefined as never),
    );
    expect(res.content[0]!.text).toContain('LSP is off');
    expect(spawned).toHaveLength(0);
  });
});
