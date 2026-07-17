import { describe, it, expect, vi } from 'vitest';
import { StreamCoordinator } from '../../../src/cli/chat/streamCoordinator.js';
import type { Flows } from '../../../src/cli/chat/flows.js';
import { BrainClient } from '../../../src/cli/chat/brainClient.js';
import type { BrainEvent } from '../../../src/brain/events.js';
import { TranscriptModel } from '../../../src/brain/transcriptModel.js';
import { ChatState } from '../../../src/cli/chat/chatState.js';
import type { ChatStateSeed } from '../../../src/cli/chat/chatState.js';
import type { ChatApplicationActions } from '../../../src/cli/chat/chatCapabilities.js';
import { SnapshotHydrator } from '../../../src/cli/chat/snapshotHydrator.js';
import { HydrationNoticeOwner } from '../../../src/cli/chat/hydrationNoticeOwner.js';
import { loadInitialTranscript } from '../../../src/cli/chat/initialTranscriptHydration.js';

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

function state(
  history: ConstructorParameters<typeof TranscriptModel>[0] = [],
  seed: Omit<ChatStateSeed, 'transcript'> = {},
): ChatState {
  return new ChatState({ transcript: new TranscriptModel(history), ...seed });
}

function turns(transcript: TranscriptModel): NonNullable<ReturnType<TranscriptModel['turnAt']>>[] {
  return Array.from({ length: transcript.turnCount }, (_, index) => transcript.turnAt(index))
    .filter((turn): turn is NonNullable<typeof turn> => turn != null);
}

function serialized(transcript: TranscriptModel | undefined): string {
  return JSON.stringify(transcript ? turns(transcript) : []);
}

function actions(overrides: Partial<ChatApplicationActions> = {}): ChatApplicationActions {
  return {
    render: () => {},
    renderForced: () => {},
    refreshRateLimits: async () => {},
    onTurnSettled: () => {},
    onTurnActive: () => {},
    refreshMeta: async () => {},
    invalidateAsyncState: () => {},
    quit: () => {},
    suspendTerminal: () => {},
    resumeTerminal: () => {},
    ...overrides,
  };
}

describe('StreamCoordinator — parent stream ownership', () => {
  it('atomically aborts and replaces the parent controller when a rebuilt session restarts', () => {
    const streamSignals: AbortSignal[] = [];
    const client = {
      stream: (_onEvent: (event: BrainEvent) => void, signal: AbortSignal) => {
        streamSignals.push(signal);
        return Promise.resolve();
      },
      rebind: () => {},
    } as unknown as BrainClient;
    const old = new AbortController();
    const rt = state();
    rt.streamAc = old;
    const coordinator = new StreamCoordinator(
      rt, { client }, actions(),
      { launchAsk: () => {}, openPlanDecision: () => {} } as unknown as Flows,
      new SnapshotHydrator<BrainEvent>(), new HydrationNoticeOwner(),
    );

    coordinator.restartStream();

    expect(old.signal.aborted).toBe(true);
    expect(rt.streamAc).not.toBe(old);
    expect(rt.streamAc.signal.aborted).toBe(false);
    expect(streamSignals).toEqual([rt.streamAc.signal]);
    coordinator.stop();
    expect(rt.streamAc.signal.aborted).toBe(true);
  });
});

describe('StreamCoordinator — idle rollover', () => {
  it('resets to the fresh conversation on `session` and rebuilds from the daemon stream (no refetch)', () => {
    let onEvent!: (e: BrainEvent) => void;
    let historyCalls = 0;
    const client = {
      stream: (cb: (e: BrainEvent) => void) => { onEvent = cb; return Promise.resolve(); },
      history: () => { historyCalls++; return Promise.resolve([]); },
      rebind: () => {},
    } as unknown as BrainClient;

    const ac = new AbortController();
    // Prior conversation on screen — no optimistic local 'you' (the daemon is the echo authority now).
    const rt = state(
      [{ role: 'user', text: 'yesterday' }, { role: 'assistant', text: 'old answer' }],
      { conversationTitle: 'seeded', workMode: 'build' },
    );
    rt.setGoal({
      session_id: 'old-session', user_id: 1, status: 'active', goal: 'Old conversation goal',
      draft: '', subgoals: '[]', turns_used: 1, turn_budget: 8, last_verdict: '',
      last_evidence: '', paused_reason: '', created_at: '2026-07-12 10:00:00', updated_at: '2026-07-12 10:00:00',
    });
    rt.streamAc = ac;
    const flows = { launchAsk: () => {}, openPlanDecision: () => {} } as unknown as Flows;
    const stream = new StreamCoordinator(
      rt, { client }, actions(), flows,
      new SnapshotHydrator<BrainEvent>(), new HydrationNoticeOwner(),
    );
    stream.openStream(ac);

    // Idle rollover: the server continued this message in a FRESH conversation, then re-emits the
    // triggering message as a `user` event and streams its reply — all in order, no history refetch.
    onEvent({ type: 'session', sessionId: 'fresh-1' });
    expect(turns(rt.transcript)).toEqual([]); // the prior conversation is cleared
    expect(rt.goal).toBeNull(); // old conversation state must never bleed into the fresh composer
    onEvent({ type: 'user', text: 'today' });
    onEvent({ type: 'text', delta: 'streamed after rollover' });

    expect(turns(rt.transcript)[0]).toEqual({ role: 'you', text: 'today' });
    expect(turns(rt.transcript).some((t) => t.role === 'elowen' && t.segments.some((s) => s.kind === 'text' && s.text.includes('streamed')))).toBe(true);
    expect(historyCalls).toBe(0); // a rollover never refetches — the fresh session has nothing stored yet
  });

  it('buffers events during the post-compaction history refetch and replays them onto the collapsed view', async () => {
    let onEvent!: (e: BrainEvent) => void;
    const hist = deferred<{ role: string; text: string }[]>();
    const client = {
      stream: (cb: (e: BrainEvent) => void) => { onEvent = cb; return Promise.resolve(); },
      history: () => hist.promise,
      rebind: () => {},
    } as unknown as BrainClient;

    const ac = new AbortController();
    const rt = state(
      [{ role: 'user', text: 'q1' }, { role: 'assistant', text: 'long answer' }],
      { conversationTitle: 'seeded', workMode: 'build' },
    );
    rt.streamAc = ac;
    const flows = { launchAsk: () => {}, openPlanDecision: () => {} } as unknown as Flows;
    const stream = new StreamCoordinator(
      rt, { client }, actions(), flows,
      new SnapshotHydrator<BrainEvent>(), new HydrationNoticeOwner(),
    );
    stream.openStream(ac);

    // Auto-compact persisted server-side → `compacted`; the queued-flush turn immediately streams its
    // reply BEFORE the history refetch resolves. That delta must land on the refetched (collapsed) view.
    onEvent({ type: 'compacted' });
    onEvent({ type: 'text', delta: 'flush-turn reply' });

    const hasFlushReply = (): boolean => turns(rt.transcript).some(
      (t) => t.role === 'elowen' && t.segments.some((s) => s.kind === 'text' && s.text.includes('flush-turn')));
    // Not folded into the stale pre-compaction view (it would be discarded when history lands).
    expect(hasFlushReply()).toBe(false);

    // The collapsed transcript lands (divider + kept tail), then the buffered delta replays onto it.
    hist.resolve([{ role: 'compaction', text: '' }, { role: 'user', text: 'q1' }]);
    await new Promise((r) => setTimeout(r, 0));

    expect(turns(rt.transcript).some((t) => t.role === 'divider')).toBe(true);
    expect(hasFlushReply()).toBe(true);
  });

  // A message sent DURING a manual /compact parks on the session lock and resumes the instant the
  // compaction ends — so its durable row lands in the same breath as the `compacted` that triggers this
  // refetch, and the refetched history already contains it. The buffered `user` event then replays on top.
  // The snapshot path strips id-matched rows for exactly this reason; the refetch has no such filter, so
  // the model itself has to recognise the row it already holds.
  it('renders a message once when the refetched history already carries its durable row', async () => {
    let onEvent!: (e: BrainEvent) => void;
    const hist = deferred<{ role: string; text: string; id?: string }[]>();
    const client = {
      stream: (cb: (e: BrainEvent) => void) => { onEvent = cb; return Promise.resolve(); },
      history: () => hist.promise,
      rebind: () => {},
    } as unknown as BrainClient;

    const ac = new AbortController();
    const rt = state([{ role: 'user', text: 'q1' }, { role: 'assistant', text: 'long answer' }]);
    rt.streamAc = ac;
    const flows = { launchAsk: () => {}, openPlanDecision: () => {} } as unknown as Flows;
    const stream = new StreamCoordinator(
      rt, { client }, actions(), flows,
      new SnapshotHydrator<BrainEvent>(), new HydrationNoticeOwner(),
    );
    stream.openStream(ac);

    onEvent({ type: 'compacted' });
    onEvent({ type: 'user', text: 'sent during the compaction', durableId: 'row-9' });

    hist.resolve([
      { role: 'compaction', text: '' },
      { role: 'user', text: 'sent during the compaction', id: 'row-9' },
    ]);
    await new Promise((r) => setTimeout(r, 0));

    expect(turns(rt.transcript).filter((t) => t.role === 'you')).toHaveLength(1);
  });

  // The same durable id must still render when history does NOT carry it — the snapshot path deliberately
  // strips those rows so the live marker can hold their true position among the deltas.
  it('still renders a message whose durable row was stripped from the history prefix', async () => {
    let onEvent!: (e: BrainEvent) => void;
    const hist = deferred<{ role: string; text: string; id?: string }[]>();
    const client = {
      stream: (cb: (e: BrainEvent) => void) => { onEvent = cb; return Promise.resolve(); },
      history: () => hist.promise,
      rebind: () => {},
    } as unknown as BrainClient;

    const ac = new AbortController();
    const rt = state([{ role: 'user', text: 'q1' }]);
    rt.streamAc = ac;
    const flows = { launchAsk: () => {}, openPlanDecision: () => {} } as unknown as Flows;
    const stream = new StreamCoordinator(
      rt, { client }, actions(), flows,
      new SnapshotHydrator<BrainEvent>(), new HydrationNoticeOwner(),
    );
    stream.openStream(ac);

    onEvent({ type: 'compacted' });
    onEvent({ type: 'user', text: 'ordered live marker', durableId: 'row-9' });

    hist.resolve([{ role: 'compaction', text: '' }]); // id-matched row stripped, as streamSnapshot does
    await new Promise((r) => setTimeout(r, 0));

    expect(turns(rt.transcript).filter((t) => t.role === 'you' && t.text === 'ordered live marker')).toHaveLength(1);
  });

  it('a `queue` event replaces rt.queued (full snapshot) without touching the transcript view', () => {
    let onEvent!: (e: BrainEvent) => void;
    const client = {
      stream: (cb: (e: BrainEvent) => void) => { onEvent = cb; return Promise.resolve(); },
      history: () => Promise.resolve([]),
      rebind: () => {},
    } as unknown as BrainClient;
    const ac = new AbortController();
    const rt = state([{ role: 'assistant', text: 'hi' }], {
      conversationTitle: 'x', workMode: 'build', queued: [],
    });
    rt.streamAc = ac;
    const flows = { launchAsk: () => {}, openPlanDecision: () => {} } as unknown as Flows;
    const stream = new StreamCoordinator(
      rt, { client }, actions(), flows,
      new SnapshotHydrator<BrainEvent>(), new HydrationNoticeOwner(),
    );
    stream.openStream(ac);
    const before = rt.transcript.revision;

    onEvent({ type: 'queue', items: [{ id: 'q1', text: 'one' }, { id: 'q2', text: 'two' }] });
    expect(rt.queued).toEqual([{ id: 'q1', text: 'one' }, { id: 'q2', text: 'two' }]);
    expect(rt.transcript.revision).toBe(before); // queue state does not mutate the transcript model

    // A later snapshot (e.g. a removal or a drain) replaces wholesale — never a merge.
    onEvent({ type: 'queue', items: [] });
    expect(rt.queued).toEqual([]);
    expect(rt.transcript.revision).toBe(before);
  });

  it('a `process` event replaces rt.processes (full snapshot) without touching the transcript view', () => {
    let onEvent!: (e: BrainEvent) => void;
    const client = {
      stream: (cb: (e: BrainEvent) => void) => { onEvent = cb; return Promise.resolve(); },
      history: () => Promise.resolve([]),
      rebind: () => {},
    } as unknown as BrainClient;
    const ac = new AbortController();
    const rt = state([{ role: 'assistant', text: 'hi' }], {
      conversationTitle: 'x', workMode: 'build', processes: [],
    });
    rt.streamAc = ac;
    const flows = { launchAsk: () => {}, openPlanDecision: () => {} } as unknown as Flows;
    const stream = new StreamCoordinator(
      rt, { client }, actions(), flows,
      new SnapshotHydrator<BrainEvent>(), new HydrationNoticeOwner(),
    );
    stream.openStream(ac);
    const before = rt.transcript.revision;

    const proc = { id: 'p1', command: 'npm run dev', cwd: '/x', startedAt: '2026-01-01T00:00:00.000Z', sessionId: null, running: true, exitCode: null };
    onEvent({ type: 'process', processes: [proc] });
    expect(rt.processes).toEqual([proc]);
    expect(rt.transcript.revision).toBe(before); // process state does not mutate the transcript model

    // A later snapshot (a kill/exit) replaces wholesale — the killed process just drops off.
    onEvent({ type: 'process', processes: [] });
    expect(rt.processes).toEqual([]);
    expect(rt.transcript.revision).toBe(before);
  });

  it('a `goal` event replaces the authoritative goal state without touching the transcript view', () => {
    let onEvent!: (e: BrainEvent) => void;
    const client = {
      stream: (cb: (e: BrainEvent) => void) => { onEvent = cb; return Promise.resolve(); },
      history: () => Promise.resolve([]),
      rebind: () => {},
    } as unknown as BrainClient;
    const rt = state([{ role: 'assistant', text: 'hi' }], {
      conversationTitle: 'x', workMode: 'build',
    });
    const ac = new AbortController();
    rt.streamAc = ac;
    const render = vi.fn();
    const stream = new StreamCoordinator(
      rt, { client }, actions({ render }),
      { launchAsk: () => {}, openPlanDecision: () => {} } as unknown as Flows,
      new SnapshotHydrator<BrainEvent>(), new HydrationNoticeOwner(),
    );
    stream.openStream(ac);
    const before = rt.transcript.revision;
    const active = {
      session_id: 'brain-1', user_id: 1, status: 'active' as const,
      goal: 'Ship the goal indicator', draft: '', subgoals: '[]', turns_used: 0, turn_budget: 8,
      last_verdict: '', last_evidence: '', paused_reason: '',
      created_at: '2026-07-12 10:00:00', updated_at: '2026-07-12 10:00:00',
    };

    onEvent({ type: 'goal', goal: active });
    expect(rt.goal).toEqual(active);
    expect(rt.transcript.revision).toBe(before);
    expect(render).toHaveBeenLastCalledWith('stream:goal');

    onEvent({ type: 'goal', goal: { ...active, status: 'done', turns_used: 1, last_verdict: 'done' } });
    expect(rt.goal?.status).toBe('done');
    expect(rt.transcript.revision).toBe(before);
  });

  it('a `user` delivery event folds a you-turn into the transcript (the drained queued message)', () => {
    let onEvent!: (e: BrainEvent) => void;
    const client = {
      stream: (cb: (e: BrainEvent) => void) => { onEvent = cb; return Promise.resolve(); },
      history: () => Promise.resolve([]),
      rebind: () => {},
    } as unknown as BrainClient;
    const ac = new AbortController();
    const rt = state([{ role: 'assistant', text: 'previous reply' }], {
      conversationTitle: 'x', workMode: 'build', queued: [],
    });
    rt.streamAc = ac;
    const flows = { launchAsk: () => {}, openPlanDecision: () => {} } as unknown as Flows;
    const stream = new StreamCoordinator(
      rt, { client }, actions(), flows,
      new SnapshotHydrator<BrainEvent>(), new HydrationNoticeOwner(),
    );
    stream.openStream(ac);

    onEvent({ type: 'user', text: 'combined queued delivery' });
    expect(turns(rt.transcript).at(-1)).toEqual({ role: 'you', text: 'combined queued delivery' });
  });

  it('drops buffered frames delivered by an aborted stale parent stream after a switch', () => {
    let staleEvent!: (event: BrainEvent) => void;
    const rebinds: string[] = [];
    const client = {
      stream: (cb: (event: BrainEvent) => void) => { staleEvent = cb; return Promise.resolve(); },
      history: () => Promise.resolve([]),
      rebind: (sessionId: string) => { rebinds.push(sessionId); },
    } as unknown as BrainClient;
    const oldAc = new AbortController();
    const rt = state([{ role: 'assistant', text: 'new selection stays' }], {
      conversationTitle: 'new', workMode: 'build',
    });
    rt.streamAc = oldAc;
    const stream = new StreamCoordinator(
      rt, { client }, actions(),
      { launchAsk: () => {}, openPlanDecision: () => {} } as unknown as Flows,
      new SnapshotHydrator<BrainEvent>(), new HydrationNoticeOwner(),
    );
    stream.openStream(oldAc);
    rt.streamAc = new AbortController();
    oldAc.abort();

    staleEvent({ type: 'session', sessionId: 'stale-rollover' });
    staleEvent({ type: 'text', delta: 'stale bytes' });
    expect(rebinds).toEqual([]);
    expect(serialized(rt.transcript)).toContain('new selection stays');
    expect(serialized(rt.transcript)).not.toContain('stale bytes');
  });
});

describe('StreamCoordinator — focused sub-agent usage', () => {
  const usage = { tokens: 5_000, contextWindow: 200_000, percent: 2.5, totalTokens: 9_000, cost: 0.42 };

  type Lane = (frame: BrainEvent | Record<string, unknown>) => void;

  /** Fake client whose child lane hands back its own frame callback, keyed by session. */
  function childLaneClient(lanes: Map<string, Lane>): BrainClient {
    return {
      stream: (cb: Lane, _s?: AbortSignal, _r?: number, _x?: unknown, session?: string) => {
        if (session) lanes.set(session, cb);
        return Promise.resolve();
      },
      history: () => Promise.resolve([]),
      processes: () => Promise.resolve([]),
      rebind: () => {},
    } as unknown as BrainClient;
  }

  function snapshot(events: BrainEvent[]): Record<string, unknown> {
    return { type: 'snapshot', cursor: 0, history: [], events, truncated: false };
  }

  function coordinator(rt: ChatState, lanes: Map<string, Lane>): StreamCoordinator {
    const flows = { launchAsk: () => {}, openPlanDecision: () => {} } as unknown as Flows;
    return new StreamCoordinator(
      rt, { client: childLaneClient(lanes) }, actions(), flows,
      new SnapshotHydrator<BrainEvent>(), new HydrationNoticeOwner(),
    );
  }

  it('takes the child\'s context and cost from its own lane and leaves the parent\'s untouched', async () => {
    const lanes = new Map<string, Lane>();
    const rt = state();
    rt.usage = { tokens: 1, contextWindow: 2, percent: 3, totalTokens: 4, cost: 5 };
    const stream = coordinator(rt, lanes);

    void stream.openSubagent('brain-ch-a');
    await Promise.resolve();
    // Opening replays the child's snapshot: its numbers are known without any extra fetch — and no fetch
    // is possible, since /brain/status rejects a non-user session id.
    lanes.get('brain-ch-a')!(snapshot([{ type: 'step', step: 1, maxSteps: 0, usage }]));
    expect(rt.childView?.usage).toEqual(usage);

    // A later live frame keeps it current.
    const moved = { ...usage, tokens: 7_000, cost: 0.99 };
    lanes.get('brain-ch-a')!({ type: 'idle', model: 'm', usage: moved });
    expect(rt.childView?.usage).toEqual(moved);

    // The parent's own numbers describe a different conversation — they must never move.
    expect(rt.usage).toEqual({ tokens: 1, contextWindow: 2, percent: 3, totalTokens: 4, cost: 5 });
  });

  it('starts a newly focused child with no numbers rather than inheriting the previous one\'s', async () => {
    const lanes = new Map<string, Lane>();
    const rt = state();
    const stream = coordinator(rt, lanes);

    void stream.openSubagent('brain-ch-a');
    await Promise.resolve();
    lanes.get('brain-ch-a')!(snapshot([{ type: 'step', step: 1, maxSteps: 0, usage }]));
    expect(rt.childView?.usage).toEqual(usage);

    void stream.openSubagent('brain-ch-b');
    await Promise.resolve();
    expect(rt.childView?.sessionId).toBe('brain-ch-b');
    expect(rt.childView?.usage).toBeNull();
  });
});

describe('StreamCoordinator — bounded hydration lifecycle', () => {
  const runtime = (): ChatState => state([], {
    conversationTitle: 'parent', workMode: 'build', queued: [], processes: [],
  });
  const flows = { launchAsk: () => {}, openPlanDecision: () => {} } as unknown as Flows;

  it('times out a never-settling parent compaction read, retains live events and ignores the late result', async () => {
    vi.useFakeTimers();
    try {
      let onFrame!: (event: BrainEvent) => void;
      const history = deferred<{ role: string; text: string }[]>();
      const client = {
        stream: (cb: (event: BrainEvent) => void, signal: AbortSignal) => {
          onFrame = cb;
          return new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
        },
        history: (_session?: string, signal?: AbortSignal) => {
          signal?.addEventListener('abort', () => { /* deliberately ignored */ });
          return history.promise;
        },
        rebind: () => {},
      } as unknown as BrainClient;
      const rt = runtime();
      rt.transcript.replaceHistory([{ role: 'assistant', text: 'last valid parent' }]);
      const renders = vi.fn();
      const stream = new StreamCoordinator(
        rt, { client }, actions({ render: renders }), flows,
        new SnapshotHydrator<BrainEvent>(), new HydrationNoticeOwner(),
      );
      stream.openStream(rt.streamAc);

      onFrame({ type: 'compacted' });
      onFrame({ type: 'text', delta: 'live while waiting' });
      await vi.advanceTimersByTimeAsync(10_000);

      expect(serialized(rt.transcript)).toContain('last valid parent');
      expect(serialized(rt.transcript)).toContain('live while waiting');
      expect(rt.notice).toMatch(/timed out/i);
      const renderCount = renders.mock.calls.length;

      history.resolve([{ role: 'assistant', text: 'late stale parent' }]);
      await Promise.resolve();
      await Promise.resolve();
      expect(serialized(rt.transcript)).not.toContain('late stale parent');
      expect(renders).toHaveBeenCalledTimes(renderCount);
      stream.stop();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('settles a child fallback timeout, clears loading once and fences its late history', async () => {
    vi.useFakeTimers();
    try {
      const history = deferred<{ role: string; text: string }[]>();
      const client = {
        stream: () => Promise.reject(new Error('offline')),
        history: (_session?: string, signal?: AbortSignal) => {
          signal?.addEventListener('abort', () => { /* deliberately ignored */ });
          return history.promise;
        },
      } as unknown as BrainClient;
      const rt = runtime();
      const stream = new StreamCoordinator(
        rt, { client }, actions(), flows,
        new SnapshotHydrator<BrainEvent>(), new HydrationNoticeOwner(),
      );
      const opening = stream.openSubagent('child-timeout');
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(10_000);
      await opening;

      expect(rt.childView?.loading).toBe(false);
      expect(rt.notice).toMatch(/timed out/i);
      history.resolve([{ role: 'assistant', text: 'late child' }]);
      await Promise.resolve();
      await Promise.resolve();
      expect(serialized(rt.childView?.transcript)).not.toContain('late child');
      stream.stop();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not replace a valid transcript with empty state when a session history switch fails', async () => {
    const client = {
      start: async () => ({ sessionId: 'B' }),
      history: async () => { throw new Error('history offline'); },
      stream: async () => {},
      rebind: () => {},
    } as unknown as BrainClient;
    const rt = runtime();
    rt.transcript.replaceHistory([{ role: 'assistant', text: 'last valid A' }]);
    const stream = new StreamCoordinator(
      rt, { client }, actions(), flows,
      new SnapshotHydrator<BrainEvent>(), new HydrationNoticeOwner(),
    );

    await stream.switchTo({ session: 'B' });

    expect(serialized(rt.transcript)).toContain('last valid A');
    expect(rt.notice).toMatch(/could not load/i);
    stream.stop();
  });

  it('clears parent and child hydration notices after a successful session history switch', async () => {
    const client = {
      start: async () => ({ sessionId: 'B' }),
      history: async () => [{ role: 'assistant', text: 'new session B history' }],
      // Deliberately publish no snapshot: the successful history commit itself owns recovery.
      stream: async () => {},
      rebind: () => {},
    } as unknown as BrainClient;
    const keymapWarning = '\u001b[33mkeybinds: invalid ctrl+x\u001b[39m';
    const externalNotice = '\u001b[36mDraft stashed\u001b[39m';
    const childTimeout = '\u001b[31msub-agent transcript history timed out\u001b[39m';
    const parentTimeout = '\u001b[31mconversation transcript history timed out\u001b[39m';
    const notices = new HydrationNoticeOwner({
      base: keymapWarning,
      external: externalNotice,
      parent: parentTimeout,
      child: childTimeout,
    });
    const rt = runtime();
    rt.notice = notices.render();
    const stream = new StreamCoordinator(
      rt, { client }, actions(), flows,
      new SnapshotHydrator<BrainEvent>(), notices,
    );

    await stream.switchTo({ session: 'B' });

    expect(serialized(rt.transcript)).toContain('new session B history');
    expect(rt.notice).toBe(`${keymapWarning} · ${externalNotice}`);
    expect(rt.notice).not.toContain(parentTimeout);
    expect(rt.notice).not.toContain(childTimeout);
    stream.stop();
  });

  it('tears down an active child stream and hydration before committing a new parent session', async () => {
    vi.useFakeTimers();
    const childHistory = deferred<{ role: string; text: string }[]>();
    let stream: StreamCoordinator | null = null;
    let opening: Promise<void> | null = null;
    try {
      let childFrame!: (event: BrainEvent) => void;
      let childStreamSignal: AbortSignal | undefined;
      let childHistorySignal: AbortSignal | undefined;
      const parentStreamSignals: AbortSignal[] = [];
      const client = {
        start: async () => ({ sessionId: 'new-parent' }),
        history: (session?: string, signal?: AbortSignal) => {
          if (session === 'old-child') {
            childHistorySignal = signal;
            return childHistory.promise;
          }
          return Promise.resolve([{ role: 'assistant', text: `history for ${session}` }]);
        },
        stream: (callback: (event: BrainEvent) => void, signal: AbortSignal, _backoff: number, _open?: () => void, session?: string) => {
          if (session === 'old-child') {
            childFrame = callback;
            childStreamSignal = signal;
          } else {
            parentStreamSignals.push(signal);
          }
          return new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
        },
        rebind: () => {},
      } as unknown as BrainClient;
      const baseNotice = '\u001b[33mkeybind warning\u001b[39m';
      const childNotice = '\u001b[31mstale child hydration failure\u001b[39m';
      const notices = new HydrationNoticeOwner({ base: baseNotice, child: childNotice });
      const rt = runtime();
      rt.transcript.replaceHistory([{ role: 'assistant', text: 'old parent history' }]);
      rt.notice = notices.render();
      stream = new StreamCoordinator(
        rt, { client }, actions(), flows,
        new SnapshotHydrator<BrainEvent>(), notices,
      );

      opening = stream.openSubagent('old-child');
      await vi.advanceTimersByTimeAsync(2_000);
      expect(childHistorySignal).toBeDefined();
      expect(vi.getTimerCount()).toBeGreaterThan(0);

      await stream.switchTo({ session: 'new-parent' });

      expect(childStreamSignal?.aborted).toBe(true);
      expect(childHistorySignal?.aborted).toBe(true);
      expect(rt.childAc).toBeNull();
      expect(rt.childView).toBeNull();
      expect(parentStreamSignals).toEqual([rt.streamAc.signal]);
      expect(serialized(rt.transcript)).toContain('history for new-parent');
      expect(serialized(rt.transcript)).not.toContain('old parent history');
      expect(rt.notice).toBe(baseNotice);
      expect(vi.getTimerCount()).toBe(0);

      childFrame({ type: 'text', delta: 'late child output' });
      childHistory.resolve([{ role: 'assistant', text: 'late child history' }]);
      await Promise.resolve();
      await Promise.resolve();
      expect(serialized(rt.transcript)).not.toContain('late child');
      expect(rt.childView).toBeNull();
      await opening;
    } finally {
      stream?.stop();
      childHistory.resolve([]);
      if (opening) await opening;
      vi.useRealTimers();
    }
  });

  it('reconnects the old parent without reviving its child when a session switch fails', async () => {
    vi.useFakeTimers();
    let stream: StreamCoordinator | null = null;
    let opening: Promise<void> | null = null;
    try {
      const parentStreamSignals: AbortSignal[] = [];
      let childStreamSignal: AbortSignal | undefined;
      const client = {
        start: async () => { throw new Error('new parent unavailable'); },
        history: async () => [],
        stream: (_callback: (event: BrainEvent) => void, signal: AbortSignal, _backoff: number, _open?: () => void, session?: string) => {
          if (session === 'old-child') childStreamSignal = signal;
          else parentStreamSignals.push(signal);
          return new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
        },
        rebind: () => {},
      } as unknown as BrainClient;
      const baseNotice = '\u001b[33mkeybind warning\u001b[39m';
      const childNotice = '\u001b[31mstale child hydration failure\u001b[39m';
      const notices = new HydrationNoticeOwner({ base: baseNotice, child: childNotice });
      const rt = runtime();
      rt.transcript.replaceHistory([{ role: 'assistant', text: 'still-valid old parent' }]);
      rt.notice = notices.render();
      stream = new StreamCoordinator(
        rt, { client }, actions(), flows,
        new SnapshotHydrator<BrainEvent>(), notices,
      );
      stream.openStream(rt.streamAc);
      const originalParentSignal = rt.streamAc.signal;
      opening = stream.openSubagent('old-child');
      const childControllerSignal = rt.childAc?.signal;
      expect(vi.getTimerCount()).toBeGreaterThan(0);

      await expect(stream.switchTo({ session: 'new-parent' })).rejects.toThrow('new parent unavailable');

      expect(originalParentSignal.aborted).toBe(true);
      expect(parentStreamSignals).toEqual([originalParentSignal, rt.streamAc.signal]);
      expect(rt.streamAc.signal.aborted).toBe(false);
      expect(childControllerSignal?.aborted).toBe(true);
      expect(childStreamSignal?.aborted).toBe(true);
      expect(rt.childAc).toBeNull();
      expect(rt.childView).toBeNull();
      expect(serialized(rt.transcript)).toContain('still-valid old parent');
      expect(rt.notice).toBe(baseNotice);
      expect(vi.getTimerCount()).toBe(0);
      await opening;
    } finally {
      stream?.stop();
      if (opening) await opening;
      vi.useRealTimers();
    }
  });

  it('blocks child navigation for the whole successful switch and restores it after commit', async () => {
    const start = deferred<{ sessionId: string }>();
    const refreshStarted = deferred<void>();
    const finishRefresh = deferred<void>();
    const childStreams: string[] = [];
    const client = {
      start: () => start.promise,
      history: async (session?: string) => [{ role: 'assistant', text: `history for ${session}` }],
      stream: (
        callback: (frame: BrainEvent | { type: 'snapshot'; cursor: number; history: { role: string; text: string }[]; events: BrainEvent[] }) => void,
        signal: AbortSignal,
        _backoff: number,
        _open?: () => void,
        session?: string,
      ) => {
        if (session) {
          childStreams.push(session);
          callback({
            type: 'snapshot', cursor: 1,
            history: [{ role: 'assistant', text: `child history for ${session}` }], events: [],
          });
        }
        return new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
      },
      rebind: () => {},
    } as unknown as BrainClient;
    const rt = runtime();
    rt.transcript.apply({ type: 'tool', id: 'delegate-old', name: 'Delegate', detail: 'old child' });
    rt.transcript.apply({
      type: 'subagent', id: 'delegate-old', sessionId: 'old-child', status: 'running',
      task: 'old child', detail: 'working', tools: 1, seconds: 1,
    });
    const stream = new StreamCoordinator(
      rt, { client }, actions({
        refreshMeta: async () => {
          refreshStarted.resolve(undefined);
          await finishRefresh.promise;
        },
      }), flows,
      new SnapshotHydrator<BrainEvent>(), new HydrationNoticeOwner(),
    );

    const switching = stream.switchTo({ session: 'new-parent' });
    await Promise.resolve();
    stream.cycleSubagent();
    await stream.openSubagent('old-direct-child');
    expect(childStreams).toEqual([]);
    expect(rt.childView).toBeNull();

    start.resolve({ sessionId: 'new-parent' });
    await refreshStarted.promise;
    stream.cycleSubagent();
    await stream.openSubagent('old-during-metadata');
    expect(childStreams).toEqual([]);
    expect(rt.childView).toBeNull();

    finishRefresh.resolve(undefined);
    await switching;
    expect(rt.childView).toBeNull();
    expect(serialized(rt.transcript)).toContain('history for new-parent');

    await stream.openSubagent('new-parent-child');
    expect(childStreams).toEqual(['new-parent-child']);
    expect(rt.childView?.sessionId).toBe('new-parent-child');
    expect(serialized(rt.childView?.transcript)).toContain('child history for new-parent-child');
    stream.stop();
  });

  it('reconnects a failed switch with no child opened during the transition', async () => {
    const releaseStart = deferred<void>();
    const childStreams: string[] = [];
    const parentSignals: AbortSignal[] = [];
    const client = {
      start: async () => {
        await releaseStart.promise;
        throw new Error('new parent unavailable');
      },
      history: async () => [],
      stream: (
        callback: (frame: { type: 'snapshot'; cursor: number; history: { role: string; text: string }[]; events: BrainEvent[] }) => void,
        signal: AbortSignal,
        _backoff: number,
        _open?: () => void,
        session?: string,
      ) => {
        if (session) {
          childStreams.push(session);
          callback({ type: 'snapshot', cursor: 1, history: [], events: [] });
        } else {
          parentSignals.push(signal);
        }
        return new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
      },
      rebind: () => {},
    } as unknown as BrainClient;
    const rt = runtime();
    const stream = new StreamCoordinator(
      rt, { client }, actions(), flows,
      new SnapshotHydrator<BrainEvent>(), new HydrationNoticeOwner(),
    );
    stream.openStream(rt.streamAc);
    const originalParentSignal = rt.streamAc.signal;

    const switching = stream.switchTo({ session: 'new-parent' });
    await Promise.resolve();
    await stream.openSubagent('old-parent-child');
    expect(childStreams).toEqual([]);
    expect(rt.childView).toBeNull();

    releaseStart.resolve(undefined);
    await expect(switching).rejects.toThrow('new parent unavailable');
    expect(parentSignals).toEqual([originalParentSignal, rt.streamAc.signal]);
    expect(rt.childView).toBeNull();

    await stream.openSubagent('old-parent-child-after-failure');
    expect(childStreams).toEqual(['old-parent-child-after-failure']);
    expect(rt.childView?.sessionId).toBe('old-parent-child-after-failure');
    stream.stop();
  });

  it('stops parent history, child fallback, streams and all hydration timers together', async () => {
    vi.useFakeTimers();
    try {
      const signals: AbortSignal[] = [];
      let parentFrame!: (event: BrainEvent) => void;
      const client = {
        stream: (cb: (event: BrainEvent) => void, signal: AbortSignal, _backoff: number, _open?: () => void, session?: string) => {
          signals.push(signal);
          if (!session) parentFrame = cb;
          return new Promise<void>(() => {});
        },
        history: (_session?: string, signal?: AbortSignal) => {
          if (signal) signals.push(signal);
          return new Promise<never>(() => {});
        },
        rebind: () => {},
      } as unknown as BrainClient;
      const rt = runtime();
      const stream = new StreamCoordinator(
        rt, { client }, actions(), flows,
        new SnapshotHydrator<BrainEvent>(), new HydrationNoticeOwner(),
      );
      stream.openStream(rt.streamAc);
      parentFrame({ type: 'compacted' });
      const childOpening = stream.openSubagent('child-stop');
      await vi.advanceTimersByTimeAsync(2_000);
      const childSignal = rt.childAc?.signal;
      expect(childSignal).toBeDefined();
      expect(rt.childView?.sessionId).toBe('child-stop');
      expect(vi.getTimerCount()).toBeGreaterThan(0);

      stream.stop();
      await childOpening;
      expect(childSignal?.aborted).toBe(true);
      expect(rt.childAc).toBeNull();
      expect(rt.childView).toBeNull();
      expect(signals.every((signal) => signal.aborted)).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('discards an overflowing parent replay and opens exactly one fresh snapshot stream', () => {
    const callbacks: ((event: BrainEvent) => void)[] = [];
    const streamSignals: AbortSignal[] = [];
    let historySignal: AbortSignal | undefined;
    const client = {
      stream: (callback: (event: BrainEvent) => void, signal: AbortSignal) => {
        callbacks.push(callback);
        streamSignals.push(signal);
        return new Promise<void>(() => {});
      },
      history: (_session?: string, signal?: AbortSignal) => {
        historySignal = signal;
        return new Promise<never>(() => {});
      },
      rebind: () => {},
    } as unknown as BrainClient;
    const rt = runtime();
    const stream = new StreamCoordinator(
      rt, { client }, actions(), flows,
      new SnapshotHydrator<BrainEvent>(), new HydrationNoticeOwner(),
    );
    stream.openStream(rt.streamAc);
    callbacks[0]!({ type: 'compacted' });
    for (let index = 0; index < 2_049; index += 1) {
      callbacks[0]!({ type: 'tool', id: `tool-${index}`, name: 'Read' });
    }

    expect(callbacks).toHaveLength(2);
    expect(streamSignals[0]?.aborted).toBe(true);
    expect(historySignal?.aborted).toBe(true);
    expect(turns(rt.transcript)).toEqual([]);
    stream.stop();
  });

  it('rebinds a rollover immediately during hydration and preserves it across a newer compaction boundary', async () => {
    const firstHistory = deferred<Response>();
    const secondHistory = deferred<Response>();
    const historyUrls: string[] = [];
    const sent: Record<string, unknown>[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/brain/start')) return new Response(JSON.stringify({ sessionId: 'old' }), { status: 201 });
      if (url.includes('/brain/messages')) {
        historyUrls.push(url);
        return historyUrls.length === 1 ? firstHistory.promise : secondHistory.promise;
      }
      if (url.endsWith('/brain/send')) {
        sent.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(JSON.stringify({ ok: true }), { status: 202 });
      }
      return new Response(JSON.stringify([]), { status: 200 });
    }) as unknown as typeof fetch;
    const client = new BrainClient({ base: 'http://x', token: 't', fetchImpl, clientId: 'cli-rollover' });
    await client.start({ session: 'old' });
    let onFrame!: (event: BrainEvent) => void;
    (client as unknown as { stream(callback: (event: BrainEvent) => void, signal: AbortSignal): Promise<void> }).stream =
      async (callback) => { onFrame = callback; };
    const rebind = vi.spyOn(client, 'rebind');
    const rt = runtime();
    const invalidateAsyncState = vi.fn();
    const stream = new StreamCoordinator(
      rt, { client }, actions({ invalidateAsyncState }), flows,
      new SnapshotHydrator<BrainEvent>(), new HydrationNoticeOwner(),
    );
    stream.openStream(rt.streamAc);

    onFrame({ type: 'compacted' });
    onFrame({ type: 'session', sessionId: 'fresh' });
    expect(client.boundSession).toBe('fresh');
    expect(rebind).toHaveBeenCalledTimes(1);
    expect(rebind).toHaveBeenCalledWith('fresh');
    expect(invalidateAsyncState).toHaveBeenCalledTimes(1);
    onFrame({ type: 'compacted' });
    secondHistory.resolve(new Response(JSON.stringify([{ role: 'assistant', text: 'fresh durable history' }]), { status: 200 }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(historyUrls).toEqual([
      'http://x/brain/messages?session=old',
      'http://x/brain/messages?session=fresh',
    ]);
    expect(serialized(rt.transcript)).toContain('fresh durable history');
    await client.send('future turn');
    expect(sent.at(-1)).toMatchObject({ session: 'fresh', text: 'future turn' });

    firstHistory.resolve(new Response(JSON.stringify([{ role: 'assistant', text: 'stale old history' }]), { status: 200 }));
    await Promise.resolve();
    expect(serialized(rt.transcript)).not.toContain('stale old history');
    expect(rebind).toHaveBeenCalledTimes(1);
    stream.stop();
  });

  it('clears an owned boot timeout after a successful snapshot without removing a keymap warning', async () => {
    vi.useFakeTimers();
    try {
      let onFrame!: (event: BrainEvent | { type: 'snapshot'; cursor: number; history: { role: string; text: string }[]; events: BrainEvent[] }) => void;
      const client = {
        history: () => new Promise<never>(() => {}),
        stream: (callback: typeof onFrame, signal: AbortSignal) => {
          onFrame = callback;
          return new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
        },
        rebind: () => {},
      } as unknown as BrainClient;
      const hydrator = new SnapshotHydrator<BrainEvent>();
      const bootLifecycle = new AbortController();
      const bootLoading = loadInitialTranscript(client, hydrator, bootLifecycle.signal);
      await vi.advanceTimersByTimeAsync(10_000);
      const boot = await bootLoading;
      const keymapWarning = '\u001b[33mkeybinds: invalid ctrl+x\u001b[39m';
      const notices = new HydrationNoticeOwner({ base: keymapWarning, parent: boot.notice });
      const rt = runtime();
      rt.notice = notices.render();
      const stream = new StreamCoordinator(rt, { client }, actions(), flows, hydrator, notices);
      stream.openStream(rt.streamAc);

      expect(rt.notice).toContain('timed out');
      expect(rt.notice).toContain(keymapWarning);
      onFrame({
        type: 'snapshot', cursor: 1,
        history: [{ role: 'assistant', text: 'recovered transcript' }], events: [],
      });

      expect(rt.notice).toBe(keymapWarning);
      expect(rt.notice).not.toContain('timed out');
      expect(serialized(rt.transcript)).toContain('recovered transcript');
      stream.stop();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('StreamCoordinator — parent snapshot hydration', () => {
  it('replaces goal state from the authoritative reconnect snapshot, including explicit null', () => {
    let onFrame!: (frame: BrainEvent | {
      type: 'snapshot'; cursor: number; history: []; events: BrainEvent[]; goal?: typeof activeGoal | null;
    }) => void;
    const activeGoal = {
      session_id: 'brain-1', user_id: 1, status: 'active' as const, goal: 'Reconnect safely',
      draft: '', subgoals: '[]', turns_used: 1, turn_budget: 8, last_verdict: 'continue',
      last_evidence: '', paused_reason: '',
      created_at: '2026-07-12 10:00:00', updated_at: '2026-07-12 10:00:01',
    };
    const client = {
      stream: (cb: typeof onFrame, signal: AbortSignal) => {
        onFrame = cb;
        return new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
      },
      rebind: () => {},
    } as unknown as BrainClient;
    const rt = state([], { goal: activeGoal, workMode: 'build' });
    const stream = new StreamCoordinator(
      rt, { client }, actions(),
      { launchAsk: () => {}, openPlanDecision: () => {} } as unknown as Flows,
      new SnapshotHydrator<BrainEvent>(), new HydrationNoticeOwner(),
    );
    stream.openStream(rt.streamAc);

    onFrame({ type: 'snapshot', cursor: 1, history: [], events: [], goal: null });
    expect(rt.goal).toBeNull();
    onFrame({ type: 'snapshot', cursor: 2, history: [], events: [], goal: activeGoal });
    expect(rt.goal).toEqual(activeGoal);
    stream.stop();
  });

  it('replaces a stale parent view on reconnect and ignores an older history refetch', async () => {
    let onFrame!: (event: BrainEvent | { type: 'snapshot'; cursor: number; history: { role: string; text: string }[]; events: BrainEvent[] }) => void;
    const staleHistory = deferred<{ role: string; text: string }[]>();
    const streamArgs: unknown[][] = [];
    const client = {
      stream: (cb: typeof onFrame, signal: AbortSignal, ...args: unknown[]) => {
        onFrame = cb;
        streamArgs.push(args);
        return new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
      },
      history: () => staleHistory.promise,
      rebind: () => {},
    } as unknown as BrainClient;
    const ac = new AbortController();
    const rt = state([{ role: 'assistant', text: 'stale on-screen output' }], {
      conversationTitle: 'seeded', workMode: 'build',
    });
    rt.streamAc = ac;
    const stream = new StreamCoordinator(
      rt, { client }, actions(),
      { launchAsk: () => {}, openPlanDecision: () => {} } as unknown as Flows,
      new SnapshotHydrator<BrainEvent>(), new HydrationNoticeOwner(),
    );
    stream.openStream(ac);

    // Start an ordinary compaction refetch, then let a reconnect snapshot arrive before that GET settles.
    onFrame({ type: 'compacted' });
    const snapshot = {
      type: 'snapshot' as const,
      cursor: 8,
      history: [{ role: 'user', text: 'stored question' }, { role: 'assistant', text: 'stored answer' }],
      events: [{ type: 'user' as const, text: 'live question' }, { type: 'text' as const, delta: 'live tail' }, { type: 'idle' as const }],
    };
    onFrame(snapshot);
    staleHistory.resolve([{ role: 'assistant', text: 'old refetch must not win' }]);
    await new Promise((resolve) => setTimeout(resolve, 0));

    // The sixth argument is the snapshot opt-in; it is present on the parent stream, not only drill-ins.
    expect(streamArgs[0]?.at(-1)).toBe(true);
    let transcriptJson = serialized(rt.transcript);
    expect(transcriptJson).toContain('stored answer');
    expect(transcriptJson).toContain('live tail');
    expect(transcriptJson).not.toContain('stale on-screen output');
    expect(transcriptJson).not.toContain('old refetch must not win');

    // A later reconnect sends the same complete replacement, never an append of its final text.
    onFrame(snapshot);
    transcriptJson = serialized(rt.transcript);
    expect(transcriptJson.match(/stored answer/g)).toHaveLength(1);
    expect(transcriptJson.match(/live tail/g)).toHaveLength(1);
    ac.abort();
  });

  it('repairs a truncated replay from durable history as soon as its terminal idle arrives', async () => {
    let onFrame!: (event: BrainEvent | { type: 'snapshot'; cursor: number; history: { id?: string; role: string; text: string }[]; events: BrainEvent[]; truncated?: true }) => void;
    const history = vi.fn(async () => [
      { id: 'u-fresh', role: 'user', text: 'question' },
      { id: 'a-fresh', role: 'assistant', text: 'complete durable reply' },
    ]);
    const client = {
      stream: (cb: typeof onFrame, signal: AbortSignal) => {
        onFrame = cb;
        return new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
      },
      history,
      rebind: () => {},
    } as unknown as BrainClient;
    const ac = new AbortController();
    const rt = state([{ role: 'assistant', text: 'old screen' }], { workMode: 'build' });
    rt.streamAc = ac;
    const stream = new StreamCoordinator(
      rt, { client }, actions(),
      { launchAsk: () => {}, openPlanDecision: () => {} } as unknown as Flows,
      new SnapshotHydrator<BrainEvent>(), new HydrationNoticeOwner(),
    );
    stream.openStream(ac);

    onFrame({
      type: 'snapshot', cursor: 90, truncated: true,
      history: [{ id: 'u-old', role: 'user', text: 'question' }],
      events: [{ type: 'text', delta: 'only surviving live suffix' }],
    });
    onFrame({ type: 'idle' });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(history).toHaveBeenCalledTimes(1);
    const rendered = serialized(rt.transcript);
    expect(rendered).toContain('complete durable reply');
    expect(rendered).not.toContain('only surviving live suffix');
    ac.abort();
  });
  it('arms the long-turn poll on a parent step and signals settle on idle', async () => {
    let onFrame!: (event: BrainEvent) => void;
    const client = {
      stream: (cb: typeof onFrame, signal: AbortSignal) => {
        onFrame = cb;
        return new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
      },
      history: vi.fn(async () => []),
      rebind: () => {},
    } as unknown as BrainClient;
    const ac = new AbortController();
    const rt = state([{ role: 'assistant', text: 'hi' }], { workMode: 'build' });
    rt.conversationTitle = 'titled'; // skip the first-turn refreshMeta title branch
    rt.streamAc = ac;
    const onTurnActive = vi.fn();
    const onTurnSettled = vi.fn();
    const stream = new StreamCoordinator(
      rt, { client }, actions({ onTurnActive, onTurnSettled }),
      { launchAsk: () => {}, openPlanDecision: () => {} } as unknown as Flows,
      new SnapshotHydrator<BrainEvent>(), new HydrationNoticeOwner(),
    );
    stream.openStream(ac);

    onFrame({ type: 'step', step: 1, maxSteps: 0 });
    expect(onTurnActive).toHaveBeenCalledTimes(1);
    expect(onTurnSettled).not.toHaveBeenCalled();

    onFrame({ type: 'idle', model: 'm' });
    expect(onTurnSettled).toHaveBeenCalledTimes(1);
    ac.abort();
  });
});

describe('StreamCoordinator — concurrent parent switches', () => {
  it('keeps B bound, rendered and streamed when the older A start response arrives last', async () => {
    const a = deferred<Response>();
    const b = deferred<Response>();
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { session?: string };
      return body.session === 'A' ? a.promise : b.promise;
    }) as typeof fetch;
    const client = new BrainClient({ base: 'http://x', token: 't', fetchImpl, clientId: 'cli-a' });
    const streamSignals: AbortSignal[] = [];
    (client as unknown as { history: (session?: string) => Promise<{ role: 'assistant'; text: string }[]> }).history =
      async (session) => [{ role: 'assistant', text: `history-${session}` }];
    (client as unknown as {
      stream: (onEvent: (event: BrainEvent) => void, signal: AbortSignal) => Promise<void>;
    }).stream = async (_onEvent, signal) => { streamSignals.push(signal); };

    const rt = state([], { workMode: 'build' });
    const flows = { launchAsk: () => {}, openPlanDecision: () => {} } as unknown as Flows;
    const stream = new StreamCoordinator(
      rt, { client }, actions(), flows,
      new SnapshotHydrator<BrainEvent>(), new HydrationNoticeOwner(),
    );

    const switchA = stream.switchTo({ session: 'A' });
    const aSignal = rt.streamAc.signal;
    const switchB = stream.switchTo({ session: 'B' });
    b.resolve(new Response(JSON.stringify({ sessionId: 'B' }), { status: 201 }));
    await switchB;
    a.resolve(new Response(JSON.stringify({ sessionId: 'A' }), { status: 201 }));
    await switchA;

    expect(client.boundSession).toBe('B');
    expect(serialized(rt.transcript)).toContain('history-B');
    expect(serialized(rt.transcript)).not.toContain('history-A');
    expect(aSignal.aborted).toBe(true);
    expect(streamSignals).toEqual([rt.streamAc.signal]);
  });

  it('keeps child navigation fenced until the latest switch commits', async () => {
    const starts = new Map([
      ['A', deferred<{ sessionId: string }>()],
      ['B', deferred<{ sessionId: string }>()],
    ]);
    const childStreams: string[] = [];
    const client = {
      start: ({ session }: { session?: string }) => starts.get(session ?? '')!.promise,
      history: async (session?: string) => [{ role: 'assistant', text: `history-${session}` }],
      stream: (
        callback: (frame: { type: 'snapshot'; cursor: number; history: { role: string; text: string }[]; events: BrainEvent[] }) => void,
        signal: AbortSignal,
        _backoff: number,
        _open?: () => void,
        session?: string,
      ) => {
        if (session) {
          childStreams.push(session);
          callback({
            type: 'snapshot', cursor: 1,
            history: [{ role: 'assistant', text: `history-${session}` }], events: [],
          });
        }
        return new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
      },
      rebind: () => {},
    } as unknown as BrainClient;
    const rt = state([], { workMode: 'build' });
    rt.transcript.apply({ type: 'tool', id: 'delegate-old', name: 'Delegate', detail: 'old child' });
    rt.transcript.apply({
      type: 'subagent', id: 'delegate-old', sessionId: 'old-child', status: 'running',
      task: 'old child', detail: 'working', tools: 1, seconds: 1,
    });
    const stream = new StreamCoordinator(
      rt, { client }, actions(),
      { launchAsk: () => {}, openPlanDecision: () => {} } as unknown as Flows,
      new SnapshotHydrator<BrainEvent>(), new HydrationNoticeOwner(),
    );

    const switchA = stream.switchTo({ session: 'A' });
    await Promise.resolve();
    await stream.openSubagent('old-child-during-A');
    const switchB = stream.switchTo({ session: 'B' });
    await Promise.resolve();
    stream.cycleSubagent();
    await stream.openSubagent('old-child-during-B');
    expect(childStreams).toEqual([]);
    expect(rt.childView).toBeNull();

    starts.get('B')!.resolve({ sessionId: 'B' });
    await switchB;
    expect(serialized(rt.transcript)).toContain('history-B');
    expect(rt.childView).toBeNull();

    await stream.openSubagent('B-child');
    expect(childStreams).toEqual(['B-child']);
    expect(rt.childView?.sessionId).toBe('B-child');

    starts.get('A')!.resolve({ sessionId: 'A' });
    await switchA;
    expect(rt.childView?.sessionId).toBe('B-child');
    expect(serialized(rt.childView?.transcript)).toContain('history-B-child');
    expect(serialized(rt.transcript)).not.toContain('history-A');
    stream.stop();
  });
});

describe('StreamCoordinator — cached sub-agent projection', () => {
  it('reuses the same projection across repeated frames instead of rescanning the transcript', () => {
    const rt = state();
    rt.transcript.apply({ type: 'tool', id: 'delegate-1', name: 'Delegate', detail: 'inspect tests' });
    rt.transcript.apply({
      type: 'subagent', id: 'delegate-1', sessionId: 'child-1', status: 'running',
      task: 'inspect tests', detail: 'reading', tools: 2, seconds: 3,
    });
    const client = {} as BrainClient;
    const controller = new StreamCoordinator(
      rt, { client }, actions(),
      { launchAsk: () => {}, openPlanDecision: () => {} } as unknown as Flows,
      new SnapshotHydrator<BrainEvent>(), new HydrationNoticeOwner(),
    );
    const first = controller.subagentStates();
    expect(first).toHaveLength(1);
    expect(controller.subagentStates()).toBe(first);

    rt.transcript.apply({ type: 'text', delta: 'unrelated parent token' });
    expect(controller.subagentStates()).toBe(first);
  });

  it('cycles parent to each child and back without replacing the parent transcript', () => {
    const rt = state();
    for (const index of [1, 2]) {
      rt.transcript.apply({ type: 'tool', id: `delegate-${index}`, name: 'Delegate', detail: `child ${index}` });
      rt.transcript.apply({
        type: 'subagent', id: `delegate-${index}`, sessionId: `child-${index}`, status: 'running',
        task: `child ${index}`, tools: index, seconds: index,
      });
    }
    const client = {
      stream: (
        onFrame: (frame: { type: 'snapshot'; cursor: number; history: { role: string; text: string }[]; events: BrainEvent[] }) => void,
        signal: AbortSignal,
        _backoff: number,
        _onOpen: (() => void) | undefined,
        session: string,
      ) => {
        onFrame({
          type: 'snapshot', cursor: 1,
          history: [{ role: 'assistant', text: `transcript ${session}` }], events: [],
        });
        return new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
      },
      history: () => Promise.resolve([]),
    } as unknown as BrainClient;
    const parentTranscript = rt.transcript;
    const controller = new StreamCoordinator(
      rt, { client }, actions(),
      { launchAsk: () => {}, openPlanDecision: () => {} } as unknown as Flows,
      new SnapshotHydrator<BrainEvent>(), new HydrationNoticeOwner(),
    );

    controller.cycleSubagent();
    expect(rt.childView?.sessionId).toBe('child-1');
    expect(serialized(rt.childView?.transcript)).toContain('transcript child-1');
    controller.cycleSubagent();
    expect(rt.childView?.sessionId).toBe('child-2');
    expect(serialized(rt.childView?.transcript)).toContain('transcript child-2');
    controller.cycleSubagent();
    expect(rt.childView).toBeNull();
    expect(rt.transcript).toBe(parentTranscript);
  });
});

describe('StreamCoordinator — sub-agent drill-in hydration', () => {
  const runtime = (): ChatState => state([], { conversationTitle: 'parent', workMode: 'build' });
  const flows = { launchAsk: () => {}, openPlanDecision: () => {} } as unknown as Flows;

  it('cancels the fallback timer when a pending child drill-in is closed', async () => {
    vi.useFakeTimers();
    try {
      const history = vi.fn(() => Promise.resolve([]));
      const client = {
        stream: (_cb: (event: BrainEvent) => void, signal: AbortSignal) =>
          new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true })),
        history,
      } as unknown as BrainClient;
      const rt = runtime();
      const stream = new StreamCoordinator(
        rt, { client }, actions(), flows,
        new SnapshotHydrator<BrainEvent>(), new HydrationNoticeOwner(),
      );

      const opening = stream.openSubagent('child-pending');
      expect(vi.getTimerCount()).toBe(1);
      stream.closeSubagent();
      await opening;

      expect(vi.getTimerCount()).toBe(0);
      await vi.runAllTimersAsync();
      expect(history).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('hydrates from the atomic durable + pre-tap live snapshot', async () => {
    const order: string[] = [];
    const client = {
      stream: (
        cb: (event: BrainEvent | { type: 'snapshot'; cursor: number; history: { role: string; text: string }[]; events: BrainEvent[] }) => void,
        signal: AbortSignal,
        _backoff: number,
        _onOpen: (() => void) | undefined,
        session: string | undefined,
        snapshot: boolean | undefined,
      ) => {
        order.push(`stream:${session}:${snapshot}`);
        cb({
          type: 'snapshot', cursor: 4,
          history: [{ role: 'assistant', text: 'stored before tap' }],
          events: [{ type: 'text', delta: 'live before tap' }],
        });
        return new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
      },
      history: (session: string) => { order.push(`history:${session}`); return Promise.resolve([]); },
    } as unknown as BrainClient;
    const rt = runtime();
    const stream = new StreamCoordinator(
      rt, { client }, actions(), flows,
      new SnapshotHydrator<BrainEvent>(), new HydrationNoticeOwner(),
    );

    const opening = stream.openSubagent('child-a');
    expect(order).toEqual(['stream:child-a:true']);
    expect(rt.childView?.sessionId).toBe('child-a');
    await opening;

    expect(rt.childView?.loading).toBe(false);
    expect(serialized(rt.childView?.transcript)).toContain('stored before tap');
    expect(serialized(rt.childView?.transcript)).toContain('live before tap');
    expect(order.some((entry) => entry.startsWith('history:'))).toBe(false);
    stream.closeSubagent();
  });

  it('does not let a late child A snapshot overwrite a newer child B selection', async () => {
    const callbacks = new Map<string, (event: { type: 'snapshot'; cursor: number; history: { role: string; text: string }[]; events: BrainEvent[] }) => void>();
    const client = {
      stream: (
        cb: (event: never) => void,
        signal: AbortSignal,
        _backoff: number,
        _onOpen: (() => void) | undefined,
        session: string,
      ) => {
        callbacks.set(session, cb as never);
        return new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
      },
      history: () => Promise.resolve([]),
    } as unknown as BrainClient;
    const rt = runtime();
    const stream = new StreamCoordinator(
      rt, { client }, actions(), flows,
      new SnapshotHydrator<BrainEvent>(), new HydrationNoticeOwner(),
    );

    const openingA = stream.openSubagent('child-a');
    const openingB = stream.openSubagent('child-b');
    callbacks.get('child-b')?.({ type: 'snapshot', cursor: 2, history: [{ role: 'assistant', text: 'answer B' }], events: [] });
    await openingB;
    callbacks.get('child-a')?.({ type: 'snapshot', cursor: 1, history: [{ role: 'assistant', text: 'late answer A' }], events: [] });
    await openingA;

    expect(rt.childView?.sessionId).toBe('child-b');
    expect(serialized(rt.childView?.transcript)).toContain('answer B');
    expect(serialized(rt.childView?.transcript)).not.toContain('late answer A');
    stream.closeSubagent();
  });

  it('replaces the child view on reconnect snapshots instead of duplicating final text', async () => {
    let onChildEvent!: (event: BrainEvent | { type: 'snapshot'; cursor: number; history: { role: string; text: string }[]; events: BrainEvent[] }) => void;
    const client = {
      stream: (
        cb: typeof onChildEvent,
        signal: AbortSignal,
        _backoff: number,
      ) => {
        onChildEvent = cb;
        cb({ type: 'snapshot', cursor: 3, history: [{ role: 'assistant', text: 'persisted final' }], events: [{ type: 'idle' }] });
        return new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
      },
      history: () => Promise.resolve([]),
    } as unknown as BrainClient;
    const rt = runtime();
    const stream = new StreamCoordinator(
      rt, { client }, actions(), flows,
      new SnapshotHydrator<BrainEvent>(), new HydrationNoticeOwner(),
    );

    const opening = stream.openSubagent('child-settled');
    await opening;
    // The same stream reconnects and receives a fresh replace-in-place snapshot.
    onChildEvent({ type: 'snapshot', cursor: 4, history: [{ role: 'assistant', text: 'persisted final' }], events: [{ type: 'idle' }] });

    const transcriptJson = serialized(rt.childView?.transcript);
    expect(transcriptJson.match(/persisted final/g)).toHaveLength(1);
    stream.closeSubagent();
  });

  it('falls back to stored history when the snapshot stream fails before its first frame', async () => {
    const client = {
      stream: () => Promise.reject(new Error('offline')),
      history: () => Promise.resolve([{ role: 'assistant', text: 'fallback history' }]),
    } as unknown as BrainClient;
    const rt = runtime();
    const stream = new StreamCoordinator(
      rt, { client }, actions(), flows,
      new SnapshotHydrator<BrainEvent>(), new HydrationNoticeOwner(),
    );
    await stream.openSubagent('child-fallback');
    expect(serialized(rt.childView?.transcript)).toContain('fallback history');
    stream.closeSubagent();
  });

  it('refetches settled child fallback history and does not duplicate the buffered terminal run', async () => {
    const history = vi.fn(async () => [{ role: 'assistant', text: 'complete fallback answer' }]);
    const client = {
      stream: (callback: (event: BrainEvent) => void) => {
        callback({ type: 'text', delta: 'complete fallback answer' });
        callback({ type: 'idle' });
        return Promise.reject(new Error('snapshot unavailable'));
      },
      history,
    } as unknown as BrainClient;
    const rt = runtime();
    const stream = new StreamCoordinator(
      rt, { client }, actions(), flows,
      new SnapshotHydrator<BrainEvent>(), new HydrationNoticeOwner(),
    );

    await stream.openSubagent('child-settled-fallback');

    expect(history).toHaveBeenCalledTimes(2);
    expect(serialized(rt.childView?.transcript).match(/complete fallback answer/g)).toHaveLength(1);
    stream.closeSubagent();
  });

  it('repairs a truncated child snapshot from durable history at its terminal boundary', async () => {
    let onFrame!: (event: BrainEvent | { type: 'snapshot'; cursor: number; truncated?: true; history: { role: string; text: string }[]; events: BrainEvent[] }) => void;
    const history = vi.fn(async () => [{ role: 'assistant', text: 'complete durable child' }]);
    const client = {
      stream: (callback: typeof onFrame, signal: AbortSignal) => {
        onFrame = callback;
        callback({
          type: 'snapshot', cursor: 1, truncated: true, history: [],
          events: [{ type: 'text', delta: 'partial child suffix' }],
        });
        return new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
      },
      history,
    } as unknown as BrainClient;
    const rt = runtime();
    const stream = new StreamCoordinator(
      rt, { client }, actions(), flows,
      new SnapshotHydrator<BrainEvent>(), new HydrationNoticeOwner(),
    );
    await stream.openSubagent('child-truncated');

    onFrame({ type: 'idle' });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(history).toHaveBeenCalledTimes(1);
    expect(serialized(rt.childView?.transcript)).toContain('complete durable child');
    expect(serialized(rt.childView?.transcript)).not.toContain('partial child suffix');
    stream.closeSubagent();
  });
});
