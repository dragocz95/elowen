import { describe, it, expect, vi } from 'vitest';
import { createStreamController } from '../../../src/cli/chat/streamController.js';
import { fromHistory } from '../../../src/brain/transcript.js';
import type { ChatRuntime } from '../../../src/cli/chat/runtime.js';
import type { Flows } from '../../../src/cli/chat/flows.js';
import { BrainClient } from '../../../src/cli/chat/brainClient.js';
import type { BrainEvent } from '../../../src/brain/events.js';

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

describe('streamController — idle rollover', () => {
  it('resets to the fresh conversation on `session` and rebuilds from the daemon stream (no refetch)', () => {
    let onEvent!: (e: BrainEvent) => void;
    let historyCalls = 0;
    const client = {
      stream: (cb: (e: BrainEvent) => void) => { onEvent = cb; return Promise.resolve(); },
      history: () => { historyCalls++; return Promise.resolve([]); },
      rebind: () => {},
    } as unknown as BrainClient;

    const ac = new AbortController();
    const rt = {
      client,
      // Prior conversation on screen — no optimistic local 'you' (the daemon is the echo authority now).
      view: fromHistory([{ role: 'user', text: 'yesterday' }, { role: 'assistant', text: 'old answer' }]),
      childView: null,
      streamAc: ac,
      notice: '',
      conversationTitle: 'seeded',
      workMode: 'build',
      render: () => {},
      refreshMeta: async () => {},
    } as unknown as ChatRuntime;
    const flows = { launchAsk: () => {}, openPlanDecision: () => {} } as unknown as Flows;

    const stream = createStreamController(rt, flows);
    stream.openStream(ac);

    // Idle rollover: the server continued this message in a FRESH conversation, then re-emits the
    // triggering message as a `user` event and streams its reply — all in order, no history refetch.
    onEvent({ type: 'session', sessionId: 'fresh-1' });
    expect(rt.view.turns).toEqual([]); // the prior conversation is cleared
    onEvent({ type: 'user', text: 'today' });
    onEvent({ type: 'text', delta: 'streamed after rollover' });

    expect(rt.view.turns[0]).toEqual({ role: 'you', text: 'today' });
    expect(rt.view.turns.some((t) => t.role === 'elowen' && t.segments.some((s) => s.kind === 'text' && s.text.includes('streamed')))).toBe(true);
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
    const rt = {
      client,
      view: fromHistory([{ role: 'user', text: 'q1' }, { role: 'assistant', text: 'long answer' }]),
      childView: null,
      streamAc: ac,
      notice: '',
      conversationTitle: 'seeded',
      workMode: 'build',
      render: () => {},
      refreshMeta: async () => {},
    } as unknown as ChatRuntime;
    const flows = { launchAsk: () => {}, openPlanDecision: () => {} } as unknown as Flows;

    const stream = createStreamController(rt, flows);
    stream.openStream(ac);

    // Auto-compact persisted server-side → `compacted`; the queued-flush turn immediately streams its
    // reply BEFORE the history refetch resolves. That delta must land on the refetched (collapsed) view.
    onEvent({ type: 'compacted' });
    onEvent({ type: 'text', delta: 'flush-turn reply' });

    const hasFlushReply = (): boolean => rt.view.turns.some(
      (t) => t.role === 'elowen' && t.segments.some((s) => s.kind === 'text' && s.text.includes('flush-turn')));
    // Not folded into the stale pre-compaction view (it would be discarded when history lands).
    expect(hasFlushReply()).toBe(false);

    // The collapsed transcript lands (divider + kept tail), then the buffered delta replays onto it.
    hist.resolve([{ role: 'compaction', text: '' }, { role: 'user', text: 'q1' }]);
    await new Promise((r) => setTimeout(r, 0));

    expect(rt.view.turns.some((t) => t.role === 'divider')).toBe(true);
    expect(hasFlushReply()).toBe(true);
  });

  it('a `queue` event replaces rt.queued (full snapshot) without touching the transcript view', () => {
    let onEvent!: (e: BrainEvent) => void;
    const client = {
      stream: (cb: (e: BrainEvent) => void) => { onEvent = cb; return Promise.resolve(); },
      history: () => Promise.resolve([]),
      rebind: () => {},
    } as unknown as BrainClient;
    const ac = new AbortController();
    const rt = {
      client,
      view: fromHistory([{ role: 'assistant', text: 'hi' }]),
      childView: null,
      streamAc: ac,
      notice: '',
      conversationTitle: 'x',
      workMode: 'build',
      queued: [] as { id: string; text: string }[],
      render: () => {},
      refreshMeta: async () => {},
    } as unknown as ChatRuntime;
    const flows = { launchAsk: () => {}, openPlanDecision: () => {} } as unknown as Flows;

    const stream = createStreamController(rt, flows);
    stream.openStream(ac);
    const before = rt.view;

    onEvent({ type: 'queue', items: [{ id: 'q1', text: 'one' }, { id: 'q2', text: 'two' }] });
    expect(rt.queued).toEqual([{ id: 'q1', text: 'one' }, { id: 'q2', text: 'two' }]);
    expect(rt.view).toBe(before); // the ChatView is untouched — the queue is separate client state

    // A later snapshot (e.g. a removal or a drain) replaces wholesale — never a merge.
    onEvent({ type: 'queue', items: [] });
    expect(rt.queued).toEqual([]);
    expect(rt.view).toBe(before);
  });

  it('a `process` event replaces rt.processes (full snapshot) without touching the transcript view', () => {
    let onEvent!: (e: BrainEvent) => void;
    const client = {
      stream: (cb: (e: BrainEvent) => void) => { onEvent = cb; return Promise.resolve(); },
      history: () => Promise.resolve([]),
      rebind: () => {},
    } as unknown as BrainClient;
    const ac = new AbortController();
    const rt = {
      client,
      view: fromHistory([{ role: 'assistant', text: 'hi' }]),
      childView: null,
      streamAc: ac,
      notice: '',
      conversationTitle: 'x',
      workMode: 'build',
      processes: [] as { id: string; command: string; cwd: string; startedAt: string; running: boolean; exitCode: number | null }[],
      render: () => {},
      refreshMeta: async () => {},
    } as unknown as ChatRuntime;
    const flows = { launchAsk: () => {}, openPlanDecision: () => {} } as unknown as Flows;

    const stream = createStreamController(rt, flows);
    stream.openStream(ac);
    const before = rt.view;

    const proc = { id: 'p1', command: 'npm run dev', cwd: '/x', startedAt: '2026-01-01T00:00:00.000Z', running: true, exitCode: null };
    onEvent({ type: 'process', processes: [proc] });
    expect(rt.processes).toEqual([proc]);
    expect(rt.view).toBe(before); // the ChatView is untouched — the process list is separate client state

    // A later snapshot (a kill/exit) replaces wholesale — the killed process just drops off.
    onEvent({ type: 'process', processes: [] });
    expect(rt.processes).toEqual([]);
    expect(rt.view).toBe(before);
  });

  it('a `user` delivery event folds a you-turn into the transcript (the drained queued message)', () => {
    let onEvent!: (e: BrainEvent) => void;
    const client = {
      stream: (cb: (e: BrainEvent) => void) => { onEvent = cb; return Promise.resolve(); },
      history: () => Promise.resolve([]),
      rebind: () => {},
    } as unknown as BrainClient;
    const ac = new AbortController();
    const rt = {
      client,
      view: fromHistory([{ role: 'assistant', text: 'previous reply' }]),
      childView: null,
      streamAc: ac,
      notice: '',
      conversationTitle: 'x',
      workMode: 'build',
      queued: [] as { id: string; text: string }[],
      render: () => {},
      refreshMeta: async () => {},
    } as unknown as ChatRuntime;
    const flows = { launchAsk: () => {}, openPlanDecision: () => {} } as unknown as Flows;

    const stream = createStreamController(rt, flows);
    stream.openStream(ac);

    onEvent({ type: 'user', text: 'combined queued delivery' });
    expect(rt.view.turns.at(-1)).toEqual({ role: 'you', text: 'combined queued delivery' });
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
    const rt = {
      client,
      view: fromHistory([{ role: 'assistant', text: 'new selection stays' }]),
      childView: null,
      streamAc: oldAc,
      notice: '',
      conversationTitle: 'new',
      workMode: 'build',
      render: () => {},
      refreshMeta: async () => {},
      refreshRateLimits: async () => {},
    } as unknown as ChatRuntime;
    const stream = createStreamController(rt, { launchAsk: () => {}, openPlanDecision: () => {} } as unknown as Flows);
    stream.openStream(oldAc);
    rt.streamAc = new AbortController();
    oldAc.abort();

    staleEvent({ type: 'session', sessionId: 'stale-rollover' });
    staleEvent({ type: 'text', delta: 'stale bytes' });
    expect(rebinds).toEqual([]);
    expect(JSON.stringify(rt.view)).toContain('new selection stays');
    expect(JSON.stringify(rt.view)).not.toContain('stale bytes');
  });
});

describe('streamController — parent snapshot hydration', () => {
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
    const rt = {
      client,
      view: fromHistory([{ role: 'assistant', text: 'stale on-screen output' }]),
      childView: null,
      streamAc: ac,
      notice: '',
      conversationTitle: 'seeded',
      workMode: 'build',
      render: () => {},
      refreshMeta: async () => {},
      refreshRateLimits: async () => {},
    } as unknown as ChatRuntime;
    const stream = createStreamController(rt, { launchAsk: () => {}, openPlanDecision: () => {} } as unknown as Flows);
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
    let serialized = JSON.stringify(rt.view);
    expect(serialized).toContain('stored answer');
    expect(serialized).toContain('live tail');
    expect(serialized).not.toContain('stale on-screen output');
    expect(serialized).not.toContain('old refetch must not win');

    // A later reconnect sends the same complete replacement, never an append of its final text.
    onFrame(snapshot);
    serialized = JSON.stringify(rt.view);
    expect(serialized.match(/stored answer/g)).toHaveLength(1);
    expect(serialized.match(/live tail/g)).toHaveLength(1);
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
    const rt = {
      client, view: fromHistory([{ role: 'assistant', text: 'old screen' }]), childView: null,
      streamAc: ac, notice: '', conversationTitle: '', workMode: 'build', render: () => {},
      refreshMeta: async () => {}, refreshRateLimits: async () => {},
    } as unknown as ChatRuntime;
    const stream = createStreamController(rt, { launchAsk: () => {}, openPlanDecision: () => {} } as unknown as Flows);
    stream.openStream(ac);

    onFrame({
      type: 'snapshot', cursor: 90, truncated: true,
      history: [{ id: 'u-old', role: 'user', text: 'question' }],
      events: [{ type: 'text', delta: 'only surviving live suffix' }],
    });
    onFrame({ type: 'idle' });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(history).toHaveBeenCalledTimes(1);
    const rendered = JSON.stringify(rt.view);
    expect(rendered).toContain('complete durable reply');
    expect(rendered).not.toContain('only surviving live suffix');
    ac.abort();
  });
});

describe('streamController — concurrent parent switches', () => {
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

    const rt = {
      client,
      view: fromHistory([]),
      childView: null,
      streamAc: new AbortController(),
      notice: '',
      conversationTitle: '',
      workMode: 'build',
      render: () => {},
      refreshMeta: async () => {},
      refreshRateLimits: async () => {},
    } as unknown as ChatRuntime;
    const flows = { launchAsk: () => {}, openPlanDecision: () => {} } as unknown as Flows;
    const stream = createStreamController(rt, flows);

    const switchA = stream.switchTo({ session: 'A' });
    const aSignal = rt.streamAc.signal;
    const switchB = stream.switchTo({ session: 'B' });
    b.resolve(new Response(JSON.stringify({ sessionId: 'B' }), { status: 201 }));
    await switchB;
    a.resolve(new Response(JSON.stringify({ sessionId: 'A' }), { status: 201 }));
    await switchA;

    expect(client.boundSession).toBe('B');
    expect(JSON.stringify(rt.view)).toContain('history-B');
    expect(JSON.stringify(rt.view)).not.toContain('history-A');
    expect(aSignal.aborted).toBe(true);
    expect(streamSignals).toEqual([rt.streamAc.signal]);
  });
});

describe('streamController — sub-agent drill-in hydration', () => {
  const runtime = (client: BrainClient): ChatRuntime => ({
    client,
    view: fromHistory([]),
    childView: null,
    childAc: null,
    streamAc: new AbortController(),
    notice: '',
    conversationTitle: 'parent',
    workMode: 'build',
    render: () => {},
    refreshMeta: async () => {},
    refreshRateLimits: async () => {},
  } as unknown as ChatRuntime);
  const flows = { launchAsk: () => {}, openPlanDecision: () => {} } as unknown as Flows;

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
    const rt = runtime(client);
    const stream = createStreamController(rt, flows);

    const opening = stream.openSubagent('child-a');
    expect(order).toEqual(['stream:child-a:true']);
    expect(rt.childView?.sessionId).toBe('child-a');
    await opening;

    expect(rt.childView?.loading).toBe(false);
    expect(JSON.stringify(rt.childView?.view)).toContain('stored before tap');
    expect(JSON.stringify(rt.childView?.view)).toContain('live before tap');
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
    const rt = runtime(client);
    const stream = createStreamController(rt, flows);

    const openingA = stream.openSubagent('child-a');
    const openingB = stream.openSubagent('child-b');
    callbacks.get('child-b')?.({ type: 'snapshot', cursor: 2, history: [{ role: 'assistant', text: 'answer B' }], events: [] });
    await openingB;
    callbacks.get('child-a')?.({ type: 'snapshot', cursor: 1, history: [{ role: 'assistant', text: 'late answer A' }], events: [] });
    await openingA;

    expect(rt.childView?.sessionId).toBe('child-b');
    expect(JSON.stringify(rt.childView?.view)).toContain('answer B');
    expect(JSON.stringify(rt.childView?.view)).not.toContain('late answer A');
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
    const rt = runtime(client);
    const stream = createStreamController(rt, flows);

    const opening = stream.openSubagent('child-settled');
    await opening;
    // The same stream reconnects and receives a fresh replace-in-place snapshot.
    onChildEvent({ type: 'snapshot', cursor: 4, history: [{ role: 'assistant', text: 'persisted final' }], events: [{ type: 'idle' }] });

    const serialized = JSON.stringify(rt.childView?.view);
    expect(serialized.match(/persisted final/g)).toHaveLength(1);
    stream.closeSubagent();
  });

  it('falls back to stored history when the snapshot stream fails before its first frame', async () => {
    const client = {
      stream: () => Promise.reject(new Error('offline')),
      history: () => Promise.resolve([{ role: 'assistant', text: 'fallback history' }]),
    } as unknown as BrainClient;
    const rt = runtime(client);
    const stream = createStreamController(rt, flows);
    await stream.openSubagent('child-fallback');
    expect(JSON.stringify(rt.childView?.view)).toContain('fallback history');
    stream.closeSubagent();
  });
});
