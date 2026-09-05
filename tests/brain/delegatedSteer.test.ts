import { describe, it, expect, vi } from 'vitest';
import { ChannelSessionService } from '../../src/brain/channels.js';
import { DelegatedSessionService } from '../../src/brain/service/delegatedSession.js';
import { channelSessionId } from '../../src/brain/sessionId.js';
import { LiveSessionRegistry } from '../../src/brain/session/liveRegistry.js';
import type { LiveBrain, QueuedMsg } from '../../src/brain/session/liveBrain.js';
import { deliverQueuedUserEcho, stageDeliveredUserEchoes } from '../../src/brain/session/queueMirror.js';
import { BrainStore } from '../../src/store/brainStore.js';
import { openDb } from '../../src/store/db.js';
import type { DelegatedExecutionScope } from '../../src/brain/delegatedScope.js';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

const SCOPE: DelegatedExecutionScope = { admin: true, projectIds: [], owner: true, permissionBoundary: null };

/** The minimal live record steerDelegatedTurn touches: PI queue admission (steer), the abort clear, and
 *  the mirror arrays enqueueMirrored maintains. clearQueue empties the mirrors the way the production
 *  queue_update reconcile does, so the strand cleanup's re-queue starts from the cleared state. */
function fakeLive(sessionId: string) {
  const live = {
    sessionId,
    session: {
      isStreaming: true,
      steer: vi.fn(async () => {}),
      clearQueue: vi.fn(() => { live.queuedSteer = []; live.queuedFollowUp = []; }),
      dispose: vi.fn(() => {}),
    },
    queuedSteer: undefined as QueuedMsg[] | undefined,
    queuedFollowUp: undefined as QueuedMsg[] | undefined,
    deliveringUserEchoes: undefined as QueuedMsg[] | undefined,
    listeners: new Set(),
    replay: { publish: vi.fn(), journal: vi.fn() },
  };
  return live;
}
type FakeLive = ReturnType<typeof fakeLive>;

function setup(opts: { parent?: boolean } = {}) {
  const store = new BrainStore(openDb(':memory:'));
  const registry = new LiveSessionRegistry<FakeLive>();
  const channelId = 'subagent-sub-dlg-steer';
  const sessionId = channelSessionId(channelId);
  store.createSession({ id: 'brain-parent', userId: 1, model: 'k3' });
  store.createSession({
    id: sessionId, userId: 1, model: 'k3',
    ...(opts.parent === false ? {} : { parentSessionId: 'brain-parent', delegatedAccess: SCOPE }),
  });
  const live = fakeLive(sessionId);
  registry.channelTouch(channelId, live);
  const svc = new ChannelSessionService({ registry, store, users: { get: () => ({ username: 'o' }) }, spawn: vi.fn() } as never);
  /** Simulate PI delivering one queued steer through the REAL production seam: queue_update splices the
   *  mirror and stages the removed item, then message_start persists the durable user row and stamps the
   *  item's echo (deliverQueuedUserEcho) — the exact signal steerDelegatedTurn waits for. */
  const deliver = (item: QueuedMsg): void => {
    live.queuedSteer = (live.queuedSteer ?? []).filter((m) => m !== item);
    if (item.queuedText === undefined) item.queuedText = item.text;
    stageDeliveredUserEchoes(live as unknown as LiveBrain, [item]);
    deliverQueuedUserEcho(store, live as unknown as LiveBrain, item.queuedText);
  };
  return { store, registry, svc, channelId, sessionId, live, deliver };
}

describe('ChannelSessionService.steerDelegatedTurn — delivery-confirmed mid-turn steer', () => {
  it('reports idle without enqueuing when the child has no streaming turn here', async () => {
    const { svc, channelId, live } = setup();
    live.session.isStreaming = false;
    expect(await svc.steerDelegatedTurn(channelId, 'late instruction')).toBe('idle');
    expect(live.session.steer).not.toHaveBeenCalled();
  });

  it('never steers a session without a durable parent, even while it streams (backstop)', async () => {
    const { svc, channelId, live } = setup({ parent: false });
    expect(await svc.steerDelegatedTurn(channelId, 'late instruction')).toBe('idle');
    expect(live.session.steer).not.toHaveBeenCalled();
  });

  it('resolves delivered only once the message shows up as a durable row in the child transcript', async () => {
    const { store, svc, channelId, sessionId, live, deliver } = setup();
    const pending = svc.steerDelegatedTurn(channelId, 'also check the docs');
    let settled: string | undefined;
    void pending.then((outcome) => { settled = outcome; });
    await sleep(20);
    // Enqueued into PI's steering queue with the persistable owner-echo, but NOT yet confirmed.
    expect(live.session.steer).toHaveBeenCalledWith('also check the docs', undefined);
    const item = (live.queuedSteer ?? [])[0];
    expect(item).toMatchObject({ text: 'also check the docs', echo: expect.objectContaining({ persistText: 'also check the docs', publish: true }) });
    // Two poll beats with the message still queued: the call must STILL BE PENDING — a steer that reports
    // success at enqueue time, before anything durable exists, must fail here.
    await sleep(220);
    expect(settled).toBeUndefined();
    deliver(item!);
    expect(await pending).toBe('delivered');
    // The confirmation was the real durable user row, not a bookkeeping shortcut.
    expect(store.getMessages(sessionId).filter((m) => m.role === 'user')).toHaveLength(1);
  });

  it('confirms each of two same-text steers only against its OWN delivery, never its twin\'s', async () => {
    const { store, svc, channelId, sessionId, live, deliver } = setup();
    const first = svc.steerDelegatedTurn(channelId, 'same follow-up');
    const second = svc.steerDelegatedTurn(channelId, 'same follow-up');
    let secondSettled: string | undefined;
    void second.then((outcome) => { secondSettled = outcome; });
    await sleep(20);
    const [itemA, itemB] = live.queuedSteer ?? [];
    expect(itemB).toBeDefined();
    // PI delivers the FIRST copy; its durable row matches the second steer's text byte for byte.
    deliver(itemA!);
    expect(await first).toBe('delivered');
    // The twin must NOT be confirmed by that row — it is still queued, still pending.
    await sleep(220);
    expect(secondSettled).toBeUndefined();
    // The turn ends with the twin still queued: it is removed and reported idle for the caller's fallback.
    live.session.isStreaming = false;
    expect(await second).toBe('idle');
    expect(live.queuedSteer ?? []).toEqual([]);
    // Exactly ONE durable user row: the fallback re-sends as a fresh turn, never from a stale queue copy.
    const rows = store.getMessages(sessionId).filter((m) => m.role === 'user'
      && (JSON.parse(m.content) as { content?: unknown }).content === 'same follow-up');
    expect(rows).toHaveLength(1);
  });

  it('keeps concurrent strand cleanups addressable across the clear-and-requeue — no copy survives to double-deliver', async () => {
    const { svc, channelId, live } = setup();
    live.queuedSteer = [{ text: 'bystander' }];
    const first = svc.steerDelegatedTurn(channelId, 'alpha');
    const second = svc.steerDelegatedTurn(channelId, 'beta');
    await sleep(20);
    expect((live.queuedSteer ?? []).map((m) => m.text)).toEqual(['bystander', 'alpha', 'beta']);
    // The turn ends with both steers still queued; both waiters clean up concurrently. The first cleanup
    // rebuilds the queue with FRESH wrapper objects, so the second must find its message by its durable
    // identity (the echo) — or its copy stays queued and the fallback re-send delivers the text twice.
    live.session.isStreaming = false;
    expect(await first).toBe('idle');
    expect(await second).toBe('idle');
    expect((live.queuedSteer ?? []).map((m) => m.text)).toEqual(['bystander']);
  });

  it('removes a steer the ending turn never drained and reports idle — no loss, no double delivery', async () => {
    const { svc, channelId, live } = setup();
    // Someone else's message is already queued; the cleanup must not take it down with ours.
    live.queuedSteer = [{ text: 'someone else\'s message' }];
    const pending = svc.steerDelegatedTurn(channelId, 'too late for this turn');
    await sleep(20);
    expect((live.queuedSteer ?? []).map((m) => m.text)).toEqual(['someone else\'s message', 'too late for this turn']);
    // The turn ends with both still queued: PI will never deliver them on its own.
    live.session.isStreaming = false;
    expect(await pending).toBe('idle');
    // Ours is gone (the caller re-delivers the text as a fresh turn); the bystander survived the sweep.
    expect(live.session.clearQueue).toHaveBeenCalled();
    expect((live.queuedSteer ?? []).map((m) => m.text)).toEqual(['someone else\'s message']);
    expect(live.session.steer).toHaveBeenCalledWith('someone else\'s message', undefined);
  });

  it('rejects and clears the queue when the delegation aborts while the steer waits', async () => {
    const { svc, channelId, sessionId, registry, live } = setup();
    const pending = svc.steerDelegatedTurn(channelId, 'redirect');
    await sleep(20);
    expect(live.session.steer).toHaveBeenCalled();
    registry.requestPendingAbort(sessionId);
    await expect(pending).rejects.toThrow('delegation aborted');
    expect(live.session.clearQueue).toHaveBeenCalled();
  });

  it('rejects before enqueuing anything when the abort fence is already up', async () => {
    const { svc, channelId, sessionId, registry, live } = setup();
    registry.requestPendingAbort(sessionId);
    await expect(svc.steerDelegatedTurn(channelId, 'redirect')).rejects.toThrow('delegation aborted');
    expect(live.session.steer).not.toHaveBeenCalled();
  });

  it('reports idle when the live record is disposed mid-wait — the queue died with it', async () => {
    const { svc, channelId, registry, live } = setup();
    const pending = svc.steerDelegatedTurn(channelId, 'redirect');
    await sleep(20);
    expect(live.session.steer).toHaveBeenCalled();
    registry.channelDispose(channelId);
    expect(await pending).toBe('idle');
  });
});

// The routing half: which home a busy child's follow-up is delivered to, and which guards precede any
// delivery at all. The steer/send seams are stubbed; everything else is the real service.
describe('DelegatedSessionService.continueSubagent — mid-turn children are steered, not refused', () => {
  const PARENT = 'brain-1';
  const CHILD = 'brain-ch-subagent-sub-dlg-abc';
  const CHANNEL = 'subagent-sub-dlg-abc';
  const ACCESS = { admin: true, projectIds: [], owner: true, permissionBoundary: null };

  function setupDelegated(opts: {
    localSteer?: 'delivered' | 'idle' | Error | (() => 'delivered' | 'idle');
    remote?: 'delivered' | 'idle' | 'aborted';
    remoteBusy?: boolean;
    wireRemote?: boolean;
  } = {}) {
    const store = new BrainStore(openDb(':memory:'));
    store.createSession({ id: PARENT, userId: 1, model: 'k3' });
    store.createSession({ id: CHILD, userId: 1, model: 'k3', parentSessionId: PARENT, delegatedAccess: SCOPE });
    const sessions = new LiveSessionRegistry<FakeLive>();
    const send = vi.fn(async () => 'the idle turn answered');
    const steerLocal = vi.fn(async () => {
      const v = opts.localSteer ?? 'idle';
      if (v instanceof Error) throw v;
      return typeof v === 'function' ? v() : v;
    });
    const steerRemote = vi.fn(async () => ({ outcome: opts.remote ?? 'idle' as const }));
    const releaseRemote = vi.fn(async () => ({ busy: opts.remoteBusy === true }));
    const svc = new DelegatedSessionService({
      store, sessions: sessions as never,
      // sendRemote is the call fence an idle continuation runs under (covered in tests/subagent/remoteFencing.test.ts).
      channelService: { send, steerDelegatedTurn: steerLocal, sendRemote: (_req: unknown, run: () => Promise<string>) => run() } as never,
      identity: { forDelegatedTurn: () => ({ platform: 'subagent', userId: 'subagent', admin: true, owner: true }) } as never,
      users: { get: () => ({}) } as never,
      releaseRemote,
      ...(opts.wireRemote === false ? {} : { steerRemote }),
    });
    return { store, sessions, svc, send, steerLocal, steerRemote, releaseRemote };
  }

  it('steers a hidden result into a parent RUNNING in the sub-agent runner', async () => {
    const { svc, send, steerRemote, releaseRemote } = setupDelegated({ remoteBusy: true, remote: 'delivered' });
    const result = '<system-reminder><subagent-result id="res-1">done</subagent-result></system-reminder>';

    await expect(svc.sendDelegated(1, CHILD, result, {
      internalSystem: { customType: 'subagent-result', resultId: 'res-1' },
    })).resolves.toBe('');

    expect(releaseRemote).toHaveBeenCalledWith(CHANNEL);
    expect(steerRemote).toHaveBeenCalledWith(CHANNEL, result);
    expect(send).not.toHaveBeenCalled();
  });

  it('still refuses a hidden result while the remote parent is busy but not steerable', async () => {
    const { svc, send, steerRemote } = setupDelegated({ remoteBusy: true, remote: 'idle' });

    await expect(svc.sendDelegated(1, CHILD, 'result', {
      internalSystem: { customType: 'subagent-result', resultId: 'res-1' },
    })).rejects.toThrow(/running in the sub-agent runner/);

    expect(steerRemote).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();
  });

  it('runs an idle child as its own turn and returns the reply', async () => {
    const { svc, send, steerLocal, steerRemote } = setupDelegated();
    const res = await svc.continueSubagent(PARENT, CHILD, 'go on', ACCESS);
    expect(res).toEqual({ status: 'reply', reply: 'the idle turn answered' });
    expect(steerLocal).not.toHaveBeenCalled();
    expect(steerRemote).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('steers into a child running IN THIS PROCESS and never also runs a fresh turn', async () => {
    const { svc, sessions, send, steerLocal, steerRemote } = setupDelegated({ localSteer: 'delivered' });
    sessions.setChildRunning(PARENT, CHILD, true);
    const res = await svc.continueSubagent(PARENT, CHILD, 'also check the docs', ACCESS);
    expect(res).toEqual({ status: 'steered' });
    expect(steerLocal).toHaveBeenCalledWith(CHANNEL, 'also check the docs');
    expect(steerRemote).not.toHaveBeenCalled(); // the local turn took it — never delivered twice
    expect(send).not.toHaveBeenCalled();
  });

  it('steers THROUGH the runner when the turn body lives there', async () => {
    const { svc, sessions, send, steerLocal, steerRemote } = setupDelegated({ localSteer: 'idle', remote: 'delivered' });
    sessions.setChildRunning(PARENT, CHILD, true);
    const res = await svc.continueSubagent(PARENT, CHILD, 'also check the docs', ACCESS);
    expect(res).toEqual({ status: 'steered' });
    expect(steerLocal).toHaveBeenCalled();
    expect(steerRemote).toHaveBeenCalledWith(CHANNEL, 'also check the docs');
    expect(send).not.toHaveBeenCalled();
  });

  it('surfaces a remote abort verdict as the delegation-aborted error', async () => {
    const { svc, sessions, send } = setupDelegated({ localSteer: 'idle', remote: 'aborted' });
    sessions.setChildRunning(PARENT, CHILD, true);
    await expect(svc.continueSubagent(PARENT, CHILD, 'x', ACCESS)).rejects.toThrow('delegation aborted');
    expect(send).not.toHaveBeenCalled();
  });

  it('refuses, retryably, a child that is active but steerable nowhere (queued turn / collect gap)', async () => {
    const { svc, sessions, send } = setupDelegated({ localSteer: 'idle', wireRemote: false });
    sessions.setChildRunning(PARENT, CHILD, true);
    await expect(svc.continueSubagent(PARENT, CHILD, 'x', ACCESS))
      .rejects.toThrow(/try again in a moment/);
    // The one thing this window must never do: run a fresh turn that could go live in two processes.
    expect(send).not.toHaveBeenCalled();
  });

  it('falls through to a fresh turn when the delegation ended while the steer looked', async () => {
    const { svc, sessions, send } = setupDelegated({
      // The child finished between the registry check and the steer: the steer sees no turn, and by the
      // time the active check repeats, the delegation is gone.
      localSteer: () => { sessions.setChildRunning(PARENT, CHILD, false); return 'idle'; },
      wireRemote: false,
    });
    sessions.setChildRunning(PARENT, CHILD, true);
    const res = await svc.continueSubagent(PARENT, CHILD, 'x', ACCESS);
    expect(res).toEqual({ status: 'reply', reply: 'the idle turn answered' });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('refuses a model switch while the child turn runs — a running turn cannot change model', async () => {
    const { svc, sessions, send, steerLocal } = setupDelegated({ localSteer: 'delivered' });
    sessions.setChildRunning(PARENT, CHILD, true);
    await expect(svc.continueSubagent(PARENT, CHILD, 'x', ACCESS, undefined, 'anthropic/claude-sonnet-5'))
      .rejects.toThrow(/cannot switch model/);
    expect(steerLocal).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('checks scope BEFORE any delivery: a narrowed parent cannot steer into a wider child', async () => {
    const { svc, sessions, steerLocal, steerRemote, send } = setupDelegated({ localSteer: 'delivered' });
    sessions.setChildRunning(PARENT, CHILD, true);
    await expect(svc.continueSubagent(PARENT, CHILD, 'x', { ...ACCESS, admin: false, owner: false }))
      .rejects.toThrow(/cannot continue that sub-agent/);
    expect(steerLocal).not.toHaveBeenCalled();
    expect(steerRemote).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('never lets a foreign conversation steer someone else\'s child', async () => {
    const { svc, sessions, steerLocal } = setupDelegated({ localSteer: 'delivered' });
    sessions.setChildRunning(PARENT, CHILD, true);
    await expect(svc.continueSubagent('brain-2', CHILD, 'x', ACCESS)).rejects.toThrow('unknown sub-agent');
    expect(steerLocal).not.toHaveBeenCalled();
  });
});
