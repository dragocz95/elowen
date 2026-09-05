import { beforeAll, describe, it, expect, vi } from 'vitest';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { BrainService } from '../../src/brain/brainService.js';
import { TurnParkPolicy } from '../../src/brain/turnPark.js';
import { settlePartialTurn } from '../../src/brain/persistence.js';
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
  const turnPark = new TurnParkPolicy({
    onParked: (sessionId) => { store.markSessionParked(sessionId); },
  });
  return {
    store, turnPark,
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

  it('checkpoints every message still queued behind the turn into the side table, steers first, NEVER into the transcript', async () => {
    const d = fakeDeps();
    const svc = new BrainService(d as never);
    const sessionId = await startHangingTurn(d, svc);
    // Two messages typed while the turn ran: PI holds them in process memory only, so without the
    // checkpoint they would vanish with the process.
    await svc.send({ userId: 1, text: 'also check the logs', images: [{ data: 'AAAA', mimeType: 'image/png' }] });
    await d.session.followUp('and then summarize');
    d.session.__emitQueue();
    expect(d.session.steer).toHaveBeenCalledTimes(1);
    // The turn is mid tool call: a pending assistant row whose call has no result yet. A user row behind
    // it would separate the call from its synthetic answer and every provider would refuse the context.
    d.store.appendPendingMessage({ id: 'pend-a', sessionId, role: 'assistant', content: { role: 'assistant', content: [{ type: 'toolCall', id: 't1', name: 'Bash', arguments: {} }] } });
    const before = d.store.getMessages(sessionId).map((row) => row.id);

    const summary = svc.pauseForRestart();

    expect(summary.queued).toBe(2);
    expect(d.store.getMessages(sessionId).map((row) => row.id)).toEqual(before); // transcript untouched
    const queue = d.store.takePausedQueue(sessionId);
    expect(queue.map((item) => item.text)).toEqual(['also check the logs', 'and then summarize']);
    expect(queue[0]!.images).toEqual([{ data: 'AAAA', mimeType: 'image/png' }]); // images ride along
    expect(d.store.takePausedQueue(sessionId)).toEqual([]); // consumed exactly once
    // And the settled transcript keeps the call directly followed by its interrupted answer.
    settlePartialTurn(d.store, sessionId);
    const tail = d.store.getMessages(sessionId).slice(-2).map((row) => JSON.parse(row.content) as { role: string; toolCallId?: string });
    expect(tail.map((m) => m.role)).toEqual(['assistant', 'toolResult']);
    expect(tail[1]!.toolCallId).toBe('t1');
  });

  it('resets parked activity when aborting after the live brain disappeared', async () => {
    const d = fakeDeps();
    const svc = new BrainService(d as never);
    const sessionId = await startHangingTurn(d, svc);
    const summary = svc.pauseForRestart();
    expect(summary.parked).toEqual([sessionId]);
    expect(d.store.getSessionActivity(sessionId)).toMatchObject({ state: 'working' });

    const registry = (svc as unknown as { sessions: { dispose(id: string): void } }).sessions;
    registry.dispose(sessionId);
    await svc.abort(1);

    expect(d.store.getSessionActivity(sessionId)).toMatchObject({ state: 'idle', turnId: null, unread: false });
    expect(d.store.getSession(sessionId)!.parked_at).toBeNull();
  });

  /** The park marker and the activity fence are two halves of one claim, and this is the path that used to
   *  separate them. Boot restamps a PARKED conversation's fence onto itself so the resume stays live, which
   *  leaves the row reading `working` under the PREVIOUS turn's id. If the user speaks before the resume
   *  sweep reaches that conversation the marker is stood down — and the fence used to be left behind where
   *  no later compare-and-set could reach it: `begin` refuses (the row still reads `working`), `settle`
   *  refuses (a different turn id), and the sweep's own release never runs because its claim-check now
   *  fails. The conversation then pulsed "working" for the life of the process and lost its unread state
   *  for good, self-healing only at the next restart. */
  it('releases the stale park fence when the user speaks before the resume sweep reaches it', async () => {
    const first = fakeDeps();
    const paused = new BrainService(first as never);
    const sessionId = await startHangingTurn(first, paused);
    paused.pauseForRestart();
    const parkedTurnId = first.store.getSessionActivity(sessionId)!.turnId;
    expect(first.store.getSessionActivity(sessionId)).toMatchObject({ state: 'working' });
    expect(parkedTurnId).not.toBeNull();
    expect(first.store.getSession(sessionId)!.parked_at).not.toBeNull();

    // The next boot, over the same durable store. Its constructor mints this boot's id, and the reconcile
    // restamps the parked row onto it — deliberately keeping the turn `working` so the resume stays live.
    const next = { ...fakeDeps(), store: first.store };
    next.session.prompt = vi.fn(async (_t: string, options?: { preflightResult?: (success: boolean) => void }) => {
      options?.preflightResult?.(true);
    });
    const resumed = new BrainService(next as never);
    first.store.reconcileSessionActivityOnBoot();
    expect(first.store.getSessionActivity(sessionId)).toMatchObject({ state: 'working', turnId: parkedTurnId });

    // The user speaks first. Their message IS the continuation, so the sweep stands down — and the fence
    // has to stand down with it.
    await resumed.send({ userId: 1, text: 'actually, do this instead', session: sessionId, surface: 'web' });

    expect(first.store.getSession(sessionId)!.parked_at).toBeNull();
    const after = first.store.getSessionActivity(sessionId)!;
    expect(after.state, 'the conversation must not be left pulsing "working" forever').not.toBe('working');
    expect(after).toMatchObject({ state: 'done', turnId: null });
  });

  /** The success end of the same fence. Main's silent boot resume (continueInterrupted) deliberately runs
   *  outside the ordinary turn scope — no message injected, no turn opened — so nothing on that path
   *  settles the working fence the pause left standing. The conversation the restart had just finished
   *  answering would otherwise pulse "working" for the life of the process, and every later turn in it
   *  would lose its compare-and-set against the dead turn id. */
  it('closes the activity fence when the boot resume answers the parked turn', async () => {
    const first = fakeDeps();
    const paused = new BrainService(first as never);
    const sessionId = await startHangingTurn(first, paused);
    paused.pauseForRestart();
    expect(first.store.getSessionActivity(sessionId)).toMatchObject({ state: 'working' });

    const next = { ...fakeDeps(), store: first.store };
    const resumed = new BrainService(next as never);
    first.store.reconcileSessionActivityOnBoot();
    expect(first.store.getSessionActivity(sessionId)).toMatchObject({ state: 'working' });

    // The continuation itself belongs to the resume path and is covered with it; what this pins is that a
    // resume which ANSWERS also stands the fence down.
    const runner = (resumed as unknown as { turnRunner: { continueInterrupted: (u: number, s: string) => Promise<string> } }).turnRunner;
    runner.continueInterrupted = async () => 'continued';

    const outcome = await resumed.resumeParkedConversation({ row: first.store.getSession(sessionId)!, parked: true } as never);

    expect(outcome).toBe('resumed');
    expect(first.store.getSession(sessionId)!.parked_at).toBeNull();
    expect(first.store.getSessionActivity(sessionId)).toMatchObject({ state: 'done', turnId: null });
  });

  it('reports an idle daemon as nothing to park and writes no marker', async () => {
    const d = fakeDeps();
    const svc = new BrainService(d as never);
    await svc.start(1);
    const summary = svc.pauseForRestart();
    expect(summary).toEqual({ turns: 0, children: 0, parked: [], queued: 0, unparkable: [] });
    expect(d.store.parkedSessions()).toEqual([]);
  });

  it('a turn nothing can resume is not parked: it gets the bounded wait, then a durable interruption record', async () => {
    const d = fakeDeps();
    const svc = new BrainService(d as never);
    await svc.start(1);
    // Two live turns with no boot resume: a cron run and a task-worker style room turn without an
    // envelope. Simulated through the registry's own lock — the same thing activeTurnSessionIds reads.
    const cron = 'brain-ch-cron-daily';
    const worker = 'brain-ch-work-job-1';
    for (const id of [cron, worker]) d.store.createSession({ id, userId: 1, model: 'm' });
    const registry = (svc as unknown as { sessions: { withLock<T>(key: string, fn: () => Promise<T>): Promise<T> } }).sessions;
    let finishWorker = (): void => {};
    void registry.withLock(cron, () => new Promise<void>(() => { /* never finishes */ }));
    void registry.withLock(worker, () => new Promise<void>((resolve) => { finishWorker = resolve; }));
    await tick();

    const summary = svc.pauseForRestart();
    expect(summary.parked).toEqual([]);
    expect(summary.unparkable.sort()).toEqual([cron, worker].sort());
    expect(d.store.parkedSessions()).toEqual([]); // no marker: nothing would resume them

    setTimeout(() => finishWorker(), 50); // the worker's step finishes inside the wait
    const interrupted = await svc.settleUnparkable(summary.unparkable, 1_000);
    expect(interrupted).toEqual([cron]); // the worker got its answer out; only the cron run was cut
    expect(d.store.takePauseInterruptions()).toEqual([expect.objectContaining({ sessionId: cron, class: 'cron' })]);
    expect(d.store.takePauseInterruptions()).toEqual([]); // consumed once
  });

  it('the bounded wait ends at its budget even when the turn never finishes', async () => {
    const d = fakeDeps();
    const svc = new BrainService(d as never);
    await svc.start(1);
    const room = 'brain-ch-discord-room';
    d.store.createSession({ id: room, userId: 1, model: 'm' });
    const registry = (svc as unknown as { sessions: { withLock<T>(key: string, fn: () => Promise<T>): Promise<T> } }).sessions;
    void registry.withLock(room, () => new Promise<void>(() => { /* stuck */ }));
    await tick();
    const startedAt = Date.now();
    const interrupted = await svc.settleUnparkable([room], 300);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(interrupted).toEqual([room]);
    expect(d.store.takePauseInterruptions()[0]).toMatchObject({ sessionId: room, class: 'no-envelope' });
  });
});
