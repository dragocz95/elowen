import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PluginRegistry } from '../../src/plugins/registry.js';
import { loadPlugins } from '../../src/plugins/loader.js';
import type { KnownControls, PluginCapabilities, PluginControl } from '../../src/plugins/api.js';

const noopLog = { info() {}, warn() {}, error() {} };
const fakeLsp = (): KnownControls['lsp'] => ({ diagnosticsEnabled: () => true });
const fakeGitHub = (): KnownControls['github'] => ({ sessionCredential: () => ({ token: 'secret', login: 'octocat' }) });
const fakeSandbox = (): KnownControls['sandbox'] => ({
  workspaceRoots: () => [],
  resolveWorkspace: () => ({}) as never,
  acquireDelegationLease: () => ({}) as never,
  workspacesFor: () => [],
  activeWorkspace: () => null,
  prepareExecution: async () => ({}) as never,
});
const fakeWorkflow = (): KnownControls['workflow'] => ({
  cancelForSession: () => ({ cancelled: 0 }),
  detachForeground: () => ({ detached: 0 }),
  activeCount: () => 0,
  isWorkflowLive: () => false,
  addNodesFromSession: () => ({ added: [] }),
  resumeInterrupted: async () => ({ status: 'done', nodes: [] }) as never,
} as unknown as KnownControls['workflow']);

function contextOver(merged: PluginRegistry, caps?: PluginCapabilities, warn?: (message: string) => void, consumer = 'consumer') {
  const staging = new PluginRegistry();
  const logger = warn ? { info() {}, warn, error() {} } : noopLog;
  return staging.contextFor(
    consumer, {}, logger, undefined, undefined, undefined, undefined, caps, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    (name) => merged.control(name),
  );
}

function ownerMerges(merged: PluginRegistry, owner: string, key: string, control: unknown, requires?: string): void {
  const staging = new PluginRegistry();
  staging.contextFor(owner, {}, noopLog).registerControl(key, control as PluginControl, requires ? { requires } : undefined);
  merged.merge(staging);
}

describe('ctx.control — one plugin reaching another plugin domain', () => {
  it('requires the controls read capability', () => {
    const merged = new PluginRegistry();
    ownerMerges(merged, 'lsp', 'lsp', fakeLsp());
    const warnings: string[] = [];
    expect(contextOver(merged, {}, (message) => warnings.push(message)).control('lsp')).toBeUndefined();
    expect(warnings.join('\n')).toContain("control('lsp') denied");
    expect(contextOver(merged, { reads: ['stores'] }).control('lsp')).toBeUndefined();
  });

  it('resolves a complete known control at call time', () => {
    const merged = new PluginRegistry();
    const ctx = contextOver(merged, { reads: ['controls'] });
    expect(ctx.control('lsp')).toBeUndefined();
    const control = fakeLsp();
    ownerMerges(merged, 'lsp', 'lsp', control);
    expect(ctx.control('lsp')).toBe(control);
  });

  it('restricts credential and process controls to loader-identified internal consumers', () => {
    const merged = new PluginRegistry();
    ownerMerges(merged, 'github', 'github', fakeGitHub());
    ownerMerges(merged, 'sandbox', 'sandbox', fakeSandbox());
    const warnings: string[] = [];
    const untrusted = contextOver(merged, { reads: ['controls'] }, (message) => warnings.push(message));
    expect(untrusted.control('github')).toBeUndefined();
    expect(untrusted.control('sandbox')).toBeUndefined();
    expect(warnings.join('\n')).toContain('not an approved consumer');
    expect(contextOver(merged, { reads: ['controls'] }, undefined, 'sandbox').control('github')).toBeDefined();
    expect(contextOver(merged, { reads: ['controls'] }, undefined, 'terminal').control('sandbox')).toBeDefined();
  });

  it('refuses an incomplete known control', () => {
    const merged = new PluginRegistry();
    ownerMerges(merged, 'workflow', 'workflow', { activeCount: () => 0 } as unknown as PluginControl);
    ownerMerges(merged, 'sandbox', 'sandbox', { workspaceRoots: () => [] } as unknown as PluginControl);
    expect(contextOver(merged, { reads: ['controls'] }).control('workflow')).toBeUndefined();
    expect(contextOver(merged, { reads: ['controls'] }).control('sandbox')).toBeUndefined();
  });

  /** The cron control's navigation method is ADDITIVE. An older installed cronjob plugin registers only
   *  the wake-up retention method, and it must go on resolving as the cron control: the retention janitor
   *  asks it before deleting an idle conversation, and a control that stopped resolving would silently
   *  turn that protection off — deleting conversations a pending wake-up still needs. Adding
   *  `conversationLinks` to the required list is exactly what this forbids. */
  it('resolves a cron control that carries only the required wake-up method', () => {
    const merged = new PluginRegistry();
    ownerMerges(merged, 'cronjob', 'cron', { pendingWakeupOriginSessionIds: () => ['brain-1-pinned'] });

    const control = merged.control('cron');

    expect(control?.pendingWakeupOriginSessionIds(1)).toEqual(['brain-1-pinned']);
    expect(control?.conversationLinks).toBeUndefined();
  });

  it('still refuses a cron control that carries only the optional navigation method', () => {
    const merged = new PluginRegistry();
    ownerMerges(merged, 'cronjob', 'cron', { conversationLinks: () => [] } as unknown as PluginControl);

    expect(merged.control('cron')).toBeUndefined();
  });

  it('resolves the complete Sandbox contract live', () => {
    const merged = new PluginRegistry();
    const ctx = contextOver(merged, { reads: ['controls'] }, undefined, 'terminal');
    const first = fakeSandbox();
    ownerMerges(merged, 'sandbox-a', 'sandbox', first);
    expect(ctx.control('sandbox')).toBe(first);
    merged.controls.delete('sandbox');
    merged.controlOwner.delete('sandbox');
    expect(ctx.control('sandbox')).toBeUndefined();
    const next = fakeSandbox();
    ownerMerges(merged, 'sandbox-b', 'sandbox', next);
    expect(ctx.control('sandbox')).toBe(next);
  });

  it('resolves a dependent control only while its complete dependency exists', () => {
    const merged = new PluginRegistry();
    ownerMerges(merged, 'workflow', 'workflow', fakeWorkflow(), 'lsp');
    expect(merged.control('workflow')).toBeUndefined();
    ownerMerges(merged, 'lsp', 'lsp', fakeLsp());
    expect(merged.control('workflow')).toBeDefined();
    merged.controls.delete('lsp');
    expect(merged.control('workflow')).toBeUndefined();
  });

  /** The delegating plugins are NOT approved consumers of the Sandbox control, and must not become ones:
   *  it carries process-launch authority. They still have to assign workspaces to the children they spawn,
   *  so the registry serves that one operation itself. Reaching for the control instead is what made every
   *  live WorkflowStart with a workspaceId fail while the plugin's own tests passed. */
  it('serves the subagent plugin a workspace resolver instead of the Sandbox control it is refused', () => {
    const merged = new PluginRegistry();
    ownerMerges(merged, 'sandbox', 'sandbox', {
      ...fakeSandbox(),
      workspacesFor: () => [{ workspaceId: 'ws_1', projectId: 7, path: '/host/ws_1', label: 'ws', branch: 'b', baseRef: 'main' }],
      resolveWorkspace: ({ workspace }) => ({ ...workspace, accountUserId: 1, path: '/host/ws_1' }),
    } as KnownControls['sandbox']);
    const warnings: string[] = [];
    const ctx = contextOver(merged, { reads: ['controls'] }, (message) => warnings.push(message), 'subagent');

    expect(ctx.control('sandbox')).toBeUndefined();
    expect(warnings.join('\n')).toContain('not an approved consumer');
    expect(ctx.resolveWorkspaceScope({ admin: false, projectIds: [7], accountUserId: 1 }, 'ws_1'))
      .toEqual({ workspaceId: 'ws_1', projectId: 7 });
    // Nothing requested and nothing inherited is the ordinary project-scoped turn, not an error.
    expect(ctx.resolveWorkspaceScope({ admin: false, projectIds: [7], accountUserId: 1 })).toBeUndefined();
    // An account-less turn is refused rather than resolved against whoever owns the rows.
    expect(() => ctx.resolveWorkspaceScope({ admin: true, projectIds: [], accountUserId: null }, 'ws_1'))
      .toThrow(/requires a linked Elowen account/);
    // It answers "does this workspace id belong to this account", so it rides the same deny-by-default
    // grant as the control it replaces rather than being open to every enabled plugin.
    expect(() => contextOver(merged, {}, undefined, 'stranger')
      .resolveWorkspaceScope({ admin: false, projectIds: [7], accountUserId: 1 }, 'ws_1'))
      .toThrow(/reads:\['controls'\] capability/);
  });

  it('lets a core-owned privileged control replace a plugin claim on its reserved key', () => {
    const merged = new PluginRegistry();
    ownerMerges(merged, 'untrusted-plugin', 'publishedSitesGateway', { hostnameBase: () => 'evil.test' });
    const host: KnownControls['publishedSitesGateway'] = {
      hostnameBase: () => 'sites.agent.example',
      syncSites: async () => ({ available: true, active: true, hostnameBase: 'sites.agent.example', slugs: [] }),
      ensureSite: async () => ({ available: true, active: true, hostnameBase: 'sites.agent.example' }),
      removeSite: async () => ({ available: true, active: false, hostnameBase: 'sites.agent.example' }),
      deny: async () => ({ available: true, active: false, hostnameBase: 'sites.agent.example' }),
      status: async () => ({ available: true, active: false, hostnameBase: 'sites.agent.example' }),
      environmentsStatus: async () => ({ ready: true, items: [] }),
      provisionEnvironments: async () => ({ ready: true, items: [] }),
      prepareRuntimeSocket: async () => ({ path: '/var/lib/elowen/site-runtime-sockets/x/app.sock' }),
      sealRuntimeSocket: async () => {},
      removeRuntimeSocket: async () => {},
    };
    merged.registerHostControl('publishedSitesGateway', host);
    expect(merged.control('publishedSitesGateway')).toBe(host);
    expect(merged.controlOwner.get('publishedSitesGateway')).toBe('core');
  });
});

describe('ctx.control through the real loader', () => {
  let root: string;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'elowen-controls-'));
    const plugin = (name: string, body: string, extra: Record<string, unknown> = {}) => {
      const dir = join(root, name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'elowen-plugin.json'), JSON.stringify({
        name, version: '0.1.0', apiVersion: '1', description: name, entry: 'index.mjs', ...extra,
      }));
      writeFileSync(join(dir, 'index.mjs'), body);
    };
    plugin('aconsumer', `export function register(ctx){
      globalThis.__controlProbe = () => ctx.control('lsp');
      ctx.registerSystemPromptFragment('at-register:' + (ctx.control('lsp') === undefined ? 'absent' : 'present'));
    }`, { capabilities: { reads: ['controls'] } });
    plugin('zowner', `export function register(ctx){
      ctx.registerControl('lsp', { diagnosticsEnabled: () => true });
    }`);
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
    delete (globalThis as { __controlProbe?: unknown }).__controlProbe;
  });

  it('a consumer loaded before the owner resolves it after loading finishes', async () => {
    const registry = await loadPlugins({ dirs: [root], enabled: ['aconsumer', 'zowner'], logger: noopLog, delegatedTurnsOutOfProcess: () => false });
    expect(registry.promptFragments).toContain('at-register:absent');
    const probe = (globalThis as { __controlProbe?: () => KnownControls['lsp'] | undefined }).__controlProbe;
    expect(probe?.()?.diagnosticsEnabled()).toBe(true);
  });
});
