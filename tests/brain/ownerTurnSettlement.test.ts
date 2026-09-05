import { beforeAll, describe, it, expect, vi } from 'vitest';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { BrainService } from '../../src/brain/brainService.js';
import { openDb } from '../../src/store/db.js';
import { BrainStore } from '../../src/store/brainStore.js';
import { UsageOriginStore, billSettledTurn } from '../../src/store/usageOriginStore.js';
import { inMemoryModelRuntime } from '../../src/brain/providers.js';
import type { ClientOrigin } from '../../src/api/clientIp.js';
import type { OriginTurnUsage } from '../../src/store/usageOriginStore.js';
import type { BrainTurnRunner } from '../../src/brain/service/turnRunner.js';

/** What an OWNER turn does besides answering, against a real BrainStore and a real UsageOriginStore.
 *
 *  The owner surface and a room settle through one helper on purpose, so the cases here are the ones the
 *  room cannot exercise: the idle rollover that moves a turn to a fresh conversation mid-flight, the
 *  guards that can still refuse a turn after it was announced, and the steer path. */

const WEB: ClientOrigin = { value: '203.0.113.9', kind: 'ip', trusted: true };
const AT = Date.UTC(2026, 7, 24, 10, 0);

let sharedRuntime: ModelRuntime;
beforeAll(async () => { sharedRuntime = await inMemoryModelRuntime(); });

/** Same fake-PI harness the other BrainService suites use (see idleLiveSessionLifecycle.test.ts), plus the
 *  three settlement wirings the daemon supplies: the origin rollup, the activity feed and the billing. */
function fakeDeps() {
  const listeners: ((e: unknown) => void)[] = [];
  const messages: { role: string; content: string; stopReason?: string; errorMessage?: string }[] = [];
  let failNextPrompt = false;
  /** How the REAL PI ends a provider error or an abort: `prompt()` RESOLVES, and the outcome is legible
   *  only from the settled assistant's `stopReason`. Nothing is thrown, so a settlement keying off the
   *  catch alone never learns the turn went wrong — which is what the two tests below pin. */
  let settleNextPromptAs: 'error' | 'aborted' | null = null;
  const session = {
    sessionId: 'sess-1',
    prompt: vi.fn(async (t: string, options?: { preflightResult?: (success: boolean) => void }) => {
      options?.preflightResult?.(true);
      if (settleNextPromptAs) {
        const stopReason = settleNextPromptAs;
        settleNextPromptAs = null;
        const assistant = {
          role: 'assistant', content: '', stopReason,
          ...(stopReason === 'error' ? { errorMessage: 'relay/m: upstream returned 503' } : {}),
        };
        messages.push({ role: 'user', content: t }, assistant);
        listeners.forEach((l) => l({ type: 'agent_end', willRetry: false, messages: [assistant] }));
        return;
      }
      if (failNextPrompt) {
        failNextPrompt = false;
        messages.push({ role: 'user', content: t }, { role: 'assistant', content: '', stopReason: 'error' });
        throw new Error('provider failed');
      }
      messages.push({ role: 'user', content: t }, { role: 'assistant', content: `echo:${t}` });
      listeners.forEach((l) => l({ type: 'agent_end', willRetry: false, messages: [{ role: 'assistant', content: `echo:${t}` }] }));
    }),
    subscribe: (l: (e: unknown) => void) => { listeners.push(l); return () => {}; },
    setModel: vi.fn(),
    // A disposed PI session takes its subscription with it. The harness reuses ONE session object across
    // spawns, so without this the archived conversation's subscription would still be listening when the
    // rolled-over session answers, and every turn after a rollover would settle twice.
    dispose: vi.fn(() => { listeners.length = 0; }),
    abort: vi.fn(async () => {}),
    sendCustomMessage: vi.fn(async (message: Record<string, unknown>, options?: { triggerTurn?: boolean }) => {
      messages.push({ role: 'custom', ...message } as never);
      if (options?.triggerTurn) messages.push({ role: 'assistant', content: 'processed', stopReason: 'stop' });
    }),
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
  const db = openDb(':memory:');
  const store = new BrainStore(db);
  const usageOrigins = new UsageOriginStore(db);
  const activity: { actorUserId: number | null; surface: string; target: string }[] = [];
  return {
    store, usageOrigins,
    runtime: sharedRuntime,
    users: { ensureAdvisorToken: () => 'full-token', get: () => ({ name: 'Filip', username: 'filip' }) },
    config: { providers: [{ id: 'relay', label: 'Relay', type: 'openai' as const, baseUrl: 'http://x/v1', models: ['m'], apiKey: 'k' }] },
    prompts: { render: vi.fn((name: string, vars: Record<string, string>) => `PERSONA:${name}:${vars.userName}`) },
    url: 'http://x',
    createSession,
    resourceLoaderFactory: () => undefined,
    session,
    // Wired exactly as the daemon wires them (brainCore).
    recordActivity: (e: { actorUserId: number | null; surface: string; target: string }) => { activity.push(e); },
    onTurnSettled: (sessionId: string, usage: OriginTurnUsage) => {
      billSettledTurn(usageOrigins, (id) => store.getSession(id)?.user_id, sessionId, usage, AT);
    },
    activity,
    failNextPrompt: () => { failNextPrompt = true; },
    settleNextPromptAs: (stopReason: 'error' | 'aborted') => { settleNextPromptAs = stopReason; },
    /** The rollup as the admin view reads it: [account, address, turns]. */
    billed: () => usageOrigins.topOrigins({ group: 'pair' }).map((r) => [r.userId, r.origin, r.turns]),
  };
}

/** Push every stored message far enough into the past that the idle rollover is due on the next turn. */
const ageTranscript = (store: BrainStore): void => {
  store.db.prepare(`UPDATE brain_messages SET created_at = datetime('now', '-3 hours')`).run();
};

describe('an owner turn that changes conversation mid-flight is still attributed to its surface', () => {
  // The idle rollover archives the transcript and mints a FRESH session id, and settlement happens under
  // that new id. A pin left on the pre-lock id is found by nobody, so the first turn after every rollover
  // used to record as `internal` against the row owner instead of the surface the person was sitting at.
  it('follows the idle rollover, so the turn after it is not recorded as `internal`', async () => {
    const d = fakeDeps();
    const svc = new BrainService(d as never);
    await svc.start(1);
    await svc.send({ userId: 1, text: 'first', origin: WEB, surface: 'web' });
    const before = svc.status(1).sessionId;
    ageTranscript(d.store);

    await svc.send({ userId: 1, text: 'after a long lunch', origin: WEB, surface: 'web' });

    const after = svc.status(1).sessionId!;
    expect(after, 'the rollover must actually have happened').not.toBe(before);
    expect(d.store.getSessionActivity(before!)).toMatchObject({ state: 'done', turnId: null });
    expect(d.store.getSessionActivity(after)).toMatchObject({ state: 'done', turnId: null });
    expect(d.billed()).toEqual([[1, WEB.value, 2]]);
  });
});

describe('durable owner activity follows accepted turn ownership', () => {
  it('settles web work as done and keeps CLI-only work out of web unread state', async () => {
    const web = fakeDeps();
    const webSvc = new BrainService(web as never);
    await webSvc.start(1);
    await webSvc.send({ userId: 1, text: 'web turn', surface: 'web' });
    const webActivity = web.store.getSessionActivity(webSvc.status(1).sessionId!);
    expect(webActivity).toMatchObject({ state: 'done', unread: true });

    const cli = fakeDeps();
    const cliSvc = new BrainService(cli as never);
    await cliSvc.start(1);
    await cliSvc.send({ userId: 1, text: 'cli turn', surface: 'cli' });
    const cliActivity = cli.store.getSessionActivity(cliSvc.status(1).sessionId!);
    expect(cliActivity).toMatchObject({ state: 'done', unread: false, webParticipatedAt: null });
  });

  it('settles a provider failure as failed activity', async () => {
    const d = fakeDeps();
    const svc = new BrainService(d as never);
    await svc.start(1);
    d.failNextPrompt();

    await expect(svc.send({ userId: 1, text: 'failed', surface: 'web' })).rejects.toThrow('provider failed');

    expect(d.store.getSessionActivity(svc.status(1).sessionId!)).toMatchObject({ state: 'failed', unread: true });
  });

  // The failure mode this pins is the ordinary one, not the exotic one: PI does not THROW on a provider
  // error, it settles the assistant with `stopReason: 'error'` and empty content and resolves. A
  // settlement that only inspects the catch therefore sees a turn that "returned" and files an outage the
  // user watched happen as `done` — a green check in the rail, no reason offered anywhere.
  it('settles a provider error that PI resolves rather than throws as failed, with its reason', async () => {
    const d = fakeDeps();
    const svc = new BrainService(d as never);
    await svc.start(1);
    d.settleNextPromptAs('error');

    await svc.send({ userId: 1, text: 'this one hits an outage', surface: 'web' });

    expect(d.store.getSessionActivity(svc.status(1).sessionId!)).toMatchObject({
      state: 'failed', unread: true, turnId: null, detail: 'relay/m: upstream returned 503',
    });
  });

  // The mirror case, and the reason the check cannot simply be "did it end normally": a stop is the user's
  // own decision. Reporting their Esc back at them as a red failed row would be worse than saying nothing.
  it('settles a turn the user stopped as idle, never as failed', async () => {
    const d = fakeDeps();
    const svc = new BrainService(d as never);
    await svc.start(1);
    d.settleNextPromptAs('aborted');

    await svc.send({ userId: 1, text: 'never mind', surface: 'web' });

    expect(d.store.getSessionActivity(svc.status(1).sessionId!)).toMatchObject({ state: 'idle', turnId: null, detail: '' });
  });

  it('does not settle the existing activity when a user message is steered', async () => {
    const d = fakeDeps();
    const svc = new BrainService(d as never);
    await svc.start(1);
    await svc.send({ userId: 1, text: 'first', surface: 'web' });
    const sessionId = svc.status(1).sessionId!;
    const before = d.store.getSessionActivity(sessionId)!;
    d.session.isStreaming = true;

    await svc.send({ userId: 1, text: 'steer', surface: 'web' });

    expect(d.store.getSessionActivity(sessionId)).toMatchObject({ state: 'done', seq: before.seq });
  });

  it('tracks both concurrently accepted idle sends as serialized working and done turns', async () => {
    const d = fakeDeps();
    const svc = new BrainService(d as never);
    await svc.start(1);
    const sessionId = svc.status(1).sessionId!;

    await Promise.all([
      svc.send({ userId: 1, text: 'first concurrent turn', surface: 'web' }),
      svc.send({ userId: 1, text: 'second concurrent turn', surface: 'web' }),
    ]);

    expect(d.store.getSessionActivity(sessionId)).toMatchObject({ state: 'done', turnId: null, seq: 4 });
    expect(d.store.getMessages(sessionId).filter((row) => row.role === 'user').map((row) => JSON.parse(row.content) as unknown)).toEqual([
      { role: 'user', content: 'first concurrent turn' },
      { role: 'user', content: 'second concurrent turn' },
    ]);
  });

  it('tracks an idle internal completion wake as a new owner turn', async () => {
    const d = fakeDeps();
    const svc = new BrainService(d as never);
    await svc.start(1);
    const sessionId = svc.status(1).sessionId!;

    await svc.send({ userId: 1, text: 'background result', internal: { kind: 'systemNudge' } } as never);

    expect(d.store.getSessionActivity(sessionId)).toMatchObject({ state: 'done', turnId: null });
  });

  it('settles an idle delegate completion wake as done', async () => {
    const d = fakeDeps();
    const svc = new BrainService(d as never);
    await svc.start(1);
    const sessionId = svc.status(1).sessionId!;
    const child = 'brain-ch-subagent-activity-delegate';
    d.store.createSession({ id: child, userId: 1, model: 'm', parentSessionId: sessionId });
    d.store.upsertSubagentRun(sessionId, { id: 'call-activity-delegate', sessionId: child, status: 'done', task: 'inspect', tools: 1, seconds: 1 });
    const runner = (svc as unknown as { turnRunner: { acceptSubagentCompletion: (parent: string, userId: number, result: unknown) => void } }).turnRunner;

    runner.acceptSubagentCompletion(sessionId, 1, {
      id: 'result-activity-delegate', toolCallId: 'call-activity-delegate', sessionId: child,
      status: 'done', task: 'inspect', result: 'done', tools: 1, seconds: 1,
    });
    await vi.waitFor(() => expect(d.store.pendingSubagentResults(sessionId)).toEqual([]));

    expect(d.store.getSessionActivity(sessionId)).toMatchObject({ state: 'done', seq: 2, turnId: null });
  });

  it('settles an idle delegate completion wake as failed when its model turn fails', async () => {
    const d = fakeDeps();
    const svc = new BrainService(d as never);
    await svc.start(1);
    const sessionId = svc.status(1).sessionId!;
    const child = 'brain-ch-subagent-activity-delegate-failed';
    d.store.createSession({ id: child, userId: 1, model: 'm', parentSessionId: sessionId });
    d.store.upsertSubagentRun(sessionId, { id: 'call-activity-delegate-failed', sessionId: child, status: 'done', task: 'inspect', tools: 1, seconds: 1 });
    d.session.sendCustomMessage.mockRejectedValueOnce(new Error('provider unavailable'));
    const runner = (svc as unknown as { turnRunner: { acceptSubagentCompletion: (parent: string, userId: number, result: unknown) => void } }).turnRunner;

    runner.acceptSubagentCompletion(sessionId, 1, {
      id: 'result-activity-delegate-failed', toolCallId: 'call-activity-delegate-failed', sessionId: child,
      status: 'done', task: 'inspect', result: 'done', tools: 1, seconds: 1,
    });
    await vi.waitFor(() => expect(d.store.getSessionActivity(sessionId)?.state).toBe('failed'));
  });

  it('settles an idle workflow completion wake as done', async () => {
    const d = fakeDeps();
    const svc = new BrainService(d as never);
    await svc.start(1);
    const sessionId = svc.status(1).sessionId!;
    d.store.upsertWorkflowRun(sessionId, { id: 'wf-activity', toolCallId: 'call-wf-activity', status: 'running', nodes: [] });
    const runner = (svc as unknown as { turnRunner: { acceptWorkflowCompletion: (parent: string, userId: number, result: unknown) => void } }).turnRunner;

    runner.acceptWorkflowCompletion(sessionId, 1, {
      id: 'wf-activity', toolCallId: 'call-wf-activity', status: 'done', result: 'done',
    });
    await vi.waitFor(() => expect(d.store.pendingSubagentResults(sessionId)).toEqual([]));

    expect(d.store.getSessionActivity(sessionId)).toMatchObject({ state: 'done', seq: 2, turnId: null });
  });

  it('settles an idle workflow completion wake as failed when its model turn fails', async () => {
    const d = fakeDeps();
    const svc = new BrainService(d as never);
    await svc.start(1);
    const sessionId = svc.status(1).sessionId!;
    d.store.upsertWorkflowRun(sessionId, { id: 'wf-activity-failed', toolCallId: 'call-wf-activity-failed', status: 'running', nodes: [] });
    d.session.sendCustomMessage.mockRejectedValueOnce(new Error('provider unavailable'));
    const runner = (svc as unknown as { turnRunner: { acceptWorkflowCompletion: (parent: string, userId: number, result: unknown) => void } }).turnRunner;

    runner.acceptWorkflowCompletion(sessionId, 1, {
      id: 'wf-activity-failed', toolCallId: 'call-wf-activity-failed', status: 'error', result: 'failed',
    });
    await vi.waitFor(() => expect(d.store.getSessionActivity(sessionId)?.state).toBe('failed'));
  });
});

describe('recovery notices racing owner admission', () => {
  function recoveryNotice(d: ReturnType<typeof fakeDeps>, parent: string, suffix = 'late') {
    const child = `brain-ch-subagent-${suffix}`;
    const toolCallId = `call-${suffix}`;
    d.store.createSession({ id: child, userId: 1, model: 'm', parentSessionId: parent, delegatedAccess: { admin: true, owner: true, projectIds: [], permissionBoundary: null } });
    d.store.setDelegationBootId(`old-${suffix}`);
    d.store.upsertSubagentRun(parent, { id: toolCallId, sessionId: child, status: 'running', task: 'inspect', tools: 1, seconds: 1 });
    d.store.setDelegationBootId(`new-${suffix}`);
    expect(d.store.claimRecoverableRuns(60_000)).toHaveLength(1);
    return () => {
      expect(d.store.markRecoveryRequired(parent, toolCallId, 'delegation aborted', {
        id: `notice-${suffix}`, toolCallId, sessionId: child, status: 'error', task: 'inspect', error: 'delegation aborted', tools: 1, seconds: 1,
      })).toBe(true);
    };
  }

  it('restores a notice created at preflight and admits the same owner message exactly once', async () => {
    const d = fakeDeps();
    const svc = new BrainService(d as never);
    await svc.start(1);
    const sessionId = svc.status(1).sessionId!;
    const arrive = recoveryNotice(d, sessionId);
    const original = d.session.prompt.getMockImplementation()!;
    const rejected: string[] = [];
    const runner = (svc as unknown as { turnRunner: BrainTurnRunner }).turnRunner;
    let concurrentDrain: Promise<unknown> | undefined;
    d.session.prompt.mockImplementationOnce(async (text, options) => {
      arrive();
      // Recovery's completion hook can already be queued on the locks this admission holds.
      concurrentDrain = runner.drainPendingSubagentResults(1, sessionId);
      await Promise.resolve();
      try { await original(text, options); }
      catch (error) { rejected.push((error as Error).message); throw error; }
    });
    const accepted = vi.fn();
    const seen: { type: string }[] = [];
    svc.subscribe(1, (event) => seen.push(event));

    await svc.send({ userId: 1, text: 'keep my message', onAdmitted: accepted });
    await concurrentDrain;

    expect(rejected).toEqual(['unsafe sub-agent recovery notice could not be restored']);
    expect(d.session.prompt).toHaveBeenCalledTimes(2);
    expect(accepted).toHaveBeenCalledTimes(1);
    expect(seen.filter((event) => event.type === 'user')).toHaveLength(1);
    expect(seen.some((event) => event.type === 'discard_user')).toBe(false);
    expect(d.store.getMessages(sessionId).filter((row) => row.role === 'user')).toHaveLength(1);
    expect(d.session.messages.map((message) => message.role)).toEqual(['custom', 'user', 'assistant']);
    expect(d.session.sendCustomMessage).toHaveBeenCalledWith(expect.objectContaining({ details: expect.objectContaining({ resultId: 'notice-late' }) }), { triggerTurn: false, deliverAs: 'followUp' });
    expect(d.store.pendingSubagentResults(sessionId)).toEqual([]);
    expect(d.store.getSessionActivity(sessionId)).toMatchObject({ state: 'done' });
  });

  it('does not mistake an unrelated error with identical wording for its preflight guard', async () => {
    const d = fakeDeps();
    const svc = new BrainService(d as never);
    await svc.start(1);
    d.session.prompt.mockRejectedValueOnce(new Error('unsafe sub-agent recovery notice could not be restored'));
    const accepted = vi.fn();

    await expect(svc.send({ userId: 1, text: 'unrelated failure', onAdmitted: accepted })).rejects.toThrow('unsafe sub-agent recovery notice could not be restored');
    expect(d.session.prompt).toHaveBeenCalledTimes(1);
    expect(accepted).not.toHaveBeenCalled();
  });

  it.each(['throws', 'does not append'])('fails closed when locked notice restoration %s', async (failure) => {
    const d = fakeDeps();
    const svc = new BrainService(d as never);
    await svc.start(1);
    const sessionId = svc.status(1).sessionId!;
    const arrive = recoveryNotice(d, sessionId);
    const original = d.session.prompt.getMockImplementation()!;
    d.session.prompt.mockImplementationOnce(async (text, options) => { arrive(); await original(text, options); });
    if (failure === 'throws') d.session.sendCustomMessage.mockRejectedValueOnce(new Error('custom append failed'));
    else d.session.sendCustomMessage.mockResolvedValueOnce(undefined);
    const accepted = vi.fn();

    await expect(svc.send({ userId: 1, text: 'retain the recovery warning', onAdmitted: accepted })).rejects.toThrow(
      failure === 'throws' ? 'custom append failed' : 'unsafe sub-agent recovery notice could not be restored');
    expect(d.session.prompt).toHaveBeenCalledTimes(1);
    expect(accepted).not.toHaveBeenCalled();
    expect(d.store.pendingSubagentResults(sessionId)).toHaveLength(1);
    expect(d.session.messages.some((message) => message.role === 'user')).toBe(false);
  });

  it('does not retry an internal turn or let it bypass a late unsafe notice', async () => {
    const d = fakeDeps();
    const svc = new BrainService(d as never);
    await svc.start(1);
    const sessionId = svc.status(1).sessionId!;
    const arrive = recoveryNotice(d, sessionId);
    const original = d.session.prompt.getMockImplementation()!;
    d.session.prompt.mockImplementationOnce(async (text, options) => { arrive(); await original(text, options); });

    await expect(svc.send({ userId: 1, text: 'automatic wake', internal: { kind: 'systemNudge' } })).rejects.toThrow('unsafe sub-agent recovery notice could not be restored');
    expect(d.session.prompt).toHaveBeenCalledTimes(1);
    expect(d.session.messages.some((message) => message.role === 'user')).toBe(false);
    expect(d.store.pendingSubagentResults(sessionId)).toHaveLength(1);
  });

  it('retries preparation only once and keeps a second late notice fail-closed', async () => {
    const d = fakeDeps();
    const svc = new BrainService(d as never);
    await svc.start(1);
    const sessionId = svc.status(1).sessionId!;
    const arrive = recoveryNotice(d, sessionId);
    const original = d.session.prompt.getMockImplementation()!;
    d.session.prompt.mockImplementationOnce(async (text, options) => { arrive(); await original(text, options); });
    d.session.prompt.mockImplementationOnce(async (text, options) => {
      recoveryNotice(d, sessionId, 'second')();
      await original(text, options);
    });
    const accepted = vi.fn();

    await expect(svc.send({ userId: 1, text: 'not admitted yet', onAdmitted: accepted })).rejects.toThrow('unsafe sub-agent recovery notice could not be restored');
    expect(d.session.prompt).toHaveBeenCalledTimes(2);
    expect(accepted).not.toHaveBeenCalled();
    expect(d.session.messages.some((message) => message.role === 'user')).toBe(false);
    expect(d.store.pendingSubagentResults(sessionId)).toHaveLength(2);
  });

  it('never retries or retracts an already admitted owner message', async () => {
    const d = fakeDeps();
    const svc = new BrainService(d as never);
    await svc.start(1);
    const sessionId = svc.status(1).sessionId!;
    const arrive = recoveryNotice(d, sessionId);
    d.session.prompt.mockImplementationOnce(async (_text, options) => {
      options?.preflightResult?.(true);
      // Even a second callback from a provider/extension cannot make an accepted turn replayable.
      arrive();
      options?.preflightResult?.(true);
    });
    const accepted = vi.fn();
    const seen: { type: string }[] = [];
    svc.subscribe(1, (event) => seen.push(event));

    await expect(svc.send({ userId: 1, text: 'already admitted', onAdmitted: accepted })).rejects.toThrow('unsafe sub-agent recovery notice could not be restored');
    expect(d.session.prompt).toHaveBeenCalledTimes(1);
    expect(accepted).toHaveBeenCalledTimes(1);
    expect(d.store.getMessages(sessionId).filter((row) => row.role === 'user')).toHaveLength(1);
    expect(seen.some((event) => event.type === 'discard_user')).toBe(false);
  });
});

describe('the activity feed reports work that actually runs', () => {
  // The feed is streamed live to attached browsers, so a row for work that was refused a line later is
  // not merely untidy: it says somebody is working when nobody is, once per dropped nudge.
  it('does not announce a system nudge that is dropped because the session is busy', async () => {
    const d = fakeDeps();
    const svc = new BrainService(d as never);
    await svc.start(1);
    d.session.isStreaming = true;

    await svc.send({ userId: 1, text: 'your command finished', internal: { kind: 'systemNudge' } } as never);

    expect(d.activity).toEqual([]);
  });

  it('still announces a turn that runs', async () => {
    const d = fakeDeps();
    const svc = new BrainService(d as never);
    await svc.start(1);

    await svc.send({ userId: 1, text: 'hello', surface: 'web' });

    expect(d.activity).toEqual([{ actorUserId: 1, surface: 'web', target: svc.status(1).sessionId }]);
  });
});

describe('a message steered into a running turn settles like the room surface settles one', () => {
  // Owner steer returned before any settlement while a room stamped the writer, so the two surfaces
  // disagreed about a message that reached the model either way — the divergence this shared settlement
  // exists to remove.
  it('stamps the writer for a message folded into somebody\'s running turn', async () => {
    const d = fakeDeps();
    const svc = new BrainService(d as never);
    await svc.start(1);
    await svc.send({ userId: 1, text: 'start something long' });
    const sessionId = svc.status(1).sessionId!;
    d.store.db.prepare('UPDATE brain_sessions SET last_writer_user_id = NULL').run();
    d.session.isStreaming = true;

    await svc.send({ userId: 1, text: 'also check the logs' });

    expect(d.session.steer).toHaveBeenCalled();
    expect(d.store.getSession(sessionId)!.last_writer_user_id).toBe(1);
  });
});
