import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PluginRegistry } from '../../src/plugins/registry.js';
import { loadPlugins } from '../../src/plugins/loader.js';
import type { KnownControls, PluginCapabilities, PluginControl } from '../../src/plugins/api.js';
import { ENVIRONMENT_CONTROL_METHODS, SITE_ENVIRONMENT_CONTROL_METHODS } from '../../src/plugins/environmentTypes.js';
import { runWithPolicy, type TurnIdentity } from '../../src/plugins/policyContext.js';
import type { Policy } from '../../src/plugins/policy.js';
import type { WorkspacePathView } from '../../src/plugins/pathView.js';
import { GUEST_WRITE_OP_BYTES } from '../../src/brain/managedArtifacts.js';
import { managedGuestFs, PROJECT } from '../helpers/managedGuest.js';

const noopLog = { info() {}, warn() {}, error() {} };
const fakeLsp = (): KnownControls['lsp'] => ({ diagnosticsEnabled: () => true });
const fakeGitHub = (): KnownControls['github'] => ({ sessionCredential: () => ({ token: 'secret', login: 'octocat' }) });
// The COMPLETE Sandbox contract: the legacy workspace half plus the managed environment and Sites
// runtime halves. Built from the exported method lists so a method added to the contract lands here too
// — a fake frozen at the old six would let "resolves the complete contract" pass for a provider that
// could no longer serve a managed project. Refusal of an INCOMPLETE control has its own test below.
const SANDBOX_WORKSPACE_METHODS = [
  'workspaceRoots', 'resolveWorkspace', 'acquireDelegationLease', 'workspacesFor', 'activeWorkspace', 'prepareExecution',
] as const;
const fakeSandbox = (): KnownControls['sandbox'] => Object.fromEntries(
  [...SANDBOX_WORKSPACE_METHODS, ...ENVIRONMENT_CONTROL_METHODS, ...SITE_ENVIRONMENT_CONTROL_METHODS]
    .map((name) => [name, () => undefined]),
) as unknown as KnownControls['sandbox'];
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

  /** The cron control's navigation method is ADDITIVE. A cronjob plugin that registers only the retention
   *  method must go on resolving as the cron control: the retention janitor asks it before deleting an idle
   *  conversation, and a control that stopped resolving would silently turn that protection off — deleting
   *  conversations a live job still needs. Adding `conversationLinks` to the required list is exactly what
   *  this forbids. */
  it('resolves a cron control that carries only the required retention method', () => {
    const merged = new PluginRegistry();
    ownerMerges(merged, 'cronjob', 'cron', { retainedSessionIds: () => ['brain-1-pinned'] });

    const control = merged.control('cron');

    expect(control?.retainedSessionIds(1)).toEqual(['brain-1-pinned']);
    expect(control?.conversationLinks).toBeUndefined();
  });

  it('still refuses a cron control that carries only the optional navigation method', () => {
    const merged = new PluginRegistry();
    ownerMerges(merged, 'cronjob', 'cron', { conversationLinks: () => [] } as unknown as PluginControl);

    expect(merged.control('cron')).toBeUndefined();
  });

  it('resolves the complete Sandbox contract live', () => {
    const merged = new PluginRegistry();
    // Sites is the one consumer served the raw control, so identity here is the liveness evidence.
    const ctx = contextOver(merged, { reads: ['controls'] }, undefined, 'sites');
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

  it('serves every other consumer a facade whose Site runtime methods refuse', () => {
    const merged = new PluginRegistry();
    ownerMerges(merged, 'sandbox-a', 'sandbox', fakeSandbox());
    const terminal = contextOver(merged, { reads: ['controls'] }, undefined, 'terminal').control('sandbox');
    expect(terminal).toBeDefined();
    // The workspace and managed-project halves stay usable…
    expect(typeof terminal!.prepareExecution).toBe('function');
    expect(typeof terminal!.requestEnvironment).toBe('function');
    // …while the Sites half is replaced rather than merely hidden, so reading the descriptor off the
    // facade cannot recover the real function either.
    for (const method of SITE_ENVIRONMENT_CONTROL_METHODS) {
      expect(() => (terminal as unknown as Record<string, () => unknown>)[method]()).toThrow(/restricted to the Sites plugin/);
    }
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

/** `ctx.readManagedProjectFile` end to end: the REAL registry seam over the REAL guest artifact primitives
 *  in src/brain/managedArtifacts.ts, driven by the guest-contract stand-in every other managed suite uses.
 *  Nothing here stubs the method itself — a test that did would prove only that a mock returns a string. */
describe('ctx.readManagedProjectFile — the guest read the registry performs for a plugin', () => {
  const OWNER: TurnIdentity = { platform: 'web', userId: '1', admin: true, owner: true, elowenUserId: 1, conversation: 'own' };
  /** A shared-channel turn with no linked Elowen account: the provider has no membership to authorize. */
  const UNLINKED: TurnIdentity = { platform: 'discord', userId: '77', admin: true, owner: false, conversation: 'shared' };
  const WORKSPACE_VIEW: WorkspacePathView = {
    kind: 'workspace',
    workspace: { workspaceId: 'w', projectId: 7 },
    root: '/worktrees/main',
    resolve: (p) => p, display: (p) => p, stateKey: (p) => p, sanitize: (p) => p,
  };

  /** A COMPLETE Sandbox control whose projectFiles is the guest-contract stand-in, so the registry's own
   *  completeness check passes and the read reaches a provider that enforces the real bounds. */
  const guestControl = (fs: ReturnType<typeof managedGuestFs>) =>
    ({ ...fakeSandbox(), projectFiles: fs.projectFiles }) as KnownControls['sandbox'];

  interface Scope {
    /** `null` runs an ordinary HOST turn, which selects no managed project at all. */
    projectRef?: { kind: 'managed'; projectId: number } | null;
    identity?: TurnIdentity;
    sessionId?: string;
    pathView?: WorkspacePathView;
  }

  function read(
    merged: PluginRegistry,
    path: string,
    scope: Scope = {},
    caps: PluginCapabilities = { reads: ['controls'] },
    consumer = 'subagent',
    warn?: (message: string) => void,
  ): Promise<string> {
    const ctx = contextOver(merged, caps, warn, consumer);
    return runWithPolicy(
      { allowedProjectIds: new Set([PROJECT.projectId]), allowedPaths: () => ['/workspace'] } as unknown as Policy,
      () => ctx.readManagedProjectFile(path),
      {
        identity: scope.identity ?? OWNER,
        ...(scope.projectRef === null ? {} : { projectRef: scope.projectRef ?? PROJECT }),
        ...(scope.sessionId === undefined ? { sessionId: 'brain-1' } : scope.sessionId ? { sessionId: scope.sessionId } : {}),
        ...(scope.pathView ? { pathView: scope.pathView } : {}),
      },
    );
  }

  const withGuest = (initial: Record<string, string>, options?: Parameters<typeof managedGuestFs>[1]) => {
    const fs = managedGuestFs(initial, options);
    const merged = new PluginRegistry();
    ownerMerges(merged, 'sandbox', 'sandbox', guestControl(fs) as unknown as PluginControl);
    return { fs, merged };
  };

  it('serves the approved reader the file the model wrote into the guest', async () => {
    const { fs, merged } = withGuest({ '/workspace/wf.json': '{"nodes":[{"id":"a","task":"t"}]}' });
    expect(await read(merged, '/workspace/wf.json')).toBe('{"nodes":[{"id":"a","task":"t"}]}');
    // stat, one bounded read, closing stat — the shared primitive, not a raw provider call.
    expect(fs.calls()).toBe(3);
  });

  // The seam hands back guest file CONTENT, so a manifest capability alone must not open it: the caller
  // name comes from the loader, and only a name on the registry's allowlist is admitted.
  it('refuses an unlisted plugin that declares the controls capability', async () => {
    const { fs, merged } = withGuest({ '/workspace/wf.json': 'secret' });
    const warnings: string[] = [];
    await expect(read(merged, '/workspace/wf.json', {}, { reads: ['controls'] }, 'skills', (m) => warnings.push(m)))
      .rejects.toThrow(/may not read managed project files/);
    expect(warnings.join('\n')).toContain('not an approved managed-project file reader');
    // Refused before any provider call: no guest bytes were fetched and then discarded.
    expect(fs.calls()).toBe(0);
  });

  it('refuses the approved reader when it has not declared the controls capability', async () => {
    const { fs, merged } = withGuest({ '/workspace/wf.json': 'secret' });
    await expect(read(merged, '/workspace/wf.json', {}, {}, 'subagent'))
      .rejects.toThrow(/reads:\['controls'\] capability/);
    expect(fs.calls()).toBe(0);
  });

  it('refuses a turn that is not bound to a managed project', async () => {
    const { fs, merged } = withGuest({ '/workspace/wf.json': 'x' });
    await expect(read(merged, '/workspace/wf.json', { projectRef: null }))
      .rejects.toThrow(/require a managed project turn/);
    expect(fs.calls()).toBe(0);
  });

  it('refuses a turn with no linked account, which the provider could not authorize', async () => {
    const { fs, merged } = withGuest({ '/workspace/wf.json': 'x' });
    await expect(read(merged, '/workspace/wf.json', { identity: UNLINKED }))
      .rejects.toThrow(/require a linked account/);
    expect(fs.calls()).toBe(0);
  });

  it('refuses a turn with no conversation', async () => {
    const { fs, merged } = withGuest({ '/workspace/wf.json': 'x' });
    await expect(read(merged, '/workspace/wf.json', { sessionId: '' }))
      .rejects.toThrow(/require a conversation/);
    expect(fs.calls()).toBe(0);
  });

  // A workspace-scoped delegated child is narrower than the project and must not widen back into it.
  it('refuses a turn already narrowed to a legacy exact workspace', async () => {
    const { fs, merged } = withGuest({ '/workspace/wf.json': 'x' });
    await expect(read(merged, '/workspace/wf.json', { pathView: WORKSPACE_VIEW }))
      .rejects.toThrow(/exact workspace cannot widen into a managed project/);
    expect(fs.calls()).toBe(0);
  });

  it('refuses when no Sandbox provider is registered, rather than reading anything host-side', async () => {
    const merged = new PluginRegistry();
    await expect(read(merged, '/workspace/wf.json')).rejects.toThrow(/requires the Sandbox plugin/);
  });

  it('refuses a relative path instead of resolving it against a host directory', async () => {
    const { fs, merged } = withGuest({ '/workspace/wf.json': 'x' });
    await expect(read(merged, 'wf.json')).rejects.toThrow(/absolute guest path is required/);
    expect(fs.calls()).toBe(0);
  });

  it('refuses a file over the bounded read limit in accurate units', async () => {
    const { fs, merged } = withGuest({ '/workspace/wf.json': 'x'.repeat(GUEST_WRITE_OP_BYTES + 1) });
    // One byte over rounds UP, so the file never reads as exactly the limit it is over.
    await expect(read(merged, '/workspace/wf.json')).rejects.toThrow('wf.json is 513 KiB, over the 512 KiB limit.');
    // The stat decided it; no partial content was transported.
    expect(fs.calls()).toBe(1);
  });

  // Membership is the provider's per-operation check against the account the HOST stamped on the turn.
  // The plugin never names an account, so it cannot present another one to satisfy it.
  it('surfaces the provider membership refusal for an account the project does not admit', async () => {
    const { merged } = withGuest({ '/workspace/wf.json': 'x' }, { account: 42 });
    await expect(read(merged, '/workspace/wf.json')).rejects.toThrow(/project_forbidden/);
  });

  it('refuses when the file changes underneath the read instead of returning spliced bytes', async () => {
    const { merged } = withGuest(
      { '/workspace/wf.json': 'x'.repeat(200_000) },
      { growOn: { call: 2, path: '/workspace/wf.json', append: Buffer.from('tail') } },
    );
    await expect(read(merged, '/workspace/wf.json')).rejects.toThrow(/changed while it was being read/);
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
