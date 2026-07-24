import { beforeAll, describe, it, expect, vi } from 'vitest';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { BrainService } from '../../src/brain/brainService.js';
import { openDb } from '../../src/store/db.js';
import { BrainStore } from '../../src/store/brainStore.js';
import { inMemoryModelRuntime } from '../../src/brain/providers.js';
import type { BrainEvent } from '../../src/brain/events.js';

// Fáze 0, Invariant 2 — the multi-client abort/detach contract.
//
// Two intents must never be conflated:
//   - EXPLICIT STOP (Esc / web Stop button) → POST /brain/abort → BrainService.abort() → abort for ALL
//     watchers of the shared turn. This is correct today and unchanged.
//   - TRANSPORT DETACH (a CLI quits, a tab closes) → POST /brain/session/stop → BrainService.stopSession()
//     → detach THIS client only; abort + dispose the live turn ONLY when it was the LAST watcher.
//
// The load-bearing invariant these tests encode: while ANOTHER client stream is still attached, a
// stopSession from one client MUST NOT abort the shared turn (the other client keeps streaming), and it
// must not cancel the goal/parked-ask that the remaining watcher still owns. `stopSession`'s inner
// `cleanUp` gates the abort/dispose on the last-watcher branch (`attachedCount === 0`), so a non-last
// stop leaves the shared turn — and the remaining watcher's goal/parked-ask — untouched.

let sharedRuntime: ModelRuntime;
beforeAll(async () => { sharedRuntime = await inMemoryModelRuntime(); });

// The same harness shape brainService.test.ts uses: a single fake PI session whose prompt() drives one
// synchronous turn, abort()/dispose() are spies, and `emit` fans a raw PI event through everything the
// spawner subscribed so attached client streams (subscribe + tapSession) observe the mapped BrainEvents.
function fakeDeps() {
  const listeners: ((e: unknown) => void)[] = [];
  const messages: { role: string; content: string }[] = [];
  const session = {
    sessionId: 'sess-1',
    prompt: vi.fn(async (t: string, options?: { preflightResult?: (success: boolean) => void }) => {
      options?.preflightResult?.(true);
      messages.push({ role: 'user', content: t }, { role: 'assistant', content: `echo:${t}` });
      listeners.forEach((l) => l({ type: 'agent_end', willRetry: false, messages: [{ role: 'assistant', content: `echo:${t}` }] }));
    }),
    subscribe: (l: (e: unknown) => void) => { listeners.push(l); return () => {}; },
    setModel: vi.fn(), dispose: vi.fn(), abort: vi.fn(async () => {}),
    sendCustomMessage: vi.fn(async () => {}),
    abortCompaction: vi.fn(), abortBranchSummary: vi.fn(), messages, isStreaming: false,
    _checkCompaction: vi.fn(async () => false),
    __queue: [] as string[],
    __emitQueue: () => listeners.forEach((l) => l({ type: 'queue_update', steering: session.__queue.slice(), followUp: [] })),
    steer: vi.fn(async (t: string) => { session.__queue.push(t); session.__emitQueue(); }),
    getSteeringMessages: () => session.__queue,
    getFollowUpMessages: () => [] as string[],
    get pendingMessageCount() { return session.__queue.length; },
    clearQueue: vi.fn(() => { const s = session.__queue.slice(); session.__queue.length = 0; session.__emitQueue(); return { steering: s, followUp: [] }; }),
    __contextUsage: undefined as { tokens: number; contextWindow: number; percent: number } | undefined,
    getContextUsage(this: { __contextUsage?: { tokens: number; contextWindow: number; percent: number } }) { return this.__contextUsage; },
    compact: vi.fn(async () => {}),
    __tools: [] as { name: string }[],
    __active: [] as string[],
    getAllTools(this: { __tools: { name: string }[] }) { return this.__tools; },
    getActiveToolNames(this: { __active: string[] }) { return this.__active; },
    setActiveToolsByName: vi.fn(function (this: { __active: string[] }, names: string[]) { this.__active = names; }),
    model: undefined as unknown,
    agent: { streamFunction: vi.fn() },
    thinkingLevel: '' as string,
    supportsThinking: () => true,
    getAvailableThinkingLevels: () => ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
    setThinkingLevel: vi.fn(function (this: { thinkingLevel: string }, l: string) { session.thinkingLevel = l; }),
  };
  const createSession = vi.fn(async (opts: { customTools?: { name: string }[]; model?: unknown }) => {
    session.__tools = opts.customTools ?? [];
    session.__active = session.__tools.map((t) => t.name);
    session.model = opts.model;
    return { session };
  });
  return {
    emit: (e: unknown) => listeners.forEach((l) => l(e)),
    store: new BrainStore(openDb(':memory:')),
    runtime: sharedRuntime,
    users: { ensureAdvisorToken: () => 'full-token', get: () => ({ name: 'Filip', username: 'filip' }) },
    config: { providers: [{ id: 'relay', label: 'Relay', type: 'openai' as const, baseUrl: 'http://x/v1', models: ['m'], apiKey: 'k' }] },
    prompts: { render: vi.fn((name: string, vars: Record<string, string>) => `PERSONA:${name}:${vars.userName}`) },
    url: 'http://x',
    createSession,
    resourceLoaderFactory: () => undefined,
    session,
  };
}

/** Live attachment count straight off the internal registry — bypasses the "spoken-in only" filter that
 *  listSessions applies, so it is truthful even for a conversation nobody has typed into yet. */
const attached = (svc: BrainService, sessionId: string): number =>
  (svc as unknown as { attachments: { attachedCount(id: string): number } }).attachments.attachedCount(sessionId);

/** Reach the private ElicitationRegistry to park a real ask on a session (mirrors the switch-away tests
 *  in brainService.test.ts). A parked ask that survives a non-last stop proves the goal/ask of the
 *  remaining watcher was NOT cancelled. */
type ElicitationInternals = {
  elicitation: {
    ask: (sessionId: string, questions: { question: string; header: string; multiSelect: boolean; options: never[] }[], emit: () => void) => Promise<unknown>;
    pendingForSession: (sessionId: string) => unknown;
    cancelForSession: (sessionId: string, reason: string) => void;
  };
};

describe('BrainService — multi-client abort/detach contract (Fáze 0, Invariant 2)', () => {
  it('CLI closes while the web still watches → the shared turn is NOT aborted', async () => {
    const d = fakeDeps();
    const svc = new BrainService(d as never);
    await svc.start(1);
    // Two clients follow the same conversation: a web tap and a CLI tap.
    const webEvents: BrainEvent[] = [];
    svc.tapSession(1, 'brain-1', (e) => webEvents.push(e), 'web-x');
    svc.tapSession(1, 'brain-1', () => {}, 'cli-a');
    await svc.send({ userId: 1, text: 'a running turn' });
    d.session.isStreaming = true; // a turn is in flight, watched by both

    d.session.abort.mockClear();
    webEvents.length = 0;
    // The CLI quits: detach-unless-last. The web is still attached, so nothing may abort.
    const result = await svc.stopSession(1, 'brain-1', 'cli-a');

    expect(result).toEqual({ stopped: true, disposed: false });
    // INVARIANT 2: with another watcher attached, the shared turn must survive the CLI's departure.
    expect(d.session.abort).not.toHaveBeenCalled();
    expect(d.session.dispose).not.toHaveBeenCalled();
    expect(svc.status(1).running).toBe(true);
    expect(attached(svc, 'brain-1')).toBe(1); // only the web remains
    // The web keeps streaming: a subsequent settle still reaches it.
    d.emit({ type: 'agent_end', willRetry: false, messages: [{ role: 'assistant', content: 'more' }] });
    expect(webEvents.some((e) => (e as { type: string }).type === 'idle')).toBe(true);
  });

  it('the last watcher leaving via stop → aborts and disposes, history stays resumable', async () => {
    const d = fakeDeps();
    const svc = new BrainService(d as never);
    await svc.start(1);
    svc.tapSession(1, 'brain-1', () => {}, 'cli-a');
    await svc.send({ userId: 1, text: 'sole client' });
    d.session.isStreaming = true;

    const result = await svc.stopSession(1, 'brain-1', 'cli-a');

    expect(result).toEqual({ stopped: true, disposed: true });
    expect(d.session.abort).toHaveBeenCalled();
    expect(d.session.dispose).toHaveBeenCalled();
    // Disposed live, but the transcript remains in SQLite and can be resumed later.
    expect(d.store.getSession('brain-1')).toBeDefined();
  });

  it('explicit Stop from any client aborts for ALL watchers without tearing down transports', async () => {
    const d = fakeDeps();
    const svc = new BrainService(d as never);
    await svc.start(1);
    const cliEvents: BrainEvent[] = [];
    const webEvents: BrainEvent[] = [];
    svc.tapSession(1, 'brain-1', (e) => cliEvents.push(e), 'cli-a');
    svc.subscribe(1, (e) => webEvents.push(e)); // the anonymous web dock
    await svc.send({ userId: 1, text: 'shared turn' });
    d.session.isStreaming = true;

    d.session.abort.mockClear();
    cliEvents.length = 0;
    webEvents.length = 0;
    await svc.abort(1, 'brain-1'); // POST /brain/abort — the same path as the CLI Esc

    expect(d.session.abort).toHaveBeenCalledTimes(1);
    expect(d.session.dispose).not.toHaveBeenCalled();
    expect(attached(svc, 'brain-1')).toBe(2); // both streams stay attached; nobody is detached
    // Both watchers see the turn settle (agent_end → idle).
    d.emit({ type: 'agent_end', willRetry: false, messages: [] });
    expect(cliEvents.some((e) => (e as { type: string }).type === 'idle')).toBe(true);
    expect(webEvents.some((e) => (e as { type: string }).type === 'idle')).toBe(true);
  });

  it('a clean transport-drop of another client neither aborts nor disposes', async () => {
    const d = fakeDeps();
    const svc = new BrainService(d as never);
    await svc.start(1);
    svc.tapSession(1, 'brain-1', () => {}, 'cli-a');
    const offOther = svc.tapSession(1, 'brain-1', () => {}, 'cli-b');
    await svc.send({ userId: 1, text: 'two watchers' });
    d.session.isStreaming = true;

    d.session.abort.mockClear();
    offOther(); // just closes the SSE (detachTransport) — no /brain/session/stop

    expect(d.session.abort).not.toHaveBeenCalled();
    expect(d.session.dispose).not.toHaveBeenCalled();
    expect(svc.status(1).running).toBe(true);
    expect(attached(svc, 'brain-1')).toBe(1); // dropped by one, but still > 0
  });

  it('the last client dropping only its SSE (no stop POST) leaves the turn running for reconnect', async () => {
    const d = fakeDeps();
    const svc = new BrainService(d as never);
    await svc.start(1);
    const off = svc.tapSession(1, 'brain-1', () => {}, 'cli-a');
    await svc.send({ userId: 1, text: 'sole watcher blips' });
    d.session.isStreaming = true;

    d.session.abort.mockClear();
    off(); // a network blip: the EventSource closes, but no explicit stop is sent

    // A bare transport drop is clean: it never aborts. The turn keeps running until an explicit
    // stopSession or the grace-TTL / idle watchdog (out of Fáze 0 scope) reaps it — the client reconnects.
    expect(d.session.abort).not.toHaveBeenCalled();
    expect(d.session.dispose).not.toHaveBeenCalled();
    expect(svc.status(1).running).toBe(true);
    expect(attached(svc, 'brain-1')).toBe(0); // detached, but the live session survives
  });

  it('the web Stop button is the same abort-all path as the CLI Esc', async () => {
    const d = fakeDeps();
    const svc = new BrainService(d as never);
    await svc.start(1);
    const cliEvents: BrainEvent[] = [];
    svc.tapSession(1, 'brain-1', (e) => cliEvents.push(e), 'cli-a');
    svc.tapSession(1, 'brain-1', () => {}, 'web-x');
    await svc.send({ userId: 1, text: 'shared turn' });
    d.session.isStreaming = true;

    d.session.abort.mockClear();
    cliEvents.length = 0;
    // The web presses Stop → POST /brain/abort {session:'brain-1'} — routed to the exact same abort().
    await svc.abort(1, 'brain-1');

    expect(d.session.abort).toHaveBeenCalledTimes(1);
    expect(d.session.dispose).not.toHaveBeenCalled();
    expect(attached(svc, 'brain-1')).toBe(2); // symmetric to a CLI Stop: nobody is detached
    d.emit({ type: 'agent_end', willRetry: false, messages: [] });
    expect(cliEvents.some((e) => (e as { type: string }).type === 'idle')).toBe(true);
  });

  it('a non-last stopSession does NOT cancel the goal or parked ask the remaining watcher still owns', async () => {
    const d = fakeDeps();
    const svc = new BrainService(d as never);
    const started = await svc.start(1, { clientId: 'cli-a', clientGeneration: 1 });
    const sessionId = started.sessionId;
    svc.tapSession(1, sessionId, () => {}, 'cli-a', 1);
    const offOther = svc.tapSession(1, sessionId, () => {}, 'cli-b', 1); // a second watcher stays
    d.session.isStreaming = true;

    const internals = svc as unknown as ElicitationInternals;
    const parked = internals.elicitation.ask(sessionId, [{
      question: 'Continue?', header: 'Continue', multiSelect: false, options: [],
    }], () => {});
    const parkedHandled = parked.catch(() => undefined); // swallow whichever way it settles
    d.store.upsertGoal({ sessionId, userId: 1, goal: 'keep going', draft: '', status: 'active' });

    d.session.abort.mockClear();
    const result = await svc.stopSession(1, sessionId, 'cli-a', 1);

    expect(result).toEqual({ stopped: true, disposed: false });
    // INVARIANT 2: cancellation belongs to the last-watcher (disposable) branch only. With cli-b still
    // attached, the departing cli-a must not abort — and therefore must not cancel the shared ask/goal.
    expect(d.session.abort).not.toHaveBeenCalled();
    expect(internals.elicitation.pendingForSession(sessionId)).not.toBeNull();
    expect(d.store.getGoal(sessionId)?.status).toBe('active');

    internals.elicitation.cancelForSession(sessionId, 'test cleanup');
    await parkedHandled;
    offOther();
  });
});
