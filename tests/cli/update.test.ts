import { describe, it, expect } from 'vitest';
import { update, reinstall, reinstallNpmArgs, type ReinstallIO } from '../../src/cli/update.js';

const registry = (version: string) => (async () => new Response(JSON.stringify({ version }), { status: 200 })) as unknown as typeof fetch;

/** A ReinstallIO that records what it would run, with controllable writability. */
function io(over: Partial<ReinstallIO> = {}): ReinstallIO & { ran: { cmd: string; args: string[] }[] } {
  const ran: { cmd: string; args: string[] }[] = [];
  return {
    ran,
    packagesDir: () => '/usr/lib/node_modules',
    prefix: () => '/usr',
    writable: async () => true,
    npmPath: async () => 'npm',
    exec: async (cmd, args) => { ran.push({ cmd, args }); },
    ...over,
  };
}

describe('cli/update.update', () => {
  it('does nothing when already on the latest version', async () => {
    let installed = false;
    const r = await update({} as NodeJS.ProcessEnv, { current: '1.2.0', fetch: registry('1.2.0'), install: async () => { installed = true; }, restart: async () => {} });
    expect(r).toEqual({ updated: false, from: '1.2.0', to: '1.2.0' });
    expect(installed).toBe(false);
  });
  it('installs and restarts when a newer version exists', async () => {
    const order: string[] = [];
    const r = await update({} as NodeJS.ProcessEnv, {
      current: '1.2.0', fetch: registry('1.3.0'),
      install: async () => { order.push('install'); },
      restart: async () => { order.push('restart'); },
      confirmReadyToRestart: () => true,
    });
    expect(r).toEqual({ updated: true, from: '1.2.0', to: '1.3.0' });
    expect(order).toEqual(['install', 'restart']);
  });
  it('installs but DEFERS the restart when a mission goes live during the install', async () => {
    const order: string[] = [];
    const r = await update({} as NodeJS.ProcessEnv, {
      current: '1.2.0', fetch: registry('1.3.0'),
      install: async () => { order.push('install'); },
      restart: async () => { order.push('restart'); },
      confirmReadyToRestart: () => false, // a mission went live after the gate, before the restart
    });
    expect(r).toEqual({ updated: true, from: '1.2.0', to: '1.3.0', restartDeferred: true });
    expect(order).toEqual(['install']); // installed, but the restart was withheld
  });
  it('treats an unreachable registry as a no-op (so the hourly timer stays green)', async () => {
    const down = (async () => new Response('nope', { status: 503 })) as unknown as typeof fetch;
    const r = await update({} as NodeJS.ProcessEnv, { current: '1.2.0', fetch: down, install: async () => { throw new Error('must not install'); }, restart: async () => {} });
    expect(r).toEqual({ updated: false, from: '1.2.0', to: '1.2.0' });
  });
});

describe('cli/update.reinstallNpmArgs', () => {
  it('builds the in-place reinstall args with the prefix', () => {
    expect(reinstallNpmArgs('/usr')).toEqual(['install', '-g', 'orcasynth@latest', '--prefix', '/usr']);
  });
  it('omits --prefix from a source checkout (no global prefix)', () => {
    expect(reinstallNpmArgs(null)).toEqual(['install', '-g', 'orcasynth@latest']);
  });
});

describe('cli/update.reinstall', () => {
  it('installs directly when the packages dir is writable (no sudo)', async () => {
    const d = io({ writable: async () => true });
    await reinstall(d);
    expect(d.ran).toEqual([{ cmd: 'npm', args: ['install', '-g', 'orcasynth@latest', '--prefix', '/usr'] }]);
  });
  it('routes the reinstall through sudo when the packages dir is not writable', async () => {
    const d = io({ writable: async () => false });
    await reinstall(d);
    expect(d.ran).toEqual([{ cmd: 'sudo', args: ['npm', 'install', '-g', 'orcasynth@latest', '--prefix', '/usr'] }]);
  });
  it('installs directly from a source checkout even if a dir read fails (no packages dir → no sudo)', async () => {
    const d = io({ packagesDir: () => null, prefix: () => null, writable: async () => false });
    await reinstall(d);
    expect(d.ran).toEqual([{ cmd: 'npm', args: ['install', '-g', 'orcasynth@latest'] }]);
  });
});
