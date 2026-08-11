import { describe, it, expect } from 'vitest';
import { PluginRegistry, type PluginHostWiring } from '../../src/plugins/registry.js';
import type { PluginCapabilities, PluginHostStores } from '../../src/plugins/api.js';
import type { TmuxDriver } from '../../src/tmux/types.js';
import type { BrainWorkerLauncher } from '../../src/spawn/spawn.js';

const noopLog = { info() {}, warn() {}, error() {} };

const fakeTmux = { spawn: async () => {} } as unknown as TmuxDriver;
const fakeWorker: BrainWorkerLauncher = { launch: async () => ({ session: 'elowen-x' }) };
const fakeStores = {
  tasks: { get: () => null },
  projects: { list: () => [] },
  usersRead: { list: () => [{ id: 1, username: 'a', isAdmin: true }], isAdmin: () => true },
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
    elowenCli: { cli: 'elowen', cliArgv: ['elowen'], url: 'http://localhost:4400', token: 't', tokenForTask: () => 'tt' },
    stores: fakeStores,
  };

  it('every accessor is deny-by-default behind its own reads grant', () => {
    const denied = wire({}, fullHost);
    expect(() => denied.host.tmux()).toThrow("reads:['tmux']");
    expect(() => denied.host.brainWorker()).toThrow("reads:['brain-worker']");
    expect(() => denied.host.elowenCli()).toThrow("reads:['elowen-cli']");
    expect(() => denied.host.stores()).toThrow("reads:['stores']");
    // one grant does not open the others
    const tmuxOnly = wire({ reads: ['tmux'] }, fullHost);
    expect(tmuxOnly.host.tmux()).toBe(fakeTmux);
    expect(() => tmuxOnly.host.stores()).toThrow("reads:['stores']");
  });

  it('a granted accessor hands back exactly what the host wired', () => {
    const ctx = wire({ reads: ['tmux', 'brain-worker', 'elowen-cli', 'stores'] }, fullHost);
    expect(ctx.host.tmux()).toBe(fakeTmux);
    expect(ctx.host.brainWorker()).toBe(fakeWorker);
    expect(ctx.host.elowenCli().tokenForTask('t1')).toBe('tt');
    expect(ctx.host.stores()).toBe(fakeStores);
  });

  it('an unwired process refuses with a clear error even WITH the grant', () => {
    const ctx = wire({ reads: ['tmux', 'brain-worker', 'elowen-cli', 'stores'] }, undefined);
    expect(() => ctx.host.tmux()).toThrow('no tmux driver wired');
    expect(() => ctx.host.brainWorker()).toThrow('not available in this process');
    expect(() => ctx.host.elowenCli()).toThrow('no elowen CLI wiring');
    expect(() => ctx.host.stores()).toThrow('no store seams wired');
  });

  it('brainWorker resolves LIVE — late bootstrap wiring is visible to an already-built context', () => {
    let worker: BrainWorkerLauncher | undefined;
    const ctx = wire({ reads: ['brain-worker'] }, { brainWorker: () => worker });
    expect(() => ctx.host.brainWorker()).toThrow('not available in this process');
    worker = fakeWorker; // bootstrap's setPluginHostBrainWorker moment
    expect(ctx.host.brainWorker()).toBe(fakeWorker);
  });
});
