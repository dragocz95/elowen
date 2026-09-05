import { describe, expect, it, vi } from 'vitest';
import { ConversationLifecycle } from '../../src/brain/service/lifecycle.js';
import { ClientAttachments } from '../../src/brain/service/attachments.js';
import { CardRegistry } from '../../src/brain/cards.js';
import { LiveSessionRegistry, sendLockKey } from '../../src/brain/session/liveRegistry.js';
import type { LiveBrain, SpawnOpts } from '../../src/brain/session/liveBrain.js';

/** `/clear` empties ONE conversation in place: the durable rows go, the live PI session is replaced, and
 *  the conversation keeps its id/model/clients. These tests pin the two halves that make it safe — the
 *  wipe never runs under work in flight, and the respawn never inherits the cleared conversation's
 *  prompt/cadence state. */

const SESSION = 'brain-1';

interface LiveSpec {
  model?: string;
  isStreaming?: boolean;
  isCompacting?: boolean;
  steering?: string[];
  /** A session as the SPAWNER builds it: no prompt/cadence history at all. Anything set on it afterwards
   *  was carried there by the code under test, which is what makes the "not inherited" assertions real. */
  fresh?: boolean;
}

function live(spec: LiveSpec = {}): LiveBrain {
  return {
    session: {
      dispose: vi.fn(),
      isStreaming: spec.isStreaming ?? false,
      isCompacting: spec.isCompacting ?? false,
      getSteeringMessages: () => spec.steering ?? [],
      getFollowUpMessages: () => [],
    } as never,
    sessionId: SESSION,
    providerId: 'openai',
    model: spec.model ?? 'gpt-5.5',
    thinkingLevel: 'high',
    requestProfile: {},
    fastAvailable: true,
    thinkingLabels: {},
    workDir: '/srv/project',
    policy: { allowedProjectIds: 'all', allowedPaths: () => [] },
    listeners: new Set(),
    replay: { publish: vi.fn() } as never,
    turnContext: () => ({ beforeUser: '', afterUser: '' }),
    pluginToolNames: new Set(),
    // Prompt/cadence state a cleared context must NOT inherit — the model never read anything "earlier in
    // this conversation" once the history is gone (see InPlaceRespawnState).
    lastTurnMode: spec.fresh ? undefined : 'plan',
    orientedForCompaction: spec.fresh ? false : true,
    modeReminderTurns: spec.fresh ? 0 : 4,
  } as unknown as LiveBrain;
}

function makeLifecycle(sessions: LiveSessionRegistry<LiveBrain>, spawn: (opts: SpawnOpts) => Promise<LiveBrain>, storeOverrides: Record<string, unknown> = {}) {
  // Mirrors the real store closely enough for the lifecycle contract: one wipe empties the history and
  // the cards AND stamps cleared_at, which is the only durable evidence the conversation was ever used.
  let row: Record<string, unknown> = {
    id: SESSION, user_id: 1, work_dir: '/srv/project', model: 'gpt-5.5', provider: 'openai',
    title: 'Deploy plan', cleared_at: null,
  };
  let messages = 1;
  let cardRows = [{ id: 'todo', title: 'Plan', items: [{ text: 'ship it', status: 'pending' as const }], pinned: true }];
  const deleteSession = vi.fn();
  const clearSessionHistory = vi.fn(() => {
    cardRows = [];
    messages = 0;
    row = { ...row, cleared_at: '2026-08-18 20:00:00' };
  });
  const cards = new CardRegistry(() => ({ upsertCard: vi.fn(), deleteCard: vi.fn(), getCards: () => cardRows }));
  // Clearing also stands the conversation's durable activity down: a wiped transcript must not go on
  // answering "finished, unread result" about output that no longer exists. The double makes the same
  // three moves the real store does, so the reset is exercised here rather than merely tolerated.
  let activity = {
    state: 'done', seq: 3, readSeq: 0, turnId: null as string | null, bootId: null as string | null,
    detail: 'finished', at: '2026-08-18 10:00:00', webParticipatedAt: '2026-08-18 09:00:00',
  };
  const store = {
    getSession: () => row,
    listSessions: () => [row],
    lastMessageAt: () => (messages > 0 ? '2026-08-18 10:00:00' : undefined),
    deleteSession,
    clearSessionHistory,
    getSubagentRuns: () => [],
    getWorkflowRuns: () => [],
    getGoal: () => undefined,
    pendingSubagentResults: () => [],
    getSessionActivity: () => activity,
    resetSessionActivity: vi.fn(() => {
      activity = { ...activity, state: 'idle', seq: activity.seq + 1, turnId: null, bootId: null, detail: '' };
      return true;
    }),
    // Neutral, not a new unread event: an established web baseline is carried forward with the reset.
    ackSessionActivity: vi.fn(() => { activity = { ...activity, readSeq: activity.seq }; return true; }),
    ...storeOverrides,
  };
  const lifecycle = new ConversationLifecycle({
    store,
    sessions,
    attachments: new ClientAttachments(),
    elicitation: { cancelForSession: vi.fn(), pendingForSession: () => null },
    goals: { cancelGoalContinuation: vi.fn(), resumeAfterRespawn: vi.fn(), pauseForRespawnFailure: vi.fn() },
    cards,
    spawn,
    policy: () => ({ allowedProjectIds: 'all', allowedPaths: () => [] }),
    userSettings: () => ({ autoCompact: true, autoCompactAt: 80 }),
    selectionAllowed: () => true,
  } as never);
  return {
    lifecycle, store, clearSessionHistory, cards, deleteSession,
    /** Let a test drive the two states the real store distinguishes. */
    __setRow: (patch: Record<string, unknown>) => { row = { ...row, ...patch }; },
    __setMessageCount: (n: number) => { messages = n; },
    __activity: () => activity,
  };
}

describe('ConversationLifecycle.clearConversation', () => {
  it('wipes the stored history and respawns the SAME conversation on the SAME model, without inheriting its prompt state', async () => {
    const sessions = new LiveSessionRegistry<LiveBrain>();
    const original = live();
    sessions.set(SESSION, original);
    let fresh!: LiveBrain;
    const spawn = vi.fn(async () => { fresh = live({ fresh: true }); return fresh; });
    const { lifecycle, clearSessionHistory } = makeLifecycle(sessions, spawn);

    const result = await lifecycle.clearConversation(1, SESSION);

    expect(clearSessionHistory).toHaveBeenCalledExactlyOnceWith(SESSION);
    expect(original.session.dispose).toHaveBeenCalledTimes(1);
    // Same id, same model/provider — the identity of the conversation survives the wipe. The model is
    // passed EXPLICITLY because an emptied history no longer reports the session as spoken-in, which is
    // what the spawn's own pin restore keys on.
    expect(result).toEqual({ sessionId: SESSION, model: 'gpt-5.5' });
    expect(spawn).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      sessionId: SESSION,
      selection: { provider: 'openai', model: 'gpt-5.5' },
      clientCwd: '/srv/project',
      thinkingLevel: 'high',
    }));
    expect(spawn.mock.calls[0]![0]).not.toHaveProperty('fast');
    expect(sessions.get(SESSION)).toBe(fresh);
    // Deliberately NOT carried: a cleared context has no "earlier in this conversation" to point at, so
    // the respawn must keep the spawner's own blank state rather than `original`'s plan/oriented/reminder.
    expect(original.lastTurnMode).toBe('plan'); // the state that must NOT travel
    expect(fresh.lastTurnMode).toBeUndefined();
    expect(fresh.orientedForCompaction).toBe(false);
    expect(fresh.modeReminderTurns).toBe(0);
  });

  it('tells attached clients to rebuild: a `compacted` refetch plus an empty card for every cleared panel', async () => {
    const sessions = new LiveSessionRegistry<LiveBrain>();
    sessions.set(SESSION, live());
    let fresh!: LiveBrain;
    const { lifecycle, cards } = makeLifecycle(sessions, async () => { fresh = live({ fresh: true }); return fresh; });
    expect(cards.forSession(SESSION)).toHaveLength(1);

    await lifecycle.clearConversation(1, SESSION);

    const published = (fresh.replay.publish as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(published).toContainEqual({ type: 'compacted' });
    // An empty card is the panel's REMOVE signal (see upsertCard) — without it a client keeps rendering
    // the todo checklist of the conversation that was just cleared.
    expect(published).toContainEqual({ type: 'card', card: { id: 'todo', pinned: false } });
    // Never a raw `session` event: the id did not change, and the surfaces read that as an idle rollover.
    expect(published.some((e) => (e as { type: string }).type === 'session')).toBe(false);
    expect(cards.forSession(SESSION)).toEqual([]); // the write-through cache was evicted with the rows
  });

  /** The rail reads the activity slice, not the transcript, so a wipe that left it alone would keep a
   *  green "finished" check and an unread badge pointing at messages that no longer exist — and the badge
   *  could never be cleared, because opening the conversation shows nothing to read. */
  it('stands the conversation activity down with the history it describes', async () => {
    const sessions = new LiveSessionRegistry<LiveBrain>();
    sessions.set(SESSION, live());
    const harness = makeLifecycle(sessions, async () => live({ fresh: true }));
    expect(harness.__activity()).toMatchObject({ state: 'done', detail: 'finished' });

    await harness.lifecycle.clearConversation(1, SESSION);

    const after = harness.__activity();
    expect(after).toMatchObject({ state: 'idle', turnId: null, detail: '' });
    // Neutral, not a new unread event: the reset bumps the sequence, and the acknowledgement follows it
    // so a conversation the user just emptied does not come back bolded.
    expect(after.readSeq).toBe(after.seq);
  });

  it('clears a conversation with no live session (durable half only)', async () => {
    const sessions = new LiveSessionRegistry<LiveBrain>();
    const spawn = vi.fn(async () => live({ fresh: true }));
    const { lifecycle, clearSessionHistory } = makeLifecycle(sessions, spawn);

    const result = await lifecycle.clearConversation(1, SESSION);

    expect(clearSessionHistory).toHaveBeenCalledExactlyOnceWith(SESSION);
    expect(spawn).not.toHaveBeenCalled();
    expect(result).toEqual({ sessionId: SESSION, model: 'gpt-5.5' });
  });

  /** A cleared conversation has no messages, which is exactly how an empty never-used shell looks — and
   *  those get swept on quit (dropIfUnspoken) and by /new (pruneEmptyConversations). Without the
   *  cleared_at stamp `/clear` would hand the user a conversation that deletes itself the moment they
   *  close the CLI, taking its id, title and model with it. */
  it('leaves a cleared conversation immune to the unspoken-shell sweep, unlike a never-used one', async () => {
    const sessions = new LiveSessionRegistry<LiveBrain>();
    sessions.set(SESSION, live());
    const harness = makeLifecycle(sessions, async () => live({ fresh: true }));

    await harness.lifecycle.clearConversation(1, SESSION);
    sessions.dispose(SESSION); // the CLI quits: the live record goes, then the sweep runs
    harness.lifecycle.dropIfUnspoken(SESSION);
    expect(harness.deleteSession).not.toHaveBeenCalled();

    // The same sweep on a conversation that was merely opened and never used still removes the shell.
    const other = makeLifecycle(new LiveSessionRegistry<LiveBrain>(), async () => live({ fresh: true }));
    other.__setMessageCount(0);
    other.lifecycle.dropIfUnspoken(SESSION);
    expect(other.deleteSession).toHaveBeenCalledWith(SESSION);
  });

  /** The stored model/provider pin is only restored for a conversation that has been spoken in — evidence
   *  a clear destroys. A cold respawn (daemon restart) after `/clear` must still come back on the model
   *  the conversation was running on, not on the user's global default. */
  it('keeps the model pin across a COLD respawn of a cleared conversation', async () => {
    const sessions = new LiveSessionRegistry<LiveBrain>();
    const spawn = vi.fn(async () => live({ fresh: true }));
    const harness = makeLifecycle(sessions, spawn, {});
    harness.__setMessageCount(0);
    harness.__setRow({ cleared_at: '2026-08-18 20:00:00' });

    await harness.lifecycle.ensureLive(1, SESSION);

    expect(spawn).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      sessionId: SESSION, selection: { provider: 'openai', model: 'gpt-5.5' },
    }));
  });

  it('refuses a foreign conversation before touching anything', async () => {
    const sessions = new LiveSessionRegistry<LiveBrain>();
    sessions.set(SESSION, live());
    const spawn = vi.fn(async () => live({ fresh: true }));
    const { lifecycle, clearSessionHistory } = makeLifecycle(sessions, spawn, {
      getSession: () => ({ id: SESSION, user_id: 2, work_dir: '' }),
    });

    await expect(lifecycle.clearConversation(1, SESSION)).rejects.toThrow('unknown session');
    expect(clearSessionHistory).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  describe('never deletes under a live writer', () => {
    const cases: { name: string; spec?: LiveSpec; store?: Record<string, unknown>; message: string }[] = [
      { name: 'a running turn', spec: { isStreaming: true }, message: 'busy' },
      { name: 'a queued steer waiting behind the turn', spec: { steering: ['and also…'] }, message: 'busy' },
      { name: 'a compaction rewriting the very rows to be deleted', spec: { isCompacting: true }, message: 'compacting' },
      { name: 'an active goal that re-prompts from a timer', store: { getGoal: () => ({ status: 'active' }) }, message: 'busy' },
      {
        name: 'a still-running background delegation',
        store: { getSubagentRuns: () => [{ status: 'running', background: true, sessionId: 'child-1' }] },
        message: 'busy',
      },
      {
        name: 'a finished child result that has not been delivered yet',
        store: { pendingSubagentResults: () => [{ id: 'res-1' }] },
        message: 'delegated result',
      },
    ];

    for (const c of cases) {
      it(`refuses with a clear reason: ${c.name}`, async () => {
        const sessions = new LiveSessionRegistry<LiveBrain>();
        const original = live(c.spec);
        sessions.set(SESSION, original);
        const spawn = vi.fn(async () => live({ fresh: true }));
        const { lifecycle, clearSessionHistory } = makeLifecycle(sessions, spawn, c.store);

        await expect(lifecycle.clearConversation(1, SESSION)).rejects.toThrow(c.message);
        // Nothing was deleted, nothing was disposed — the conversation is exactly as it was.
        expect(clearSessionHistory).not.toHaveBeenCalled();
        expect(original.session.dispose).not.toHaveBeenCalled();
        expect(spawn).not.toHaveBeenCalled();
        expect(sessions.get(SESSION)).toBe(original);
      });
    }

    // The send lock is the one a turn takes FIRST, and it holds it across the idle-rollover / vision-hop
    // awaits — a window in which the inner lock is free and isStreaming is still false. A clear that only
    // took the inner lock would pass its refusal check there, dispose the live session under that send,
    // and let it prompt() a disposed session still holding the pre-clear context in memory.
    it('waits behind the outer send lock, not just the inner prompt lock', async () => {
      const sessions = new LiveSessionRegistry<LiveBrain>();
      sessions.set(SESSION, live());
      const { lifecycle, clearSessionHistory } = makeLifecycle(sessions, async () => live({ fresh: true }));
      const order: string[] = [];
      let releaseSend!: () => void;
      const send = new Promise<void>((resolve) => { releaseSend = resolve; });
      // A send holds `send-<id>` for the whole turn while the bare id stays free across its awaits.
      void sessions.withLock(sendLockKey(SESSION), async () => { await send; order.push('send resolved its target'); });

      const clearing = lifecycle.clearConversation(1, SESSION).then(() => { order.push('cleared'); });
      await Promise.resolve();
      await Promise.resolve();
      expect(clearSessionHistory).not.toHaveBeenCalled(); // queued behind the send, nothing deleted yet

      releaseSend();
      await clearing;
      expect(order).toEqual(['send resolved its target', 'cleared']);
    });

    it('refuses a cold conversation whose goal timer would re-prompt the cleared context', async () => {
      // No live record: the shared predicate reports "no work" for one (there is nothing live to protect),
      // so the goal has to be checked on its own or a clear would silently race the goal loop.
      const sessions = new LiveSessionRegistry<LiveBrain>();
      const spawn = vi.fn(async () => live({ fresh: true }));
      const { lifecycle, clearSessionHistory } = makeLifecycle(sessions, spawn, { getGoal: () => ({ status: 'active' }) });

      await expect(lifecycle.clearConversation(1, SESSION)).rejects.toThrow('goal');
      expect(clearSessionHistory).not.toHaveBeenCalled();
    });

    it('waits behind whatever holds the session lock instead of deleting alongside it', async () => {
      const sessions = new LiveSessionRegistry<LiveBrain>();
      sessions.set(SESSION, live());
      const { lifecycle, clearSessionHistory } = makeLifecycle(sessions, async () => live({ fresh: true }));
      const order: string[] = [];
      let releaseTurn!: () => void;
      const turn = new Promise<void>((resolve) => { releaseTurn = resolve; });
      // A turn holds serial(sessionId) for its whole prompt() — this is that lock.
      void sessions.withLock(SESSION, async () => { await turn; order.push('turn persisted'); });

      const clearing = lifecycle.clearConversation(1, SESSION).then(() => { order.push('cleared'); });
      await Promise.resolve();
      expect(clearSessionHistory).not.toHaveBeenCalled(); // still queued behind the turn

      releaseTurn();
      await clearing;
      expect(order).toEqual(['turn persisted', 'cleared']);
    });
  });
});
