import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { update, reinstall, reinstallNpmArgs, acquireUpdateLock, type ReinstallIO, type UpdateLockDeps } from '../../src/cli/update.js';
import * as updateModule from '../../src/cli/update.js';

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

// Every update() call takes the cross-process lock; the real default would write into the real
// ~/.config/elowen, so each test gets a fresh temp lock file instead.
let lock: UpdateLockDeps;
let lockDir: string;
beforeEach(() => {
  lockDir = mkdtempSync(join(tmpdir(), 'elowen-update-lock-'));
  lock = { lockPath: () => join(lockDir, 'update.lock'), isAlive: (pid) => pid === process.pid };
});
afterEach(() => rmSync(lockDir, { recursive: true, force: true }));

describe('cli/update.update', () => {
  it('does nothing when already on the latest version', async () => {
    let installed = false;
    const r = await update({} as NodeJS.ProcessEnv, { current: '1.2.0', fetch: registry('1.2.0'), install: async () => { installed = true; }, restart: async () => {}, lock });
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
      lock,
    });
    expect(r).toEqual({ updated: true, from: '1.2.0', to: '1.3.0' });
    expect(order).toEqual(['install', 'restart']);
  });
  it('treats an unreachable registry as a no-op (so the hourly timer stays green)', async () => {
    const down = (async () => new Response('nope', { status: 503 })) as unknown as typeof fetch;
    const r = await update({} as NodeJS.ProcessEnv, { current: '1.2.0', fetch: down, install: async () => { throw new Error('must not install'); }, restart: async () => {}, lock });
    expect(r).toEqual({ updated: false, from: '1.2.0', to: '1.2.0' });
  });
});

describe('cli/update safe systemd restart', () => {
  it('makes one non-blocking attempt and never retries with a legacy command after failure', async () => {
    type Restart = (target: 'all') => Promise<{ code: number; stdout: string }>;
    type RestartAfterUpdate = (latest: string, restart?: Restart) => Promise<void>;
    const restartAfterUpdate = (updateModule as unknown as { restartSystemdAfterUpdate?: RestartAfterUpdate }).restartSystemdAfterUpdate;
    expect(typeof restartAfterUpdate).toBe('function');
    if (!restartAfterUpdate) return;
    const calls: string[] = [];

    await expect(restartAfterUpdate('1.3.0', async (target) => {
      calls.push(target);
      return { code: 1, stdout: '' };
    })).rejects.toThrow('safe restart failed');

    expect(calls).toEqual(['all']);
  });
});

describe('cli/update.update lock (cross-process serialisation)', () => {
  it('refuses a concurrent run while another update holds the lock — before any work', async () => {
    const release = acquireUpdateLock({} as NodeJS.ProcessEnv, lock);
    try {
      let installed = false;
      await expect(update({} as NodeJS.ProcessEnv, {
        current: '1.2.0', fetch: registry('1.3.0'),
        install: async () => { installed = true; },
        restart: async () => {},
        lock,
      })).rejects.toThrow('another `elowen update` is already in progress');
      expect(installed).toBe(false); // refused at the lock, so the install never ran
    } finally {
      release();
    }
  });
  it('reclaims a stale lock left by a dead holder (a crash between acquire and release)', async () => {
    writeFileSync(lock.lockPath({} as NodeJS.ProcessEnv), String(2147483646), 'utf8'); // surely-dead pid
    const r = await update({} as NodeJS.ProcessEnv, { current: '1.2.0', fetch: registry('1.2.0'), lock });
    expect(r).toEqual({ updated: false, from: '1.2.0', to: '1.2.0' });
  });
  it('releases the lock when the update finishes, so the next run can proceed', async () => {
    await update({} as NodeJS.ProcessEnv, { current: '1.2.0', fetch: registry('1.3.0'), install: async () => {}, restart: async () => {}, confirmReadyToRestart: () => true, lock });
    expect(() => acquireUpdateLock({} as NodeJS.ProcessEnv, lock)).not.toThrow();
  });
});

describe('cli/update.acquireUpdateLock', () => {
  it('stamps the lock with the acquiring pid and the release removes it', () => {
    const release = acquireUpdateLock({} as NodeJS.ProcessEnv, lock);
    expect(readFileSync(lock.lockPath({} as NodeJS.ProcessEnv), 'utf8')).toBe(String(process.pid));
    release();
    expect(() => acquireUpdateLock({} as NodeJS.ProcessEnv, lock)).not.toThrow();
  });
});

describe('cli/update.reinstallNpmArgs', () => {
  it('builds the in-place reinstall args with the prefix', () => {
    expect(reinstallNpmArgs('/usr')).toEqual(['install', '-g', 'elowen@latest', '--prefix', '/usr']);
  });
  it('omits --prefix from a source checkout (no global prefix)', () => {
    expect(reinstallNpmArgs(null)).toEqual(['install', '-g', 'elowen@latest']);
  });
});

describe('cli/update.reinstall', () => {
  it('installs directly when the packages dir is writable (no sudo)', async () => {
    const d = io({ writable: async () => true });
    await reinstall(d);
    expect(d.ran).toEqual([{ cmd: 'npm', args: ['install', '-g', 'elowen@latest', '--prefix', '/usr'] }]);
  });
  it('routes the reinstall through sudo when the packages dir is not writable', async () => {
    const d = io({ writable: async () => false });
    await reinstall(d);
    expect(d.ran).toEqual([{ cmd: 'sudo', args: ['npm', 'install', '-g', 'elowen@latest', '--prefix', '/usr'] }]);
  });
  it('installs directly from a source checkout even if a dir read fails (no packages dir → no sudo)', async () => {
    const d = io({ packagesDir: () => null, prefix: () => null, writable: async () => false });
    await reinstall(d);
    expect(d.ran).toEqual([{ cmd: 'npm', args: ['install', '-g', 'elowen@latest'] }]);
  });
});
