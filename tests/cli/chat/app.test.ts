import { describe, it, expect, vi } from 'vitest';
import { loadInitialTranscript } from '../../../src/cli/chat/initialTranscriptHydration.js';
import { ChatApplication } from '../../../src/cli/chat/chatApplication.js';
import { installExitGuards, createShutdownCoordinator } from '../../../src/cli/chat/terminalLifecycle.js';
import { SnapshotHydrator } from '../../../src/cli/chat/snapshotHydrator.js';
import type { BrainClient } from '../../../src/cli/chat/brainClient.js';
import { ChatState } from '../../../src/cli/chat/chatState.js';
import { TranscriptModel } from '../../../src/brain/transcriptModel.js';

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
  it('registers exit/SIGTERM/SIGHUP/SIGINT guards and the disposer removes exactly those', () => {
    const before = {
      exit: process.listenerCount('exit'),
      term: process.listenerCount('SIGTERM'),
      hup: process.listenerCount('SIGHUP'),
      int: process.listenerCount('SIGINT'),
      fatal: process.listenerCount('uncaughtExceptionMonitor'),
    };
    const dispose = installExitGuards({ shutdown: async () => {}, teardownNow: () => {}, exit: () => {} });
    expect(process.listenerCount('exit')).toBe(before.exit + 1);
    expect(process.listenerCount('SIGTERM')).toBe(before.term + 1);
    expect(process.listenerCount('SIGHUP')).toBe(before.hup + 1);
    expect(process.listenerCount('SIGINT')).toBe(before.int + 1);
    expect(process.listenerCount('uncaughtExceptionMonitor')).toBe(before.fatal + 1);
    // Menu return: quit() calls the disposer, which must drop the count back so a relaunch doesn't stack.
    dispose();
    expect(process.listenerCount('exit')).toBe(before.exit);
    expect(process.listenerCount('SIGTERM')).toBe(before.term);
    expect(process.listenerCount('SIGHUP')).toBe(before.hup);
    expect(process.listenerCount('SIGINT')).toBe(before.int);
    expect(process.listenerCount('uncaughtExceptionMonitor')).toBe(before.fatal);
  });

  // Regression: the signal guards were registered with `process.once`. Node removes a `once` listener
  // BEFORE invoking it, and removing the last listener for a signal restores the default disposition —
  // so the second ctrl+c killed the process outright during the window the first one was still delivering
  // the daemon stop, recreating the very wedge the guards exist to prevent. The behavioural test below
  // could not catch it: it calls a captured reference, which never exercises Node's own removal. Assert
  // the registration itself — a `once` listener appears in rawListeners as a wrapper carrying `.listener`.
  it('registers the signal guards so they SURVIVE being dispatched', () => {
    const dispose = installExitGuards({ shutdown: async () => {}, teardownNow: () => {}, exit: () => {} });
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
      const raw = process.rawListeners(signal).at(-1) as { listener?: unknown };
      expect(raw, signal).toBeTypeOf('function');
      expect(raw.listener, `${signal} must be registered with .on, not .once`).toBeUndefined();
    }
    dispose();
  });

  // Regression: SIGINT was unhandled, so a ctrl+c landing while raw mode was off (during
  // shutdown's own terminal restore, a `!` shell, the editor) hit Node's default and killed the process
  // instantly — taking the in-flight stopSession with it. The daemon never learned the client left, kept
  // the conversation live and streaming, and /resume reattached to a wedged session until a daemon restart.
  it('SIGINT issues the daemon stop through the bounded shutdown instead of killing the process', async () => {
    const calls: string[] = [];
    let finishStop!: () => void;
    const shutdown = createShutdownCoordinator({
      teardown: () => { calls.push('teardown'); },
      stopBoundSession: () => new Promise<void>((resolve) => { calls.push('stop-session'); finishStop = resolve; }),
      timeoutMs: 5_000,
    });
    const dispose = installExitGuards({ shutdown, teardownNow: shutdown.teardownNow, exit: (code) => { calls.push(`exit:${code}`); } });
    const sigint = process.listeners('SIGINT').at(-1) as () => void;

    sigint();
    expect(calls).toEqual(['teardown']);
    await Promise.resolve();
    // The whole point: the session release is actually issued, and the process is still alive to send it.
    expect(calls).toEqual(['teardown', 'stop-session']);
    // An impatient second ctrl+c in that window must be swallowed, not kill the very request that frees
    // the session (the `exiting` latch).
    sigint();
    expect(calls).toEqual(['teardown', 'stop-session']);

    finishStop();
    await shutdown();
    await Promise.resolve();
    expect(calls).toContain('exit:130');
    dispose();
  });

  // Regression: SIGTSTP was briefly routed into the same shutdown as SIGINT. It only ever reaches this
  // process while raw mode is OFF — inside the external editor or a `!` shell — and vim signals the whole
  // process group, so the handler tore the chat down around a live editor: SIGTERM, then SIGKILL once the
  // bounded wait expired (a stopped process cannot service TERM), the draft temp file removed by the
  // editor's own finally, and the alt-screen reset written into a terminal the editor still owned. A
  // reflexive ctrl+z destroyed unsaved work. Suspend is not exit — the default disposition stops the group
  // and `fg` resumes it with the session still bound, so no release is owed here in the first place.
  it('leaves SIGTSTP to default job control so ctrl+z suspends instead of quitting', () => {
    const before = process.listenerCount('SIGTSTP');
    const dispose = installExitGuards({ shutdown: async () => {}, teardownNow: () => {}, exit: () => {} });
    expect(process.listenerCount('SIGTSTP')).toBe(before);
    dispose();
  });

  it('a signal waits for bounded shutdown before exiting', async () => {
    const calls: string[] = [];
    let finishShutdown!: () => void;
    const shutdown = vi.fn(() => {
      calls.push('shutdown');
      return new Promise<void>((resolve) => { finishShutdown = resolve; });
    });
    const dispose = installExitGuards({ shutdown, teardownNow: () => { calls.push('teardown-now'); }, exit: (code) => { calls.push(`exit:${code}`); } });
    // Call our just-added SIGTERM handler directly (not process.emit) so no other listeners fire.
    const sigterm = process.listeners('SIGTERM').at(-1) as () => void;
    sigterm();
    expect(calls).toEqual(['teardown-now', 'shutdown']);
    finishShutdown();
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toEqual(['teardown-now', 'shutdown', 'exit:143']);
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
    const dispose = installExitGuards({ shutdown, teardownNow: shutdown.teardownNow, exit: () => {} });
    const fatal = process.listeners('uncaughtExceptionMonitor').at(-1) as (error: Error) => void;
    fatal(new Error('render overflow'));
    expect(calls).toEqual(['teardown']);
    await Promise.resolve();
    expect(calls).toEqual(['teardown', 'stop']);
    finishStop();
    await shutdown();
    dispose();
  });

  // The escalating stop: PI's agent loop only re-checks its abort signal between tool calls, so the
  // graceful stop can be waited out by a long foreground command. A REPEAT quit gesture is the user
  // escalating — it must fire the hard kill without disturbing the pending shutdown transaction.
  it('a repeat ctrl+c escalates to the foreground kill while the stop is still in flight', async () => {
    const calls: string[] = [];
    let finishStop!: () => void;
    const shutdown = createShutdownCoordinator({
      teardown: () => { calls.push('teardown'); },
      stopBoundSession: () => new Promise<void>((resolve) => { calls.push('stop-session'); finishStop = resolve; }),
      escalate: () => { calls.push('escalate'); },
      timeoutMs: 5_000,
    });
    const dispose = installExitGuards({
      shutdown, teardownNow: shutdown.teardownNow,
      escalate: () => { calls.push('escalate'); },
      exit: (code) => { calls.push(`exit:${code}`); },
    });
    const sigint = process.listeners('SIGINT').at(-1) as () => void;

    // First press: the ordinary graceful stop — never an escalation.
    sigint();
    await Promise.resolve();
    expect(calls).toEqual(['teardown', 'stop-session']);
    // Second press while the release is in flight: escalate, and still don't kill the pending release.
    sigint();
    expect(calls).toEqual(['teardown', 'stop-session', 'escalate']);
    // The keyboard-path repeat (keymap quit → coordinator, no signal latch) escalates the same way.
    void shutdown();
    expect(calls).toEqual(['teardown', 'stop-session', 'escalate', 'escalate']);

    finishStop();
    await shutdown();
    await Promise.resolve();
    expect(calls).toContain('exit:130');
    dispose();
  });

  // A supervisor re-sending SIGTERM/SIGHUP is a retry, never a human escalating — it must not SIGKILL a
  // command the graceful stop would have left running.
  it('a repeat SIGTERM does not escalate', async () => {
    const calls: string[] = [];
    const shutdown = vi.fn(() => new Promise<void>(() => { calls.push('shutdown'); }));
    const dispose = installExitGuards({
      shutdown, teardownNow: () => {},
      escalate: () => { calls.push('escalate'); },
      exit: () => {},
    });
    const sigterm = process.listeners('SIGTERM').at(-1) as () => void;
    sigterm();
    sigterm();
    expect(calls).toEqual(['shutdown']);
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
    const dispose = installExitGuards({ shutdown, teardownNow: shutdown.teardownNow, exit: () => {} });
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

    expect(typeof shutdown.teardownNow).toBe('function');

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
  it('hydrates the selected conversation goal through the fenced metadata path before rendering', async () => {
    const activeGoal = {
      session_id: 'brain-1', user_id: 1, status: 'active' as const, goal: 'Keep the goal visible',
      draft: '', subgoals: '[]', turns_used: 2, turn_budget: 8, last_verdict: 'continue',
      last_evidence: 'tests added', paused_reason: '',
      created_at: '2026-07-12 10:00:00', updated_at: '2026-07-12 10:00:02',
    };
    const client = {
      bindLifetime: vi.fn(),
      status: vi.fn(async () => null),
      mcpServers: vi.fn(async () => []),
      rateLimitsAll: vi.fn(async () => ({})),
      goal: vi.fn(async () => activeGoal),
    } as unknown as BrainClient;
    const application = new ChatApplication({ base: 'http://unused', token: 'unused', client });
    const state = new ChatState({ transcript: new TranscriptModel() });
    const internals = application as unknown as {
      state: ChatState;
      resources: { client: BrainClient };
      refreshMeta(): Promise<void>;
    };
    internals.state = state;
    internals.resources = { client };

    await internals.refreshMeta();

    expect(client.goal).toHaveBeenCalledOnce();
    expect(state.goal).toEqual(activeGoal);
  });

  it('hydrates all provider limits when metadata reports a provider switch', async () => {
    const codexLimits = {
      provider: 'openai-codex', planType: 'pro', fetchedAt: 2, stale: false,
      windows: [{ usedPercent: 11, windowMinutes: 300, resetsAt: 123 }],
    };
    const client = {
      bindLifetime: vi.fn(),
      status: vi.fn(async () => ({
        running: false, sessionId: 'brain-1', model: 'gpt-5.6-sol', provider: 'openai-codex',
        usage: null, statusline: null,
      })),
      mcpServers: vi.fn(async () => []),
      rateLimitsAll: vi.fn(async () => ({ 'openai-codex': codexLimits })),
      goal: vi.fn(async () => null),
    } as unknown as BrainClient;
    const application = new ChatApplication({ base: 'http://unused', token: 'unused', client });
    const state = new ChatState({ transcript: new TranscriptModel(), provider: 'anthropic' });
    state.rateLimitsByProvider = {
      anthropic: {
        provider: 'anthropic', planType: null, fetchedAt: 1, stale: false,
        windows: [{ usedPercent: 90, windowMinutes: 300, resetsAt: 456 }],
      },
    };
    const internals = application as unknown as {
      state: ChatState;
      resources: { client: BrainClient };
      rateLimitsFetchedAt: number;
      refreshMeta(): Promise<void>;
    };
    internals.state = state;
    internals.resources = { client };
    internals.rateLimitsFetchedAt = 999;

    await internals.refreshMeta();
    await vi.waitFor(() => expect(state.rateLimitsByProvider['openai-codex']).toEqual(codexLimits));

    expect(state.provider).toBe('openai-codex');
    expect(client.rateLimitsAll).toHaveBeenCalledOnce();
    expect(internals.rateLimitsFetchedAt).not.toBe(999);
  });

  it('does not let an older metadata response overwrite a newer streamed goal transition', async () => {
    const activeGoal = {
      session_id: 'brain-1', user_id: 1, status: 'active' as const, goal: 'Finish safely',
      draft: '', subgoals: '[]', turns_used: 0, turn_budget: 8, last_verdict: '',
      last_evidence: '', paused_reason: '',
      created_at: '2026-07-12 10:00:00', updated_at: '2026-07-12 10:00:00',
    };
    let resolveGoal!: (goal: typeof activeGoal) => void;
    const delayedGoal = new Promise<typeof activeGoal>((resolve) => { resolveGoal = resolve; });
    const client = {
      bindLifetime: vi.fn(),
      status: vi.fn(async () => null),
      mcpServers: vi.fn(async () => []),
      rateLimitsAll: vi.fn(async () => ({})),
      goal: vi.fn(() => delayedGoal),
    } as unknown as BrainClient;
    const application = new ChatApplication({ base: 'http://unused', token: 'unused', client });
    const state = new ChatState({ transcript: new TranscriptModel(), goal: activeGoal });
    const internals = application as unknown as {
      state: ChatState;
      resources: { client: BrainClient };
      refreshMeta(): Promise<void>;
    };
    internals.state = state;
    internals.resources = { client };

    const refreshing = internals.refreshMeta();
    await Promise.resolve();
    const completed = { ...activeGoal, status: 'done' as const, turns_used: 1, last_verdict: 'done' };
    state.setGoal(completed); // same replacement performed by StreamCoordinator's authoritative goal event
    resolveGoal(activeGoal); // stale GET that started before the completion event
    await refreshing;

    expect(state.goal).toEqual(completed);
  });

  it('fences a stale metadata goal across a null-active-null ABA lifecycle', async () => {
    const staleActive = {
      session_id: 'brain-1', user_id: 1, status: 'active' as const, goal: 'Already cleared',
      draft: '', subgoals: '[]', turns_used: 0, turn_budget: 8, last_verdict: '',
      last_evidence: '', paused_reason: '',
      created_at: '2026-07-12 10:00:00', updated_at: '2026-07-12 10:00:00',
    };
    let resolveGoal!: (goal: typeof staleActive) => void;
    const delayedGoal = new Promise<typeof staleActive>((resolve) => { resolveGoal = resolve; });
    const client = {
      bindLifetime: vi.fn(), status: vi.fn(async () => null), mcpServers: vi.fn(async () => []),
      rateLimitsAll: vi.fn(async () => ({})), goal: vi.fn(() => delayedGoal),
    } as unknown as BrainClient;
    const application = new ChatApplication({ base: 'http://unused', token: 'unused', client });
    const state = new ChatState({ transcript: new TranscriptModel() });
    const internals = application as unknown as {
      state: ChatState; resources: { client: BrainClient }; refreshMeta(): Promise<void>;
    };
    internals.state = state;
    internals.resources = { client };

    const refreshing = internals.refreshMeta();
    await Promise.resolve();
    state.setGoal(staleActive);
    state.setGoal(null);
    resolveGoal(staleActive);
    await refreshing;

    expect(state.goal).toBeNull();
  });

  it('does not construct terminal owners after shutdown cancels an in-flight bootstrap', async () => {
    let enteredHistory!: () => void;
    let resolveHistory!: (history: []) => void;
    const historyStarted = new Promise<void>((resolve) => { enteredHistory = resolve; });
    const delayedHistory = new Promise<[]>((resolve) => { resolveHistory = resolve; });
    const client = {
      bindLifetime: vi.fn(),
      start: vi.fn(async () => ({ sessionId: 'booting' })),
      status: vi.fn(async () => null),
      processes: vi.fn(async () => []),
      terminalSettings: vi.fn(async () => null),
      commands: vi.fn(async () => []),
      localShellTimeoutMs: vi.fn(async () => null),
      publicBrand: vi.fn(async () => ({ agentName: 'Elowen', productName: 'Elowen', themed: false })),
      history: vi.fn(() => { enteredHistory(); return delayedHistory; }),
      rateLimitsAll: vi.fn(async () => ({})),
      mcpServers: vi.fn(async () => []),
      stopSession: vi.fn(async () => {}),
    } as unknown as BrainClient;
    const application = new ChatApplication({ base: 'http://unused', token: 'unused', client });
    const internals = application as unknown as {
      stopLocal(): Promise<void>;
      coordinator: unknown;
      composition: unknown;
      lifecycle: unknown;
      diagnostics: unknown;
    };

    const running = application.run();
    await historyStarted;
    await internals.stopLocal();
    await running;
    resolveHistory([]);

    expect(internals.coordinator).toBeNull();
    expect(internals.composition).toBeNull();
    expect(internals.lifecycle).toBeNull();
    expect(internals.diagnostics).toBeNull();
  });

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

  it('enters the shared shutdown transaction when terminal resume fails', () => {
    const client = { bindLifetime: vi.fn() } as unknown as BrainClient;
    const application = new ChatApplication({ base: 'http://unused', token: 'unused', client });
    const quit = vi.fn();
    Object.assign(application, {
      lifecycle: { resume: () => { throw new Error('raw mode unavailable after editor'); } },
      quitImpl: quit,
    });

    expect(() => (application as unknown as { resume(): void }).resume())
      .toThrow('raw mode unavailable after editor');
    expect(quit).toHaveBeenCalledOnce();
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
    expect(parseCommand('/tdd')).toBeNull(); // retired — the agents plugin owns the tddMode setting
    expect(parseCommand('/quit')).toEqual({ cmd: 'quit' });
    expect(parseCommand('/exit')).toEqual({ cmd: 'quit' });
    expect(parseCommand('/help')).toEqual({ cmd: 'help' });
    expect(parseCommand('/unknown')).toBeNull();
    expect(parseCommand('/goal Fix tests', [{ name: 'goal', description: 'Goal', kind: 'action' }])).toEqual({ cmd: 'goal', arg: 'Fix tests' });
    expect(parseCommand('/goal Fix tests', [{ name: 'help', description: 'Help', kind: 'info' }])).toBeNull();
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
    const { statusline } = await import('../../../src/cli/chat/composeLines.js');
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
