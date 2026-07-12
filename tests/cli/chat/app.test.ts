import { describe, it, expect, vi } from 'vitest';
import { loadInitialTranscript } from '../../../src/cli/chat/initialTranscriptHydration.js';
import { ChatApplication } from '../../../src/cli/chat/chatApplication.js';
import { installExitGuards, createShutdownCoordinator } from '../../../src/cli/chat/terminalLifecycle.js';
import { SnapshotHydrator } from '../../../src/cli/chat/snapshotHydrator.js';
import type { BrainClient } from '../../../src/cli/chat/brainClient.js';

describe('initial transcript hydration', () => {
  it('settles after 10 seconds when boot history ignores abort and fences a late response', async () => {
    vi.useFakeTimers();
    try {
      let resolveHistory!: (history: { role: string; text: string }[]) => void;
      const history = new Promise<{ role: string; text: string }[]>((resolve) => { resolveHistory = resolve; });
      const client = { history: (_session?: string, signal?: AbortSignal) => {
        signal?.addEventListener('abort', () => { /* ignored by transport */ });
        return history;
      } } as unknown as BrainClient;
      const hydrator = new SnapshotHydrator<never>();
      const lifecycle = new AbortController();
      const loading = loadInitialTranscript(client, hydrator, lifecycle.signal);

      await vi.advanceTimersByTimeAsync(10_000);
      await expect(loading).resolves.toEqual({ history: [], notice: expect.stringMatching(/timed out/i) });
      resolveHistory([{ role: 'assistant', text: 'too late' }]);
      await Promise.resolve();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('installExitGuards — process listener lifecycle', () => {
  it('registers exit/SIGTERM/SIGHUP guards and the disposer removes exactly those', () => {
    const before = {
      exit: process.listenerCount('exit'),
      term: process.listenerCount('SIGTERM'),
      hup: process.listenerCount('SIGHUP'),
      fatal: process.listenerCount('uncaughtExceptionMonitor'),
    };
    const dispose = installExitGuards({ shutdown: async () => {}, exit: () => {} });
    expect(process.listenerCount('exit')).toBe(before.exit + 1);
    expect(process.listenerCount('SIGTERM')).toBe(before.term + 1);
    expect(process.listenerCount('SIGHUP')).toBe(before.hup + 1);
    expect(process.listenerCount('uncaughtExceptionMonitor')).toBe(before.fatal + 1);
    // Menu return: quit() calls the disposer, which must drop the count back so a relaunch doesn't stack.
    dispose();
    expect(process.listenerCount('exit')).toBe(before.exit);
    expect(process.listenerCount('SIGTERM')).toBe(before.term);
    expect(process.listenerCount('SIGHUP')).toBe(before.hup);
    expect(process.listenerCount('uncaughtExceptionMonitor')).toBe(before.fatal);
  });

  it('a signal waits for bounded shutdown before exiting', async () => {
    const calls: string[] = [];
    let finishShutdown!: () => void;
    const shutdown = vi.fn(() => {
      calls.push('shutdown');
      return new Promise<void>((resolve) => { finishShutdown = resolve; });
    });
    const dispose = installExitGuards({ shutdown, exit: (code) => { calls.push(`exit:${code}`); } });
    // Call our just-added SIGTERM handler directly (not process.emit) so no other listeners fire.
    const sigterm = process.listeners('SIGTERM').at(-1) as () => void;
    sigterm();
    expect(calls).toEqual(['shutdown']);
    finishShutdown();
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toEqual(['shutdown', 'exit:143']);
    dispose();
  });

  it('uncaught monitoring synchronously tears down locally and starts only a best-effort daemon stop', async () => {
    const calls: string[] = [];
    let finishStop!: () => void;
    const shutdown = createShutdownCoordinator({
      teardown: () => { calls.push('teardown'); },
      stopBoundSession: () => new Promise<void>((resolve) => { calls.push('stop'); finishStop = resolve; }),
      timeoutMs: 5_000,
    });
    const dispose = installExitGuards({ shutdown, exit: () => {} });
    const fatal = process.listeners('uncaughtExceptionMonitor').at(-1) as (error: Error) => void;
    fatal(new Error('render overflow'));
    expect(calls).toEqual(['teardown']);
    await Promise.resolve();
    expect(calls).toEqual(['teardown', 'stop']);
    finishStop();
    await shutdown();
    dispose();
  });

  it('process exit guarantees synchronous local teardown while daemon stop remains best-effort', async () => {
    const calls: string[] = [];
    let finishStop!: () => void;
    const shutdown = createShutdownCoordinator({
      teardown: () => { calls.push('teardown'); },
      stopBoundSession: () => new Promise<void>((resolve) => { calls.push('stop'); finishStop = resolve; }),
      timeoutMs: 5_000,
    });
    const dispose = installExitGuards({ shutdown, exit: () => {} });
    const exiting = process.listeners('exit').at(-1) as () => void;
    exiting();
    expect(calls).toEqual(['teardown']);
    await Promise.resolve();
    expect(calls).toEqual(['teardown', 'stop']);
    finishStop();
    await shutdown();
    dispose();
  });
});

describe('createShutdownCoordinator', () => {
  it('restores the terminal synchronously, stops the bound session once, and waits before completing', async () => {
    let resolveStop!: () => void;
    const stopBoundSession = vi.fn(() => new Promise<void>((resolve) => { resolveStop = resolve; }));
    const teardown = vi.fn();
    const shutdown = createShutdownCoordinator({ teardown, stopBoundSession, timeoutMs: 5_000 });

    const first = shutdown();
    // Raw mode / alternate-screen cleanup cannot wait on the daemon request.
    expect(teardown).toHaveBeenCalledTimes(1);
    const second = shutdown();
    expect(second).toBe(first);
    await Promise.resolve();
    expect(stopBoundSession).toHaveBeenCalledTimes(1);

    resolveStop();
    await first;
    expect(teardown).toHaveBeenCalledTimes(1);
  });

  it('completes after the bounded timeout when the daemon never answers', async () => {
    vi.useFakeTimers();
    let stopSignal: AbortSignal | undefined;
    const shutdown = createShutdownCoordinator({
      teardown: vi.fn(),
      stopBoundSession: vi.fn((signal) => {
        stopSignal = signal;
        return new Promise<void>(() => {});
      }),
      timeoutMs: 25,
    });
    const finished = shutdown();
    await Promise.resolve();
    expect(stopSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(25);
    expect(stopSignal?.aborted).toBe(true);
    await expect(finished).resolves.toBeUndefined();
    vi.useRealTimers();
  });

  it('does not finish a signal shutdown before bounded local child cleanup settles', async () => {
    let finishLocal!: () => void;
    const local = new Promise<void>((resolve) => { finishLocal = resolve; });
    const shutdown = createShutdownCoordinator({
      teardown: () => local,
      stopBoundSession: async () => {},
      timeoutMs: 25,
    });

    const finished = shutdown();
    let complete = false;
    void finished.then(() => { complete = true; });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(complete).toBe(false);
    finishLocal();
    await finished;
    expect(complete).toBe(true);
  });
});

describe('ChatApplication shutdown ownership', () => {
  it('bounded-stops the issued client generation when bootstrap fails', async () => {
    const stopSession = vi.fn(async (_signal?: AbortSignal) => {});
    const client = {
      bindLifetime: vi.fn(),
      start: vi.fn(async () => { throw new Error('start failed after claim'); }),
      stopSession,
    } as unknown as BrainClient;
    const application = new ChatApplication({ base: 'http://unused', token: 'unused', client });

    await expect(application.run()).rejects.toThrow('start failed after claim');
    expect(stopSession).toHaveBeenCalledOnce();
    expect(stopSession.mock.calls[0]?.[0]).toBeInstanceOf(AbortSignal);
  });
});

describe('parseCommand', () => {
  it('routes slash commands and passes the resume argument through', async () => {
    const { parseCommand } = await import('../../../src/cli/chat/commands.js');
    expect(parseCommand('/new')).toEqual({ cmd: 'new' });
    expect(parseCommand('/sessions')).toEqual({ cmd: 'sessions' });
    expect(parseCommand('/resume 2')).toEqual({ cmd: 'resume', arg: '2' });
    expect(parseCommand('/rename Release chat')).toEqual({ cmd: 'rename', arg: 'Release chat' });
    expect(parseCommand('/model')).toEqual({ cmd: 'model' });
    expect(parseCommand('/reasoning')).toEqual({ cmd: 'reasoning', arg: undefined });
    expect(parseCommand('/reasoning high')).toEqual({ cmd: 'reasoning', arg: 'high' });
    expect(parseCommand('/fast')).toEqual({ cmd: 'fast', arg: undefined });
    expect(parseCommand('/fast on')).toEqual({ cmd: 'fast', arg: 'on' });
    expect(parseCommand('/theme')).toEqual({ cmd: 'theme', arg: undefined });
    expect(parseCommand('/theme mono')).toEqual({ cmd: 'theme', arg: 'mono' });
    expect(parseCommand('/editor')).toEqual({ cmd: 'editor' });
    expect(parseCommand('/mcp')).toEqual({ cmd: 'mcp' });
    expect(parseCommand('/skills')).toEqual({ cmd: 'skills' });
    expect(parseCommand('/tools')).toEqual({ cmd: 'tools' });
    expect(parseCommand('/goal Fix tests')).toEqual({ cmd: 'goal', arg: 'Fix tests' });
    expect(parseCommand('/subgoal Run typecheck')).toEqual({ cmd: 'subgoal', arg: 'Run typecheck' });
    expect(parseCommand('/compact')).toEqual({ cmd: 'compact' });
    expect(parseCommand('/plan')).toEqual({ cmd: 'plan' });
    expect(parseCommand('/build')).toEqual({ cmd: 'build' });
    expect(parseCommand('/yolo')).toEqual({ cmd: 'yolo', arg: undefined });
    expect(parseCommand('/yolo off')).toEqual({ cmd: 'yolo', arg: 'off' });
    expect(parseCommand('/tdd')).toEqual({ cmd: 'tdd', arg: undefined });
    expect(parseCommand('/tdd on')).toEqual({ cmd: 'tdd', arg: 'on' });
    expect(parseCommand('/quit')).toEqual({ cmd: 'quit' });
    expect(parseCommand('/exit')).toEqual({ cmd: 'quit' });
    expect(parseCommand('/help')).toEqual({ cmd: 'help' });
    expect(parseCommand('/unknown')).toBeNull();
    expect(parseCommand('běžná zpráva')).toBeNull();
  });
});

describe('isSlashCommandDraft', () => {
  it('is true while the input can still be a command name and false for ordinary text', async () => {
    const { isSlashCommandDraft } = await import('../../../src/cli/chat/commands.js');
    expect(isSlashCommandDraft('/')).toBe(true);
    expect(isSlashCommandDraft('/mo')).toBe(true);
    expect(isSlashCommandDraft('/model')).toBe(true);
    expect(isSlashCommandDraft('')).toBe(false); // leading '/' deleted → overlay closes
    expect(isSlashCommandDraft('/model high')).toBe(false); // arguments → the command name is committed
    expect(isSlashCommandDraft('/var/www/x')).toBe(false); // a path, not a command
    expect(isSlashCommandDraft('běžná zpráva')).toBe(false);
  });
});

describe('mode toggle key', () => {
  it('recognizes Shift+Tab and the Ctrl+Tab sequence some terminals emit', async () => {
    const { createKeymap } = await import('../../../src/cli/chat/keys.js');
    const keymap = createKeymap();
    expect(keymap.matches('mode_toggle', '\x1b[Z')).toBe(true);
    expect(keymap.matches('mode_toggle', '\x1b[9;5u')).toBe(true);
    expect(keymap.matches('mode_toggle', '\t')).toBe(false);
  });
});

describe('statusline', () => {
  it('renders only the toggled parts and hides entirely when the plugin is off', async () => {
    const { statusline } = await import('../../../src/cli/chat/chatComposition.js');
    const usage = { tokens: 34_500, contextWindow: 200_000, percent: 17.25, totalTokens: 1_234_567, cost: 0.4218 };
    expect(statusline(null, usage, 'opus')).toBe('');
    expect(statusline({}, usage, 'opus')).toBe('');
    expect(statusline({ showModel: true }, usage, 'opus')).toBe('opus');
    expect(statusline({ showContext: true, showTokens: true, showCost: true }, usage, 'opus'))
      .toBe('context 17% (35k/200k)  ·  Σ 1.2M tok  ·  $0.42');
    // unknown context tokens (right after compaction) → context part omitted
    expect(statusline({ showContext: true }, { ...usage, tokens: null, percent: null }, 'opus')).toBe('');
  });
});
