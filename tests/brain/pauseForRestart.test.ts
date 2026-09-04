import { beforeAll, describe, it, expect, vi } from 'vitest';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { BrainService } from '../../src/brain/brainService.js';
import { StepDrainCoordinator } from '../../src/brain/stepDrain.js';
import { openDb } from '../../src/store/db.js';
import { BrainStore } from '../../src/store/brainStore.js';
import { inMemoryModelRuntime } from '../../src/brain/providers.js';

/** The PAUSE checkpoint (BrainService.pauseForRestart): what a restart writes durably for a turn that is
 *  still running at the moment the process leaves, against a real BrainStore. The daemon wires the step
 *  drain coordinator exactly like brainCore does (onParked → the park marker), so the marker path here is
 *  the production one. */

let sharedRuntime: ModelRuntime;
beforeAll(async () => { sharedRuntime = await inMemoryModelRuntime(); });

/** The fake-PI harness the other BrainService suites use, with a prompt that NEVER settles — the turn is
 *  mid-model-call when the pause arrives, which is the exact shape a restart finds. */
function fakeDeps() {
  const listeners: ((e: unknown) => void)[] = [];
  const messages: { role: string; content: string }[] = [];
  const session = {
    sessionId: 'sess-1',
    prompt: vi.fn(async (_t: string, options?: { preflightResult?: (success: boolean) => void }) => {
      options?.preflightResult?.(true);
      session.isStreaming = true;
      await new Promise<void>(() => { /* the model never answers — the pause finds the turn mid-step */ });
    }),
    subscribe: (l: (e: unknown) => void) => { listeners.push(l); return () => {}; },
    setModel: vi.fn(),
    dispose: vi.fn(() => { listeners.length = 0; }),
    abort: vi.fn(async () => {}),
    sendCustomMessage: vi.fn(async () => {}),
    abortCompaction: vi.fn(), abortBranchSummary: vi.fn(), messages, isStreaming: false,
    _checkCompaction: vi.fn(async () => false),
    __queue: [] as string[],
    __followUp: [] as string[],
    __emitQueue: () => listeners.forEach((l) => l({ type: 'queue_update', steering: session.__queue.slice(), followUp: session.__followUp.slice() })),
    steer: vi.fn(async (t: string) => { session.__queue.push(t); session.__emitQueue(); }),
    followUp: vi.fn(async (t: string) => { session.__followUp.push(t); session.__emitQueue(); }),
    setSteeringMode: vi.fn(),
    getSteeringMessages: () => session.__queue,
    getFollowUpMessages: () => session.__followUp,
    get pendingMessageCount() { return session.__queue.length + session.__followUp.length; },
    clearQueue: vi.fn(() => {
      const s = session.__queue.slice(); const f = session.__followUp.slice();
      session.__queue.length = 0; session.__followUp.length = 0; session.__emitQueue();
      return { steering: s, followUp: f };
    }),
    __contextUsage: undefined as { tokens: number; contextWindow: number; percent: number } | undefined,
    getContextUsage(this: { __contextUsage?: { tokens: number; contextWindow: number; percent: number } }) { return this.__contextUsage; },
    compact: vi.fn(async () => {}),
    __tools: [] as { name: string }[],
    __active: [] as string[],
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
  const db = openDb(':memory:');
  const store = new BrainStore(db);
  const stepDrain = new StepDrainCoordinator({
    onParked: (sessionId) => { store.markSessionParked(sessionId); },
  });
  return {
    store, stepDrain,
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

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 20));

/** Start an owner turn that never settles and return the conversation it runs in. */
async function startHangingTurn(d: ReturnType<typeof fakeDeps>, svc: BrainService): Promise<string> {
  await svc.start(1);
  void svc.send({ userId: 1, text: 'do something long' }).catch(() => { /* the pause leaves it hanging */ });
  await tick();
  expect(d.session.prompt).toHaveBeenCalledTimes(1);
  return svc.status(1).sessionId!;
}

describe('pauseForRestart — the durable checkpoint of a turn caught mid-step', () => {
  it('parks the running owner turn at once (no boundary wait) and latches admission', async () => {
    const d = fakeDeps();
    const svc = new BrainService(d as never);
    const sessionId = await startHangingTurn(d, svc);
    expect(d.store.getSession(sessionId)!.parked_at).toBeNull();

    const summary = svc.pauseForRestart();

    expect(summary.turns).toBe(1);
    expect(summary.parked).toEqual([sessionId]);
    // The marker IS the resume: the owner-conversations boot provider continues exactly this session.
    expect(d.store.getSession(sessionId)!.parked_at).not.toBeNull();
    expect(d.store.parkedSessions().map((row) => row.id)).toEqual([sessionId]);
    // Latched like a drain: nothing new is admitted between the checkpoint and the exit.
    await expect(svc.send({ userId: 1, text: 'late' })).rejects.toThrow(/shutting down/);
    // The model call was NOT aborted: a PI abort would unwind through the delegation tree and terminalize
    // child run rows — the pause leaves every in-flight call to die with the process instead.
    expect(d.session.abort).not.toHaveBeenCalled();
  });

  it('writes every message still queued behind the turn as a durable user row, steers before follow-ups', async () => {
    const d = fakeDeps();
    const svc = new BrainService(d as never);
    const sessionId = await startHangingTurn(d, svc);
    // Two messages typed while the turn ran: PI holds them in process memory only, so without the
    // checkpoint they would vanish with the process.
    await svc.send({ userId: 1, text: 'also check the logs' });
    await d.session.followUp('and then summarize');
    d.session.__emitQueue();
    expect(d.session.steer).toHaveBeenCalledTimes(1);
    const before = d.store.getMessages(sessionId).filter((row) => row.role === 'user').length;

    const summary = svc.pauseForRestart();

    expect(summary.queued).toBe(2);
    const users = d.store.getMessages(sessionId).filter((row) => row.role === 'user');
    expect(users.length).toBe(before + 2);
    const texts = users.slice(-2).map((row) => (JSON.parse(row.content) as { content: string }).content);
    expect(texts).toEqual(['also check the logs', 'and then summarize']);
  });

  it('reports an idle daemon as nothing to park and writes no marker', async () => {
    const d = fakeDeps();
    const svc = new BrainService(d as never);
    await svc.start(1);
    const summary = svc.pauseForRestart();
    expect(summary).toEqual({ turns: 0, children: 0, parked: [], queued: 0 });
    expect(d.store.parkedSessions()).toEqual([]);
  });
});
