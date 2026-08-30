import { describe, expect, it, vi } from 'vitest';
import { ConversationLifecycle } from '../../src/brain/service/lifecycle.js';
import { ClientAttachments } from '../../src/brain/service/attachments.js';
import { LiveSessionRegistry } from '../../src/brain/session/liveRegistry.js';
import type { LiveBrain, SpawnOpts } from '../../src/brain/session/liveBrain.js';

/** A minimal LiveBrain for the switchModel lifecycle. Its `session` carries dispose/isStreaming, and
 *  `replay.publish` is a spy so the reconcile `session-event` and any raw `session` reset are both
 *  observable. */
function live(spec: { provider?: string; model: string }): LiveBrain {
  return {
    session: {
      dispose: vi.fn(),
      isStreaming: false,
    } as never,
    sessionId: 'brain-1',
    providerId: spec.provider,
    model: spec.model,
    thinkingLevel: undefined,
    requestProfile: { fast: false },
    fastAvailable: false,
    thinkingLabels: {},
    policy: { allowedProjectIds: 'all', allowedPaths: () => [] },
    listeners: new Set(),
    replay: { publish: vi.fn() } as never,
    turnContext: () => ({ beforeUser: '', afterUser: '' }),
    pluginToolNames: new Set(),
  };
}

function makeLifecycle(
  sessions: LiveSessionRegistry<LiveBrain>,
  spawn: (opts: SpawnOpts) => Promise<LiveBrain>,
  attachments: ClientAttachments = new ClientAttachments(),
) {
  const appendSessionEvent = vi.fn((sessionId: string, kind: string, detail: string) => ({
    id: 'evt-1', kind, detail, at: '2026-07-16T00:00:00.000Z',
  }));
  const store = {
    getSession: () => ({ id: 'brain-1', user_id: 1, work_dir: '' }),
    listSessions: () => [{ id: 'brain-1', user_id: 1, work_dir: '' }],
    lastMessageAt: () => 1_000, // spoken-in conversation → the session-event marker path runs
    appendSessionEvent,
    deleteSession: vi.fn(),
  };
  const lifecycle = new ConversationLifecycle({
    store,
    sessions,
    attachments,
    elicitation: { cancelForSession: vi.fn() },
    goals: { cancelGoalContinuation: vi.fn(), resumeAfterRespawn: vi.fn(), pauseForRespawnFailure: vi.fn() },
    spawn,
    policy: () => ({ allowedProjectIds: 'all', allowedPaths: () => [] }),
    userSettings: () => ({ autoCompact: false, autoCompactAt: 80 }),
    selectionAllowed: () => true,
  } as never);
  return { lifecycle, store, appendSessionEvent, attachments };
}

describe('ConversationLifecycle model switch (invariant 3)', () => {
  it('carries every listener ClientAttachments has on this session onto the respawned session, drains before disposing, and publishes exactly one model reconcile', async () => {
    const sessions = new LiveSessionRegistry<LiveBrain>();
    const attachments = new ClientAttachments();
    const original = live({ provider: 'p', model: 'model-a' });
    sessions.set('brain-1', original);
    const l1 = vi.fn();
    const l2 = vi.fn();
    // Listener ownership lives in ClientAttachments (attach()), not on the transient LiveBrain — this is
    // what subscribe()/tapSession() do; direct `.listeners.add` is no longer how a respawn restores them.
    attachments.attach(1, 'brain-1', l1, vi.fn());
    attachments.attach(1, 'brain-1', l2, vi.fn());

    let fresh!: LiveBrain;
    const spawn = vi.fn(async (opts: SpawnOpts) => {
      fresh = live({ provider: 'p', model: 'model-b' });
      // Mirrors LiveSessionSpawner: every respawn restores whatever ClientAttachments still has attached
      // to this session id.
      for (const l of attachments.sessionTaps.get(opts.sessionId) ?? []) fresh.listeners.add(l);
      return fresh;
    });
    const { lifecycle, appendSessionEvent, store } = makeLifecycle(sessions, spawn, attachments);

    await lifecycle.switchModel(1, { provider: 'p', model: 'model-b' });

    // spawn once — no second turn/respawn — with the new selection, same id, previous cwd threaded.
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn.mock.calls[0]![0]).toMatchObject({
      selection: { provider: 'p', model: 'model-b' }, sessionId: 'brain-1',
    });

    // Both listeners carried onto the fresh live via ClientAttachments (fails without the fix).
    expect(fresh.listeners.has(l1)).toBe(true);
    expect(fresh.listeners.has(l2)).toBe(true);

    // The old session was disposed exactly once; the respawn under the same id rehydrates its history
    // (and any settled in-flight output) from SQLite — the serial(sessionId) lock guarantees the prior
    // turn has already settled before the switch runs, so nothing is lost without an explicit drain.
    expect(original.session.dispose).toHaveBeenCalledTimes(1);

    // Exactly one model reconcile, on the FRESH stream — and NEVER a raw `session` reset (which would wipe
    // the web transcript). The reconcile rides the `session-event` channel.
    const publish = fresh.replay.publish as unknown as ReturnType<typeof vi.fn>;
    const reconciles = publish.mock.calls.filter((call) => (call[0] as { type?: string }).type === 'session-event');
    expect(reconciles).toHaveLength(1);
    expect(reconciles[0]![0]).toMatchObject({ type: 'session-event', kind: 'model', detail: 'model-b' });
    expect(publish.mock.calls.some((call) => (call[0] as { type?: string }).type === 'session')).toBe(false);
    expect(appendSessionEvent).toHaveBeenCalledWith('brain-1', 'model', 'model-b');

    // History preserved: same id, and the row is never deleted (rehydration is the spawner's job).
    expect(fresh.sessionId).toBe('brain-1');
    expect(store.deleteSession).not.toHaveBeenCalled();
  });

  it('keeps the mode but resets the cadences that describe text the respawn deleted', async () => {
    // A respawn rebuilds the transcript from the clean stored user rows, so PI's ephemeral framing — the
    // full mode directive, the post-compaction orientation block — is genuinely gone from what the model
    // can read. Carrying their counters made the sparse reminder claim "the full instructions are earlier
    // in this conversation" when they were not, and suppressed an orientation block that no longer
    // existed. The MODE itself is a fact about the conversation, not a claim about its text, and a
    // respawn does not change it — carrying it is what stops a spurious "the mode just changed" directive.
    const sessions = new LiveSessionRegistry<LiveBrain>();
    const old = live({ provider: 'p', model: 'model-a' });
    old.lastTurnMode = 'plan';
    old.orientedForCompaction = 'divider-1';
    old.modeReminderTurns = 3;
    sessions.set('brain-1', old);
    sessions.setActive(1, 'brain-1');
    let fresh!: LiveBrain;
    const spawn = vi.fn(async () => { fresh = live({ provider: 'p', model: 'model-b' }); return fresh; });
    const { lifecycle } = makeLifecycle(sessions, spawn);

    await lifecycle.switchModel(1, { provider: 'p', model: 'model-b' });

    expect(fresh.lastTurnMode).toBe('plan');
    expect(fresh.orientedForCompaction).toBeUndefined();
    expect(fresh.modeReminderTurns).toBeUndefined();
  });

  it('a bound (explicit-session) switch leaves the active pointer unmoved, a bare switch moves it', async () => {
    const sessions = new LiveSessionRegistry<LiveBrain>();
    sessions.set('brain-1', live({ provider: 'p', model: 'model-a' }));
    sessions.setActive(1, 'brain-1');
    const spawn = vi.fn(async () => live({ provider: 'p', model: 'model-b' }));
    const { lifecycle } = makeLifecycle(sessions, spawn);
    const setActive = vi.spyOn(sessions, 'setActive');

    await lifecycle.switchModel(1, { provider: 'p', model: 'model-b' }, 'brain-1');
    expect(setActive).not.toHaveBeenCalled(); // bound switch must not touch the pointer

    // Reset the live session the bound switch replaced, then run a bare switch.
    sessions.set('brain-1', live({ provider: 'p', model: 'model-a' }));
    await lifecycle.switchModel(1, { provider: 'p', model: 'model-b' });
    expect(setActive).toHaveBeenCalledWith(1, 'brain-1'); // bare switch follows the active pointer
  });
});
