import { describe, it, expect } from 'vitest';
import { PluginRegistry, type PluginHostWiring } from '../../src/plugins/registry.js';
import type { PluginBrainWorker, PluginCapabilities, PluginHostStores } from '../../src/plugins/api.js';
import type { TmuxDriver } from '../../src/tmux/types.js';

const noopLog = { info() {}, warn() {}, error() {} };

const fakeTmux = { spawn: async () => {} } as unknown as TmuxDriver;
const fakeWorker: PluginBrainWorker = { launch: async () => ({ session: 'elowen-x' }), liveSessionNames: () => [], isLive: () => false, abort: async () => {} };
const fakeStores = {
  tasks: { get: () => null },
  projects: { list: () => [] },
  usersRead: { list: () => [{ id: 1, username: 'a', isAdmin: true }], isAdmin: () => true },
  tasksAvailable: () => true,
} as unknown as PluginHostStores;

const wire = (caps?: PluginCapabilities, host?: PluginHostWiring) => {
  const reg = new PluginRegistry();
  return reg.contextFor(
    'demo', {}, noopLog, undefined, undefined, undefined, undefined, caps, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, undefined, host,
  );
};

describe('ctx.host capability gates', () => {
  const fullHost: PluginHostWiring = {
    tmux: fakeTmux,
    brainWorker: () => fakeWorker,
    elowenCli: { cli: 'elowen', cliArgv: ['elowen'], url: 'http://localhost:4400', token: 't', tokenForTask: () => 'tt', tokenForUser: (id) => (id === 1 ? 'user-1-token' : undefined) },
    stores: fakeStores,
    projectFiles: { safe: (root, path) => `${root}/${path}` },
  };

  it('every accessor is deny-by-default behind its own reads grant', () => {
    const denied = wire({}, fullHost);
    expect(() => denied.host.tmux()).toThrow("reads:['tmux']");
    expect(() => denied.host.brainWorker()).toThrow("reads:['brain-worker']");
    expect(() => denied.host.elowenCli()).toThrow("reads:['elowen-cli']");
    expect(() => denied.host.stores()).toThrow("reads:['stores']");
    expect(() => denied.host.projectFiles()).toThrow("reads:['project-files']");
    // one grant does not open the others
    const tmuxOnly = wire({ reads: ['tmux'] }, fullHost);
    expect(tmuxOnly.host.tmux()).toBe(fakeTmux);
    expect(() => tmuxOnly.host.stores()).toThrow("reads:['stores']");
  });

  it('a granted accessor hands back exactly what the host wired', () => {
    const ctx = wire({ reads: ['tmux', 'brain-worker', 'elowen-cli', 'stores', 'project-files'] }, fullHost);
    expect(ctx.host.tmux()).toBe(fakeTmux);
    expect(ctx.host.brainWorker()).toBe(fakeWorker);
    expect(ctx.host.elowenCli().tokenForTask('t1')).toBe('tt');
    expect(ctx.host.stores()).toBe(fakeStores);
    expect(ctx.host.projectFiles().safe('/project', 'file.ts')).toBe('/project/file.ts');
  });

  it('mints a token for ONE REAL USER, and nothing for an unknown id', () => {
    // A plugin that took over a user-owned core surface must act as that user, not as the shared agent
    // token: the two carry different tenancy, so falling back to the shared one would silently change
    // whose data the call reaches.
    const cli = wire({ reads: ['elowen-cli'] }, fullHost).host.elowenCli();
    expect(cli.tokenForUser(1)).toBe('user-1-token');
    expect(cli.tokenForUser(999)).toBeUndefined();
    expect(cli.tokenForUser(1)).not.toBe(cli.token);
  });

  it('reads the task domain LIVE, so a reload that swaps its owner is visible to a held seam', () => {
    // The domain's owner is a plugin now: a consumer that captured `stores()` once (agents does exactly
    // that) must still be talking to the CURRENT owner after a reload, and must be able to ask whether
    // the domain is reachable at all instead of reading an empty board as fact.
    let owner: { get: () => string } | undefined;
    const liveStores = {
      get tasks() {
        if (!owner) throw new Error('the tasks domain is unavailable — no loaded plugin owns it');
        return owner;
      },
      tasksAvailable: () => owner !== undefined,
    } as unknown as PluginHostStores;
    const stores = wire({ reads: ['stores'] }, { stores: liveStores }).host.stores();
    expect(stores.tasksAvailable()).toBe(false);
    expect(() => stores.tasks.get('t1')).toThrow('tasks domain is unavailable');
    owner = { get: () => 'from-owner' };
    expect(stores.tasksAvailable()).toBe(true);
    expect(stores.tasks.get('t1')).toBe('from-owner');
  });

  it('an unwired process refuses with a clear error even WITH the grant', () => {
    const ctx = wire({ reads: ['tmux', 'brain-worker', 'elowen-cli', 'stores'] }, undefined);
    expect(() => ctx.host.tmux()).toThrow('no tmux driver wired');
    expect(() => ctx.host.brainWorker()).toThrow('not available in this process');
    expect(() => ctx.host.elowenCli()).toThrow('no elowen CLI wiring');
    expect(() => ctx.host.stores()).toThrow('no store seams wired');
  });

  it('brainWorker resolves LIVE — late bootstrap wiring is visible to an already-built context', () => {
    let worker: PluginBrainWorker | undefined;
    const ctx = wire({ reads: ['brain-worker'] }, { brainWorker: () => worker });
    expect(() => ctx.host.brainWorker()).toThrow('not available in this process');
    worker = fakeWorker; // bootstrap's setPluginHostBrainWorker moment
    expect(ctx.host.brainWorker()).toBe(fakeWorker);
  });

  it('extraction seams (prompts/config/relayClient/git) carry their own grants', () => {
    const seams: PluginHostWiring = {
      prompts: { render: (n) => `P:${n}`, rawTemplate: (n) => `T:${n}` },
      config: { get: () => ({ autopilot: {} }) as never, autopilotRelay: () => ({ baseUrl: 'b', apiKey: 'k' }), ghToken: () => null },
      relayClient: (cfg) => ({ model: cfg.model, decide: async () => ({ text: 'ok' }) }),
      git: { projectHead: async () => 'sha', projectRangeDiff: async () => [] },
    };
    const denied = wire({ reads: [] }, seams);
    expect(() => denied.host.prompts()).toThrow("reads:['prompts']");
    expect(() => denied.host.config()).toThrow("reads:['config']");
    expect(() => denied.host.relayClient({ baseUrl: 'b', apiKey: 'k', model: 'm' })).toThrow("reads:['inference']");
    expect(() => denied.host.git()).toThrow("reads:['git']");
    const granted = wire({ reads: ['prompts', 'config', 'inference', 'git'] }, seams);
    expect(granted.host.prompts().render('x')).toBe('P:x');
    expect(granted.host.config().autopilotRelay()).toEqual({ baseUrl: 'b', apiKey: 'k' });
    expect(granted.host.relayClient({ baseUrl: 'b', apiKey: 'k', model: 'm' }).model).toBe('m');
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
