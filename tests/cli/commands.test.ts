import { describe, it, expect } from 'vitest';
import { runLifecycle, formatStatus } from '../../src/cli/commands.js';
import type { SvcStatus } from '../../src/cli/launcher.js';

const svc = (over: Partial<SvcStatus> = {}): SvcStatus => ({ running: false, pid: null, port: 0, healthy: false, ...over });

function fakeDeps() {
  const calls: string[] = [];
  return {
    calls,
    deps: {
      version: '1.1.1',
      log: (s: string) => calls.push(`log:${s.split('\n')[0]}`),
      start: async () => { calls.push('start'); return { daemon: { pid: 1, port: 4400 }, web: { pid: 2, port: 4500 }, version: '1.1.1', startedAt: 't' }; },
      stop: async () => { calls.push('stop'); },
      status: async () => { calls.push('status'); return { daemon: svc(), web: svc() }; },
      update: async () => { calls.push('update'); return { updated: false, from: '1.1.1', to: '1.1.1' }; },
      restart: async (target: string) => { calls.push(`restart:${target}`); },
    },
  };
}

describe('cli/commands.runLifecycle', () => {
  it('handles up by starting the services', async () => {
    const { calls, deps } = fakeDeps();
    expect(await runLifecycle('up', {} as NodeJS.ProcessEnv, deps)).toBe(true);
    expect(calls).toContain('start');
  });
  it('handles down by stopping', async () => {
    const { calls, deps } = fakeDeps();
    expect(await runLifecycle('down', {} as NodeJS.ProcessEnv, deps)).toBe(true);
    expect(calls).toContain('stop');
  });
  it('handles status', async () => {
    const { calls, deps } = fakeDeps();
    expect(await runLifecycle('status', {} as NodeJS.ProcessEnv, deps)).toBe(true);
    expect(calls).toContain('status');
  });
  it('handles update', async () => {
    const { calls, deps } = fakeDeps();
    expect(await runLifecycle('update', {} as NodeJS.ProcessEnv, deps)).toBe(true);
    expect(calls).toContain('update');
  });
  it.each(['daemon', 'web', 'all'] as const)('queues a safe restart of the explicit %s target', async (target) => {
    const { calls, deps } = fakeDeps();
    expect(await runLifecycle('restart', {} as NodeJS.ProcessEnv, deps, [target])).toBe(true);
    expect(calls).toContain(`restart:${target}`);
    expect(calls).toContain(`log:Restart queued: ${target}`);
  });
  it('`--drain` drops the one-shot drain marker for the daemon before queueing the restart', async () => {
    const { calls, deps } = fakeDeps();
    const drains: string[] = [];
    deps.requestDrain = () => { drains.push('marker'); calls.push('drain-marker'); };
    expect(await runLifecycle('restart', {} as NodeJS.ProcessEnv, deps, ['daemon', '--drain'])).toBe(true);
    expect(drains).toEqual(['marker']);
    // The marker must be on disk BEFORE systemd sends SIGTERM, or the daemon reads a pause.
    expect(calls.indexOf('drain-marker')).toBeLessThan(calls.indexOf('restart:daemon'));
    expect(calls).toContain('log:Restart queued: daemon (draining running work first)');
  });
  it('`--drain` means nothing for the web service and drops no marker', async () => {
    const { calls, deps } = fakeDeps();
    deps.requestDrain = () => { calls.push('drain-marker'); };
    expect(await runLifecycle('restart', {} as NodeJS.ProcessEnv, deps, ['--drain', 'web'])).toBe(true);
    expect(calls).not.toContain('drain-marker');
    expect(calls).toContain('restart:web');
  });
  it.each([[], ['everything']])('refuses a missing or invalid restart target: %j', async (argv) => {
    const { calls, deps } = fakeDeps();
    await expect(runLifecycle('restart', {} as NodeJS.ProcessEnv, deps, argv)).rejects.toThrow(
      'usage: elowen restart <daemon|web|all>',
    );
    expect(calls.some((call) => call.startsWith('restart:'))).toBe(false);
  });
  it('returns false for a non-lifecycle command (falls through to the API CLI)', async () => {
    const { deps } = fakeDeps();
    expect(await runLifecycle('ls', {} as NodeJS.ProcessEnv, deps)).toBe(false);
  });
});

describe('cli/commands.formatStatus', () => {
  it('shows running + healthy services with their ports', () => {
    const out = formatStatus({ daemon: svc({ running: true, pid: 9, port: 4400, healthy: true }), web: svc({ running: true, pid: 10, port: 4500, healthy: true }) });
    expect(out).toMatch(/daemon/);
    expect(out).toMatch(/4400/);
    expect(out).toMatch(/web/);
    expect(out).toMatch(/4500/);
  });
  it('marks a stopped service', () => {
    const out = formatStatus({ daemon: svc(), web: svc() });
    expect(out.toLowerCase()).toMatch(/stopped|not running/);
  });
});
