import { describe, it, expect } from 'vitest';
import { PluginRegistry, type PluginHostWiring } from '../../src/plugins/registry.js';
import { runWithPolicy } from '../../src/plugins/policyContext.js';
import type { PluginCapabilities, PluginHostStores } from '../../src/plugins/api.js';
import type { TmuxDriver } from '../../src/tmux/types.js';

const noopLog = { info() {}, warn() {}, error() {} };

const fakeTmux = { spawn: async () => {} } as unknown as TmuxDriver;
const fakeStores = {
  projects: { get: () => null, list: () => [] },
  homeProject: () => ({ id: 1, slug: 'elowen', path: '/o', notes: '', icon: '' }),
  usersRead: {
    list: () => [{ id: 1, username: 'a', isAdmin: true }],
    isAdmin: () => true, allowedExecs: () => null, mayUsePlugin: () => true,
  },
} satisfies PluginHostStores;

const wire = (caps?: PluginCapabilities, host?: PluginHostWiring) => {
  const reg = new PluginRegistry();
  return reg.contextFor(
    'demo', {}, noopLog, undefined, undefined, undefined, undefined, caps, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, undefined, host,
  );
};

describe('ctx.userConfig()', () => {
  const reads = (calls: [number, string][]): PluginHostWiring => ({
    userPluginConfig: (userId, plugin) => { calls.push([userId, plugin]); return { apiKey: 'k' }; },
  });

  it('returns null outside any identity instead of falling back to somebody\'s values', () => {
    const calls: [number, string][] = [];
    // A system turn has no account behind it. Handing back an empty object would be indistinguishable from
    // "this person configured nothing", and a fallback to the instance config would act as the operator.
    expect(wire(undefined, reads(calls)).userConfig()).toBeNull();
    expect(calls).toEqual([]);
  });

  it('returns null when the host wired no store, rather than inventing an empty config', () => {
    expect(wire(undefined, {}).userConfig()).toBeNull();
  });

  // Including 'shared' ON PURPOSE: a credential belongs to the VERIFIED SENDER of the turn, so asking in a
  // team channel reaches that person's own integration. What must not cross into a room is authority,
  // which `platforms.ts` withholds — not the asker's own account.
  it.each(['own', 'direct', 'shared'] as const)('reads the acting account in a %s conversation', (conversation) => {
    const calls: [number, string][] = [];
    const ctx = wire(undefined, reads(calls));
    const seen = runWithPolicy(null, () => ctx.userConfig(), {
      identity: { platform: 'http', userId: '7', elowenUserId: 7, admin: false, owner: false, conversation },
    });
    expect(seen).toEqual({ apiKey: 'k' });
    // The plugin never names the user OR itself — a plugin that could would read another's credentials.
    expect(calls).toEqual([[7, 'demo']]);
  });

  it('uses the inherited contribution account for a delegated child', () => {
    const calls: [number, string][] = [];
    const ctx = wire(undefined, reads(calls));
    const seen = runWithPolicy(null, () => ctx.userConfig(), {
      identity: { platform: 'subagent', userId: 'subagent', admin: true, owner: true, conversation: 'delegated' },
      contributionUserId: 7,
    });
    expect(seen).toEqual({ apiKey: 'k' });
    expect(calls).toEqual([[7, 'demo']]);
  });

  it('returns null for accountless delegated or instance work', () => {
    const calls: [number, string][] = [];
    const ctx = wire(undefined, reads(calls));
    const seen = runWithPolicy(null, () => ctx.userConfig(), {
      identity: { platform: 'subagent', userId: 'subagent', admin: true, owner: true, conversation: 'delegated' },
    });
    expect(seen).toBeNull();
    expect(calls).toEqual([]);
  });
});

describe('ctx secret and deployment scopes', () => {
  const bag = (label: string) => ({
    get: (key: string) => ({ value: `${label}:${key}`, version: 1 }),
    has: () => true,
    set: (_key: string, _value: string) => 1,
    delete: () => true,
  });

  it('binds instance secrets to the calling plugin and user secrets to the contribution account', () => {
    const calls: string[] = [];
    const ctx = wire(undefined, {
      pluginSecrets: {
        instance: (plugin) => { calls.push(`instance:${plugin}`); return bag('instance'); },
        user: (userId, plugin) => { calls.push(`user:${userId}:${plugin}`); return bag(`user-${userId}`); },
      },
    });
    expect(ctx.instanceSecrets().get('client')?.value).toBe('instance:client');
    const value = runWithPolicy(null, () => ctx.userSecrets()?.get('oauth')?.value, {
      identity: { platform: 'subagent', userId: 'subagent', admin: false, owner: false, conversation: 'delegated' },
      contributionUserId: 9,
    });
    expect(value).toBe('user-9:oauth');
    expect(calls).toEqual(['instance:demo', 'user:9:demo']);
  });

  it('falls back to authenticated API identity and returns null without an account', () => {
    const ctx = wire(undefined, { pluginSecrets: { instance: () => bag('i'), user: (id) => bag(`u${id}`) } });
    const api = runWithPolicy(null, () => ctx.userSecrets()?.get('x')?.value, {
      identity: { platform: 'http', userId: '4', elowenUserId: 4, admin: false, owner: false, conversation: 'own' },
    });
    expect(api).toBe('u4:x');
    expect(ctx.userSecrets()).toBeNull();
  });

  it('returns only the trusted host deployment URL', () => {
    expect(wire(undefined, { publicWebUrl: () => 'https://elowen.example' }).publicWebUrl()).toBe('https://elowen.example');
    expect(wire(undefined, {}).publicWebUrl()).toBeNull();
  });
});

describe('ctx.host capability gates', () => {
  const externalUsers = {
    resolve: () => ({ id: 2, username: 'external', isAdmin: false }),
    describe: () => ({
      provider: 'msteams', tenantId: 'tenant-1', subjectId: 'subject-1',
      user: { id: 2, username: 'external', isAdmin: false }, linkedAt: '2026-08-19 05:00:00',
    }),
    linkOrProvision: async () => ({ user: { id: 2, username: 'external', isAdmin: false }, created: true }),
    linkExisting: () => ({
      provider: 'msteams', tenantId: 'tenant-1', subjectId: 'subject-1',
      user: { id: 2, username: 'external', isAdmin: false }, linkedAt: '2026-08-19 05:00:00',
    }),
  };
  const fullHost: PluginHostWiring = {
    tmux: fakeTmux,
    elowenCli: { cli: 'elowen', cliArgv: ['elowen'], url: 'http://localhost:4400', tokenForUser: (id) => (id === 1 ? 'user-1-token' : undefined) },
    stores: fakeStores,
    externalUsers,
    projectFiles: { safe: (root, path) => `${root}/${path}` },
  };

  it('every accessor is deny-by-default behind its own reads grant', () => {
    const denied = wire({}, fullHost);
    expect(() => denied.host.tmux()).toThrow("reads:['tmux']");
    expect(() => denied.host.elowenCli()).toThrow("reads:['elowen-cli']");
    expect(() => denied.host.stores()).toThrow("reads:['stores']");
    expect(() => denied.host.externalUsers()).toThrow("mutates:['users']");
    expect(() => denied.host.projectFiles()).toThrow("reads:['project-files']");
    // one grant does not open the others
    const tmuxOnly = wire({ reads: ['tmux'] }, fullHost);
    expect(tmuxOnly.host.tmux()).toBe(fakeTmux);
    expect(() => tmuxOnly.host.stores()).toThrow("reads:['stores']");
  });

  it('a granted accessor hands back exactly what the host wired', () => {
    const ctx = wire({ reads: ['tmux', 'elowen-cli', 'stores', 'project-files'] }, fullHost);
    expect(ctx.host.tmux()).toBe(fakeTmux);
    expect(ctx.host.elowenCli().tokenForUser(1)).toBe('user-1-token');
    expect(ctx.host.stores()).toBe(fakeStores);
    expect(wire({ mutates: ['users'] }, fullHost).host.externalUsers()).toBe(externalUsers);
    expect(ctx.host.projectFiles().safe('/project', 'file.ts')).toBe('/project/file.ts');
  });

  it('mints a token for ONE REAL USER, and nothing for an unknown id', () => {
    // A plugin that took over a user-owned core surface must act as that user, not as the shared agent
    // token: the two carry different tenancy, so falling back to the shared one would silently change
    // whose data the call reaches.
    const cli = wire({ reads: ['elowen-cli'] }, fullHost).host.elowenCli();
    expect(cli.tokenForUser(1)).toBe('user-1-token');
    expect(cli.tokenForUser(999)).toBeUndefined();
  });

  it('an unwired process refuses with a clear error even WITH the grant', () => {
    const ctx = wire({ reads: ['tmux', 'elowen-cli', 'stores'] }, undefined);
    expect(() => ctx.host.tmux()).toThrow('no tmux driver wired');
    expect(() => ctx.host.elowenCli()).toThrow('no elowen CLI wiring');
    expect(() => ctx.host.stores()).toThrow('no store seams wired');
    expect(() => wire({ mutates: ['users'] }, undefined).host.externalUsers()).toThrow('no external user account seam wired');
  });

  it('extraction seams (prompts/relayClient/git) carry their own grants', async () => {
    const defaultInference = { model: 'workspace/small', decide: async () => ({ text: 'ok' }) };
    const publicHttp = {
      validate: async (url: string) => url,
      request: async () => ({ url: 'https://example.com/', status: 200, statusText: 'OK', headers: {}, body: [], cancel() {} }),
    };
    const seams: PluginHostWiring = {
      prompts: { render: (n) => `P:${n}`, rawTemplate: (n) => `T:${n}`, userOverride: (id, n) => (id === 1 ? `O:${n}` : null) },
      relayClient: (cfg) => ({ model: cfg.model, decide: async () => ({ text: 'ok' }) }),
      defaultInference: () => defaultInference,
      publicHttp,
      git: {
        projectSnapshot: async () => ({ isRepo: true, status: null, remotes: [] }),
        projectHead: async () => 'sha', projectRangeDiff: async () => [],
        projectRangeLog: async () => [], projectRangeFileDiff: async () => 'range-diff', projectCommitFileDiff: async () => 'commit-diff',
      },
    };
    const denied = wire({ reads: [] }, seams);
    expect(() => denied.host.prompts()).toThrow("reads:['prompts']");
    expect(() => denied.host.relayClient({ baseUrl: 'b', apiKey: 'k', model: 'm' })).toThrow("reads:['inference']");
    expect(() => denied.host.defaultInference()).toThrow("reads:['inference']");
    expect(() => denied.host.publicHttp()).toThrow('network capability');
    expect(() => denied.host.git()).toThrow("reads:['git']");
    const granted = wire({ reads: ['prompts', 'inference', 'git'], network: true }, seams);
    expect(granted.host.prompts().render('x')).toBe('P:x');
    expect(granted.host.relayClient({ baseUrl: 'b', apiKey: 'k', model: 'm' }).model).toBe('m');
    expect(granted.host.defaultInference()).toBe(defaultInference);
    expect(granted.host.publicHttp()).toBe(publicHttp);
    // A saved override is a DIFFERENT question from "render this template": a caller with its own
    // fallback chain (the planner prompt falls back to the workspace template, not to the file default)
    // must be able to see that a user never edited it.
    expect(granted.host.prompts().userOverride(1, 'planner')).toBe('O:planner');
    expect(granted.host.prompts().userOverride(2, 'planner')).toBeNull();
    // The git reader carries the whole read-only set an extracted change-list surface needs, not just
    // the two the first extraction happened to use.
    expect(await granted.host.git().projectRangeFileDiff('/r', 'a', 'b', 'f.ts')).toBe('range-diff');
    expect(await granted.host.git().projectCommitFileDiff('/r', 'abc', 'f.ts')).toBe('commit-diff');
  });
});

describe('ctx.subscribeEvents', () => {
  const busFor = (subs: Set<(e: unknown) => void>) => (fn: (e: unknown) => void) => { subs.add(fn); return () => subs.delete(fn); };

  it('is gated by mutates:[events], subscribes, and manual unsubscribe detaches', () => {
    const subs = new Set<(e: unknown) => void>();
    const reg = new PluginRegistry();
    const wireSub = (caps?: PluginCapabilities) => reg.contextFor(
      'demo', {}, noopLog, undefined, undefined, undefined, undefined, caps, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      busFor(subs) as never,
    );
    expect(() => wireSub().subscribeEvents(() => {})).toThrow("mutates:['events']");
    const off = wireSub({ mutates: ['events'] }).subscribeEvents(() => {});
    expect(subs.size).toBe(1);
    expect(reg.busSubscriptions).toHaveLength(1);
    off();
    expect(subs.size).toBe(0);
    expect(reg.busSubscriptions).toHaveLength(0);
  });

  it('disposeEventSubscriptions detaches the whole generation (the reload path)', () => {
    const subs = new Set<(e: unknown) => void>();
    const reg = new PluginRegistry();
    const ctx = reg.contextFor(
      'demo', {}, noopLog, undefined, undefined, undefined, undefined, { mutates: ['events'] }, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      busFor(subs) as never,
    );
    ctx.subscribeEvents(() => {});
    ctx.subscribeEvents(() => {});
    // merge carries subscription ownership from the staging registry to the merged one
    const merged = new PluginRegistry();
    merged.merge(reg);
    expect(merged.busSubscriptions).toHaveLength(2);
    merged.disposeEventSubscriptions();
    expect(subs.size).toBe(0);
    merged.disposeEventSubscriptions(); // idempotent
  });
});
