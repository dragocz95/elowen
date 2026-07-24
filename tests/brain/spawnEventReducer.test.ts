import { describe, it, expect, vi, beforeAll } from 'vitest';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { BrainService } from '../../src/brain/brainService.js';
import { openDb } from '../../src/store/db.js';
import { BrainStore } from '../../src/store/brainStore.js';
import { inMemoryModelRuntime } from '../../src/brain/providers.js';
import type { BrainEvent } from '../../src/brain/events.js';

/** Characterization safety net for the spawner's `session.subscribe` reducer (spawner.ts): the stateful
 *  event projector that folds raw PI `AgentSessionEvent`s into published BrainEvents and store writes.
 *  It coordinates delicate deferred state (deferredOverflowError, terminalIdleDeferred, agentRunOpen,
 *  deferredCompacted, steps) across the agent_start/turn_start/agent_end/compaction/agent_settled/
 *  auto_retry sequences. These tests drive representative sequences through the LIVE reducer (via the
 *  same fakeDeps harness style as brainService.test.ts — a fake session whose `subscribe` captures the
 *  reducer, `emit` pushes raw PI events through it) and lock the exact published events (types + order +
 *  idle/compacted/error/notice fields). They must pass BEFORE and AFTER the reducer extraction. */

let sharedRuntime: ModelRuntime;
beforeAll(async () => { sharedRuntime = await inMemoryModelRuntime(); });

/** An overflow error message PI's isContextOverflow classifier reliably matches (Anthropic phrasing). */
const OVERFLOW_MESSAGE = 'prompt is too long: 213462 tokens > 200000 maximum';

function fakeDeps() {
  const listeners: ((e: unknown) => void)[] = [];
  const messages: { role: string; content: unknown }[] = [];
  const session = {
    sessionId: 'sess-1',
    prompt: vi.fn(async () => {}),
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
    getContextUsage(): { tokens: number; contextWindow: number; percent: number } | undefined { return undefined; },
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
  const db = openDb(':memory:');
  return {
    /** Push a raw PI session event through everything subscribed via spawn (drives the live reducer). */
    emit: (e: unknown) => listeners.forEach((l) => l(e)),
    db,
    store: new BrainStore(db),
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

/** Start a live session and attach a recorder that captures every BrainEvent the reducer publishes. */
async function startWithRecorder() {
  const d = fakeDeps();
  const svc = new BrainService(d as never);
  await svc.start(1);
  const events: BrainEvent[] = [];
  svc.subscribe(1, (e) => events.push(e));
  return { d, svc, events };
}

const successAgentEnd = (text: string): unknown => ({
  type: 'agent_end', willRetry: false,
  messages: [{ role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text }], usage: {} }],
});

describe('spawn event reducer (characterization)', () => {
  it('clean turn: agent_start → turn_start → text → agent_end → agent_settled publishes step, text, idle', async () => {
    const { d, events } = await startWithRecorder();

    d.emit({ type: 'agent_start' });
    d.emit({ type: 'turn_start' });
    d.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Hello' } });
    d.emit(successAgentEnd('Hello'));
    d.emit({ type: 'agent_settled' });

    expect(events.map((e) => e.type)).toEqual(['step', 'text', 'idle']);
    const step = events[0] as Extract<BrainEvent, { type: 'step' }>;
    expect(step).toMatchObject({ step: 1, maxSteps: 0 });
    expect(step.usage).toBeDefined();
    expect(events[1]).toEqual(expect.objectContaining({ type: 'text', delta: 'Hello' }));
    const idle = events[2] as Extract<BrainEvent, { type: 'idle' }>;
    expect(idle.model).toBe('m');
    expect(idle.usage).toBeDefined();
  });

  it('overflow then compaction recovery: the deferred error is held and cleared on compaction_end (never emitted)', async () => {
    const { d, events } = await startWithRecorder();

    d.emit({ type: 'agent_start' });
    d.emit({ type: 'turn_start' });
    const afterTurnStart = events.length; // the `step` from turn_start is already recorded
    // PI emits an errored, overflow agent_end (no willRetry) BEFORE deciding to compact-and-retry: the
    // reducer must hold that error and suppress the terminal idle, publishing nothing here.
    d.emit({
      type: 'agent_end', willRetry: false,
      messages: [{ role: 'assistant', stopReason: 'error', errorMessage: OVERFLOW_MESSAGE, content: [], usage: {} }],
    });
    expect(events.length).toBe(afterTurnStart); // nothing published for the overflow agent_end

    d.emit({ type: 'compaction_start' });
    // A recovering overflow compaction (result present, not aborted, willRetry) clears the deferred error.
    d.emit({ type: 'compaction_end', result: {}, aborted: false, reason: 'overflow', willRetry: true });
    d.emit(successAgentEnd('recovered reply'));
    d.emit({ type: 'agent_settled' });

    expect(events.map((e) => e.type)).toEqual(['step', 'notice', 'compacted', 'notice', 'idle']);
    expect(events.some((e) => e.type === 'error')).toBe(false);
    expect(events[1]).toEqual(expect.objectContaining({ type: 'notice', kind: 'compaction', message: 'compacting conversation…' }));
    expect(events[2]).toEqual({ type: 'compacted' });
    expect(events[3]).toEqual(expect.objectContaining({ type: 'notice', kind: 'compaction', message: 'conversation compacted', done: true }));
    expect((events[4] as Extract<BrainEvent, { type: 'idle' }>).model).toBe('m');
  });

  it('overflow with nothing summarizable: agent_settled flushes the deferred error then the idle', async () => {
    const { d, events } = await startWithRecorder();

    d.emit({ type: 'agent_start' });
    d.emit({ type: 'turn_start' });
    d.emit({
      type: 'agent_end', willRetry: false,
      messages: [{ role: 'assistant', stopReason: 'error', errorMessage: OVERFLOW_MESSAGE, content: [], usage: {} }],
    });
    // No compaction_end ever arrives (nothing to summarize): agent_settled is the canonical fallback.
    d.emit({ type: 'agent_settled' });

    expect(events.map((e) => e.type)).toEqual(['step', 'error', 'idle']);
    expect(events[1]).toEqual({ type: 'error', message: OVERFLOW_MESSAGE });
    expect((events[2] as Extract<BrainEvent, { type: 'idle' }>).model).toBe('m');
  });

  it('willRetry agent_end suppresses the idle; the retry notices and the final successful idle still flow', async () => {
    const { d, events } = await startWithRecorder();

    d.emit({ type: 'agent_start' });
    d.emit({ type: 'turn_start' });
    // A transient (429/5xx) agent_end carries willRetry: no error, no idle — the run is not terminal yet.
    d.emit({
      type: 'agent_end', willRetry: true,
      messages: [{ role: 'assistant', stopReason: 'error', errorMessage: '429 rate limit', content: [], usage: {} }],
    });
    expect(events).toEqual([{ type: 'step', step: 1, maxSteps: 0, usage: expect.anything() }]);

    d.emit({ type: 'auto_retry_start', attempt: 1, maxAttempts: 3, errorMessage: '429 rate limit' });
    d.emit({ type: 'auto_retry_end', success: true });
    d.emit(successAgentEnd('recovered after retry'));
    d.emit({ type: 'agent_settled' });

    expect(events.map((e) => e.type)).toEqual(['step', 'notice', 'notice', 'idle']);
    expect(events.some((e) => e.type === 'error')).toBe(false);
    expect(events[1]).toEqual(expect.objectContaining({ type: 'notice', kind: 'retry' }));
    expect(events[2]).toEqual(expect.objectContaining({ type: 'notice', kind: 'retry', done: true }));
    expect((events[3] as Extract<BrainEvent, { type: 'idle' }>).model).toBe('m');
  });

  it('a non-overflow provider error on a terminal agent_end surfaces as an error ahead of the idle', async () => {
    const { d, events } = await startWithRecorder();

    d.emit({ type: 'agent_start' });
    d.emit({ type: 'turn_start' });
    // A non-retryable, non-overflow error passes through publicProviderError unmasked (isRetryableAssistantError
    // returns false), so its verbatim message reaches the client.
    d.emit({
      type: 'agent_end', willRetry: false,
      messages: [{ role: 'assistant', stopReason: 'error', errorMessage: 'the model produced malformed output', content: [], usage: {} }],
    });
    d.emit({ type: 'agent_settled' });

    expect(events.map((e) => e.type)).toEqual(['step', 'error', 'idle']);
    expect(events[1]).toEqual({ type: 'error', message: 'the model produced malformed output' });
    expect((events[2] as Extract<BrainEvent, { type: 'idle' }>).model).toBe('m');
  });
});
