import { beforeAll, describe, it, expect, vi } from 'vitest';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { BrainService } from '../../src/brain/brainService.js';
import { openDb } from '../../src/store/db.js';
import { BrainStore } from '../../src/store/brainStore.js';
import { inMemoryModelRuntime } from '../../src/brain/providers.js';
import { SESSION_IDLE_ROLLOVER_MS } from '../../src/brain/session/idleRollover.js';

// A web tab going away is NOT a stop. The browser fires `pagehide` when iOS freezes the page into the
// bfcache (screen lock), and the beacon that followed it used to abort + dispose the running turn — the
// agent died because the phone locked. Two independent locks fix it: the client suppresses the beacon on
// a bfcache freeze, and a beacon that IS sent carries `detachOnly`, which lets the daemon release the
// client's binding while refusing to tear down a session that still has work in flight.
//
// The runtime is then owned by nobody, so a TTL reaper collects it. Its load-bearing property: the clock
// starts when the session FIRST becomes both unwatched and idle, never at client detach — an agent
// working for hours without a client never starts the clock at all.

let sharedRuntime: ModelRuntime;
beforeAll(async () => { sharedRuntime = await inMemoryModelRuntime(); });

/** Same fake-PI harness the other BrainService suites use (see multiClientContract.test.ts). */
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
    setSteeringMode: vi.fn(),
    getSteeringMessages: () => session.__queue,
    getFollowUpMessages: () => [] as string[],
    get pendingMessageCount() { return session.__queue.length; },
    clearQueue: vi.fn(() => { const s = session.__queue.slice(); session.__queue.length = 0; session.__emitQueue(); return { steering: s, followUp: [] }; }),
    __contextUsage: undefined as { tokens: number; contextWindow: number; percent: number } | undefined,
    getContextUsage(this: { __contextUsage?: { tokens: number; contextWindow: number; percent: number } }) { return this.__contextUsage; },
    compact: vi.fn(async () => {}),
    __tools: [] as { name: string }[],
    __active: [] as string[],
    // A real PI session always exposes its RENDERED prompt; the compaction threshold measures the
    // never-shrinking prefill off it, so a fake without one is simply incomplete.
    systemPrompt: '',
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

type ElicitationInternals = {
  elicitation: {
    ask: (sessionId: string, questions: { question: string; header: string; multiSelect: boolean; options: never[] }[], emit: () => void) => Promise<unknown>;
    cancelForSession: (sessionId: string, reason: string) => void;
  };
};

describe('detachOnly stop — a phone locking must not kill the agent', () => {
  it('leaves a RUNNING turn alone and reports it did not stop', async () => {
    const d = fakeDeps();
    const svc = new BrainService(d as never);
    await svc.start(1, { clientId: 'web-x', clientGeneration: 1 });
    svc.tapSession(1, 'brain-1', () => {}, 'web-x', 1);
    await svc.send({ userId: 1, text: 'long turn' });
    d.session.isStreaming = true;
    d.session.abort.mockClear();

    const result = await svc.stopSession(1, 'brain-1', 'web-x', 1, { detachOnly: true });

    expect(result).toEqual({ stopped: false, disposed: false });
    expect(d.session.abort).not.toHaveBeenCalled();
    expect(d.session.dispose).not.toHaveBeenCalled();
    expect(svc.status(1).running).toBe(true);
  });

  it('leaves a session parked on a question alone', async () => {
    const d = fakeDeps();
    const svc = new BrainService(d as never);
    await svc.start(1, { clientId: 'web-x', clientGeneration: 1 });
    svc.tapSession(1, 'brain-1', () => {}, 'web-x', 1);
    const internals = svc as unknown as ElicitationInternals;
    const parked = internals.elicitation.ask('brain-1', [{ question: 'Continue?', header: 'Continue', multiSelect: false, options: [] }], () => {});
    const settled = parked.catch(() => undefined);

    const result = await svc.stopSession(1, 'brain-1', 'web-x', 1, { detachOnly: true });

    expect(result).toEqual({ stopped: false, disposed: false });
    expect(d.session.dispose).not.toHaveBeenCalled();

    internals.elicitation.cancelForSession('brain-1', 'test cleanup');
    await settled;
  });

  it('leaves a session with a queued mid-turn message alone', async () => {
    const d = fakeDeps();
    const svc = new BrainService(d as never);
    await svc.start(1, { clientId: 'web-x', clientGeneration: 1 });
    svc.tapSession(1, 'brain-1', () => {}, 'web-x', 1);
    d.session.__queue.push('queued while the phone was locked');

    const result = await svc.stopSession(1, 'brain-1', 'web-x', 1, { detachOnly: true });

    expect(result).toEqual({ stopped: false, disposed: false });
    expect(d.session.dispose).not.toHaveBeenCalled();
  });

  it('still disposes an IDLE session — a real tab close of an idle conversation is unchanged', async () => {
    const d = fakeDeps();
    const svc = new BrainService(d as never);
    await svc.start(1, { clientId: 'web-x', clientGeneration: 1 });
    svc.tapSession(1, 'brain-1', () => {}, 'web-x', 1);
    await svc.send({ userId: 1, text: 'done' });

    const result = await svc.stopSession(1, 'brain-1', 'web-x', 1, { detachOnly: true });

    expect(result).toEqual({ stopped: true, disposed: true });
    expect(d.session.dispose).toHaveBeenCalled();
  });

  it('without detachOnly (the CLI) a running turn is still aborted and disposed', async () => {
    const d = fakeDeps();
    const svc = new BrainService(d as never);
    await svc.start(1, { clientId: 'cli-a', clientGeneration: 1 });
    svc.tapSession(1, 'brain-1', () => {}, 'cli-a', 1);
    await svc.send({ userId: 1, text: 'long turn' });
    d.session.isStreaming = true;
    d.session.abort.mockClear();

    const result = await svc.stopSession(1, 'brain-1', 'cli-a', 1);

    expect(result).toEqual({ stopped: true, disposed: true });
    expect(d.session.abort).toHaveBeenCalled();
    expect(d.session.dispose).toHaveBeenCalled();
  });
});

describe('idle live-session reaper', () => {
  const t0 = 1_800_000_000_000;

  it('reaps an unwatched idle session only once the TTL has fully elapsed', async () => {
    const d = fakeDeps();
    const svc = new BrainService(d as never);
    await svc.start(1);
    await svc.send({ userId: 1, text: 'hello' });

    expect(await svc.reapIdleLiveSessions(t0)).toEqual([]);
    expect(await svc.reapIdleLiveSessions(t0 + SESSION_IDLE_ROLLOVER_MS - 1)).toEqual([]);
    expect(d.session.dispose).not.toHaveBeenCalled();

    expect(await svc.reapIdleLiveSessions(t0 + SESSION_IDLE_ROLLOVER_MS)).toEqual(['brain-1']);
    expect(d.session.dispose).toHaveBeenCalled();
    expect(svc.status(1).running).toBe(false);
    expect(d.store.getSession('brain-1')).toBeDefined(); // history stays resumable
  });

  it('never starts the clock while a turn is running — the countdown begins when the work ends', async () => {
    const d = fakeDeps();
    const svc = new BrainService(d as never);
    await svc.start(1);
    await svc.send({ userId: 1, text: 'a long agent run' });
    d.session.isStreaming = true;

    // Busy for well over the TTL with no client attached: nothing may be reaped, and no stamp may accrue.
    expect(await svc.reapIdleLiveSessions(t0)).toEqual([]);
    expect(await svc.reapIdleLiveSessions(t0 + SESSION_IDLE_ROLLOVER_MS * 2)).toEqual([]);

    d.session.isStreaming = false; // the turn finally settles
    expect(await svc.reapIdleLiveSessions(t0 + SESSION_IDLE_ROLLOVER_MS * 2)).toEqual([]);
    // The TTL is measured from THAT moment, not from when the client left.
    expect(await svc.reapIdleLiveSessions(t0 + SESSION_IDLE_ROLLOVER_MS * 3 - 1)).toEqual([]);
    expect(await svc.reapIdleLiveSessions(t0 + SESSION_IDLE_ROLLOVER_MS * 3)).toEqual(['brain-1']);
  });

  it('a client attaching mid-window resets the countdown', async () => {
    const d = fakeDeps();
    const svc = new BrainService(d as never);
    await svc.start(1);
    await svc.send({ userId: 1, text: 'hello' });

    expect(await svc.reapIdleLiveSessions(t0)).toEqual([]);
    const off = svc.tapSession(1, 'brain-1', () => {}, 'web-x', 1);
    expect(await svc.reapIdleLiveSessions(t0 + SESSION_IDLE_ROLLOVER_MS)).toEqual([]);
    off();
    expect(await svc.reapIdleLiveSessions(t0 + SESSION_IDLE_ROLLOVER_MS + 1)).toEqual([]);
    expect(await svc.reapIdleLiveSessions(t0 + SESSION_IDLE_ROLLOVER_MS * 2 + 1)).toEqual(['brain-1']);
  });

  it('never reaps a session a client is still watching', async () => {
    const d = fakeDeps();
    const svc = new BrainService(d as never);
    await svc.start(1);
    svc.tapSession(1, 'brain-1', () => {}, 'web-x', 1);
    await svc.send({ userId: 1, text: 'hello' });

    expect(await svc.reapIdleLiveSessions(t0)).toEqual([]);
    expect(await svc.reapIdleLiveSessions(t0 + SESSION_IDLE_ROLLOVER_MS * 10)).toEqual([]);
    expect(d.session.dispose).not.toHaveBeenCalled();
  });
});
