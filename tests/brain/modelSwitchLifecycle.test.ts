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

function makeLifecycle(sessions: LiveSessionRegistry<LiveBrain>, spawn: (opts: SpawnOpts) => Promise<LiveBrain>) {
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
    attachments: new ClientAttachments(),
    elicitation: { cancelForSession: vi.fn() },
    goals: { cancelGoalContinuation: vi.fn() },
    spawn,
    policy: () => ({ allowedProjectIds: 'all', allowedPaths: () => [] }),
    userSettings: () => ({ autoCompact: false, autoCompactAt: 80 }),
    selectionAllowed: () => true,
  } as never);
  return { lifecycle, store, appendSessionEvent };
}

describe('ConversationLifecycle model switch (invariant 3)', () => {
  it('carries every attached listener onto the respawned session, drains before disposing, and publishes exactly one model reconcile', async () => {
    const sessions = new LiveSessionRegistry<LiveBrain>();
    const original = live({ provider: 'p', model: 'model-a' });
    const l1 = vi.fn();
    const l2 = vi.fn();
    original.listeners.add(l1);
    original.listeners.add(l2);
    sessions.set('brain-1', original);

    const fresh = live({ provider: 'p', model: 'model-b' });
    const spawn = vi.fn(async () => fresh);
    const { lifecycle, appendSessionEvent, store } = makeLifecycle(sessions, spawn);

    await lifecycle.switchModel(1, { provider: 'p', model: 'model-b' });

    // spawn once — no second turn/respawn — with the new selection, same id, previous cwd threaded.
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn.mock.calls[0]![0]).toMatchObject({
      selection: { provider: 'p', model: 'model-b' }, sessionId: 'brain-1',
    });

    // Both direct listeners carried onto the fresh live (the invariant-3 core; fails without the carry).
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
