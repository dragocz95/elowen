import type { ChildProcess } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import {
  BoundedProcessGroupTermination,
  PROCESS_GROUP_VERIFY_MS,
  snapshotPosixProcessGroup,
  terminateProcessTree,
} from '../../../src/cli/chat/processTermination.js';

function fakeChild(pid = 42): ChildProcess {
  return {
    pid,
    exitCode: null,
    signalCode: null,
    kill: vi.fn(() => true),
  } as unknown as ChildProcess;
}

describe('terminateProcessTree platform adapters', () => {
  it('uses a bounded shell-free Windows tree kill and forces the complete tree', () => {
    const child = fakeChild(4321);
    const run = vi.fn(() => ({ status: 0, error: undefined }));

    expect(terminateProcessTree(child, 'SIGKILL', { platform: 'win32', run })).toBe(true);

    expect(run).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledWith(
      'taskkill.exe',
      ['/PID', '4321', '/T', '/F'],
      expect.objectContaining({ shell: false, timeout: expect.any(Number), windowsHide: true }),
    );
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('requests the Windows tree without /F during TERM grace and falls back to the child handle on failure', () => {
    const child = fakeChild(987);
    const run = vi.fn(() => ({ status: 1, error: new Error('taskkill unavailable') }));

    expect(terminateProcessTree(child, 'SIGTERM', { platform: 'win32', run })).toBe(true);

    expect(run.mock.calls[0]?.[1]).toEqual(['/PID', '987', '/T']);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('parses a bounded shell-free POSIX group snapshot for birth-safe delayed escalation', () => {
    const run = vi.fn(() => ({
      status: 0,
      error: undefined,
      stdout: [
        '  700   700 Sat Jul 12 04:00:01 2026',
        '  701   700 Sat Jul 12 04:00:02 2026',
        '  900   900 Sat Jul 12 04:00:03 2026',
      ].join('\n'),
    }));

    expect(snapshotPosixProcessGroup(700, { platform: 'darwin', run })).toEqual([
      { pid: 700, startTime: 'Sat Jul 12 04:00:01 2026' },
      { pid: 701, startTime: 'Sat Jul 12 04:00:02 2026' },
    ]);
    expect(run).toHaveBeenCalledWith(
      'ps',
      ['-axo', 'pid=,pgid=,lstart='],
      expect.objectContaining({ shell: false, timeout: expect.any(Number) }),
    );
  });
});

describe('BoundedProcessGroupTermination', () => {
  it('bounds an unkillable Linux identity, cancels every timer, and never leaves a referenced poll', async () => {
    vi.useFakeTimers({ now: 1_000 });
    try {
      const child = fakeChild(42);
      const identity = { pid: 42, startTime: 'birth-42' };
      const killed: Array<[number, NodeJS.Signals]> = [];
      const timers: Array<ReturnType<typeof setTimeout>> = [];
      const group = new BoundedProcessGroupTermination(child, 0, { name: 'owner', value: 'value' }, {
        platform: 'linux',
        snapshotProcess: () => ({ identity, pgid: 42 }),
        snapshotGroup: () => [identity],
        isSameProcess: () => true,
        isOwnedProcess: () => true,
        signalProcess: (pid, signal) => { killed.push([pid, signal]); },
        schedule: (callback, delay) => {
          const timer = setTimeout(callback, delay);
          timers.push(timer);
          return timer;
        },
      });

      const settlement = group.terminate('abort');
      expect(killed).toContainEqual([42, 'SIGKILL']);
      expect(timers).toHaveLength(1);
      expect(timers[0]?.hasRef()).toBe(false);

      await vi.advanceTimersByTimeAsync(PROCESS_GROUP_VERIFY_MS + 10);
      await expect(settlement).resolves.toBeUndefined();
      expect(vi.getTimerCount()).toBe(0);
      expect(killed.filter(([, signal]) => signal === 'SIGKILL').length).toBeLessThanOrEqual(
        Math.ceil(PROCESS_GROUP_VERIFY_MS / 5) + 2,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('can synchronously cancel a pending grace transaction without leaving timers', async () => {
    vi.useFakeTimers();
    try {
      const child = fakeChild();
      const group = new BoundedProcessGroupTermination(child, 500, { name: 'owner', value: 'value' }, {
        platform: 'linux',
        snapshotProcess: () => null,
        snapshotGroup: () => [],
        isSameProcess: () => false,
        isOwnedProcess: () => false,
        signalProcess: () => {},
      });
      const settlement = group.terminate('timeout');
      expect(vi.getTimerCount()).toBe(1);

      group.cancel();

      await expect(settlement).resolves.toBeUndefined();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses positive birth-matched PIDs for delayed non-Linux POSIX escalation and includes a late fork', async () => {
    vi.useFakeTimers({ now: 2_000 });
    try {
      const child = fakeChild(50);
      const leader = { pid: 50, startTime: 'leader-birth' };
      const originalChild = { pid: 51, startTime: 'child-birth' };
      const lateChild = { pid: 52, startTime: 'late-birth' };
      let current = [leader, originalChild];
      const signalled: Array<[number, NodeJS.Signals]> = [];
      const group = new BoundedProcessGroupTermination(child, 20, { name: 'owner', value: 'value' }, {
        platform: 'darwin',
        snapshotProcess: (pid) => pid === leader.pid ? { identity: leader, pgid: 50 } : null,
        snapshotGroup: () => current,
        isSameProcess: (identity) => current.some((row) => row.pid === identity.pid && row.startTime === identity.startTime),
        isOwnedProcess: () => false,
        signalProcess: (pid, signal) => { signalled.push([pid, signal]); },
      });

      const settlement = group.terminate('timeout');
      expect(signalled).toEqual([[50, 'SIGTERM'], [51, 'SIGTERM']]);
      current = [leader, originalChild, lateChild];
      await vi.advanceTimersByTimeAsync(20);

      expect(signalled).toContainEqual([50, 'SIGKILL']);
      expect(signalled).toContainEqual([51, 'SIGKILL']);
      expect(signalled).toContainEqual([52, 'SIGKILL']);
      expect(signalled.every(([pid]) => pid > 0)).toBe(true);
      current = [];
      await vi.advanceTimersByTimeAsync(10);
      await expect(settlement).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not signal a recycled non-Linux POSIX group after every known birth identity is gone', async () => {
    vi.useFakeTimers({ now: 3_000 });
    try {
      const child = fakeChild(60);
      const leader = { pid: 60, startTime: 'owned-birth' };
      const recycled = { pid: 60, startTime: 'unrelated-birth' };
      let current = [leader];
      const signalled: Array<[number, NodeJS.Signals]> = [];
      const nativeTree = vi.fn(() => true);
      const group = new BoundedProcessGroupTermination(child, 20, { name: 'owner', value: 'value' }, {
        platform: 'darwin',
        snapshotProcess: () => ({ identity: leader, pgid: 60 }),
        snapshotGroup: () => current,
        isSameProcess: (identity) => current.some((row) => row.pid === identity.pid && row.startTime === identity.startTime),
        isOwnedProcess: () => false,
        signalProcess: (pid, signal) => { signalled.push([pid, signal]); },
        terminateTree: nativeTree,
      });

      const settlement = group.terminate('timeout');
      current = [recycled];
      await vi.advanceTimersByTimeAsync(20 + PROCESS_GROUP_VERIFY_MS + 10);
      await expect(settlement).resolves.toBeUndefined();

      expect(signalled).toEqual([[60, 'SIGTERM']]);
      expect(nativeTree).not.toHaveBeenCalledWith(expect.anything(), 'SIGKILL');
    } finally {
      vi.useRealTimers();
    }
  });
});
