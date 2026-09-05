import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { SubagentRunnerPool } from '../../src/subagent/pool.js';
import { subagentBuildId, type DaemonToRunner } from '../../src/subagent/protocol.js';
import type { PendingAbort } from '../../src/brain/session/liveRegistry.js';

const core = vi.hoisted(() => ({
  brain: {
    abortChannel: vi.fn(async () => {}),
    attachDelegatedEdgeReporter: vi.fn(),
    startPlatforms: vi.fn(async () => {}),
  },
}));
vi.mock('../../src/daemon/brainCore.js', () => ({
  buildBrainCore: async () => ({ brain: core.brain, pluginProvider: { get: async () => undefined } }),
}));
vi.mock('../../src/shared/logger.js', () => ({
  logger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  setLogScopePrefix: vi.fn(),
}));
vi.mock('../../src/shared/eventLoopLag.js', () => ({ startLoopLagMonitor: () => ({ lag: () => ({ p99: 0 }) }) }));

const origins = ['user_stop', 'parent_teardown', 'tree_abort', 'recovery'] as const;
const tick = async (): Promise<void> => { await new Promise<void>((resolve) => setImmediate(resolve)); };

describe('abort IPC forwarding', () => {
  let receive: (raw: unknown) => void;
  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const on = vi.spyOn(process, 'on').mockImplementation(((event: string, listener: (...args: unknown[]) => void) => {
      if (event === 'message') receive = listener;
      return process;
    }) as typeof process.on);
    await import('../../src/subagent/runner.js');
    on.mockRestore();
    receive({ type: 'boot', buildId: subagentBuildId(), dbPath: '/unused', project: { id: 1, slug: 'test', path: '/unused' } });
    await tick();
  });
  afterAll(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); });

  it.each(origins)('carries %s through pool, host, parser and runner', async (origin) => {
    const frames: DaemonToRunner[] = [];
    const child = new EventEmitter() as ChildProcess;
    Object.assign(child, {
      connected: true,
      send: (message: DaemonToRunner) => {
        frames.push(message);
        if (message.type === 'boot') queueMicrotask(() => child.emit('message', { type: 'ready', buildId: message.buildId }));
        if (message.type === 'turn') queueMicrotask(() => child.emit('message', { type: 'result', turnId: message.turnId, reply: 'done' }));
        if (message.type === 'abort') receive(JSON.parse(JSON.stringify(message)));
        return true;
      },
      kill: () => true,
    });
    const pool = new SubagentRunnerPool({
      dbPath: '/unused', cwd: '/unused', project: { id: 1, slug: 'test', path: '/unused' }, fork: () => child,
      poolMax: () => 1,
      machine: { cpus: () => 4, totalMemBytes: () => 32 * 1024 ** 3, availableMemBytes: () => 16 * 1024 ** 3 },
    });
    try {
      await pool.run({ channelId: 'child', parentSessionId: 'brain-1', ownerUserId: 1, scheduled: false,
        delegatedAccess: { admin: false, projectIds: [], owner: true, permissionBoundary: null } }, 'test');
      const abort: PendingAbort = { origin, reason: 'exact cancellation reason' };
      core.brain.abortChannel.mockClear();
      pool.abort('child', abort);
      expect(frames.at(-1)).toEqual({ type: 'abort', channelId: 'child', abort });
      expect(core.brain.abortChannel).toHaveBeenCalledWith('child', abort);
      pool.abort('child');
      expect(frames.at(-1)).toEqual({ type: 'abort', channelId: 'child' });
      expect(core.brain.abortChannel).toHaveBeenLastCalledWith('child', undefined);
    } finally { pool.reset('test complete'); }
  });
});
