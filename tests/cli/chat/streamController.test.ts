import { describe, it, expect } from 'vitest';
import { createStreamController } from '../../../src/cli/chat/streamController.js';
import { fromHistory } from '../../../src/brain/transcript.js';
import type { ChatRuntime } from '../../../src/cli/chat/runtime.js';
import type { Flows } from '../../../src/cli/chat/flows.js';
import type { BrainClient } from '../../../src/cli/chat/brainClient.js';
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
});
