import { describe, it, expect, vi } from 'vitest';
import { ChannelSessionService } from '../../src/brain/channels.js';
import { channelSessionId } from '../../src/brain/sessionId.js';
import { LiveSessionRegistry } from '../../src/brain/session/liveRegistry.js';
import { BrainStore } from '../../src/store/brainStore.js';
import { openDb } from '../../src/store/db.js';

/** Minimal fake LiveBrain — only what ChannelSessionService.send touches. prompt() appends a settled
 *  assistant message so reply extraction has something to read. isStreaming is flipped by the test to
 *  simulate a turn already in flight when the second message arrives. steer() stands in for PI's native
 *  mid-turn injection. */
function fakeBrain() {
  const messages: { role?: string; content?: unknown }[] = [];
  const session = {
    isStreaming: false,
    getContextUsage: () => ({ tokens: 50, contextWindow: 8000, percent: 1 }),
    messages,
    prompt: vi.fn(async (t: string) => { messages.push({ role: 'assistant', content: `re: ${t}` }); }),
    steer: vi.fn(async () => {}),
    dispose: vi.fn(() => {}),
    getAllTools: () => [] as { name: string }[],
    getActiveToolNames: () => [] as string[],
    setActiveToolsByName: () => {},
  };
  return {
    session, model: 'kimi', thinkingLevel: undefined as string | undefined, providerId: 'moonshot',
    pluginToolNames: new Set<string>(),
    turnSender: undefined as number | undefined, interactedAt: undefined as number | undefined,
    listeners: new Set<(e: unknown) => void>(), turnContext: () => '',
  };
}
type Brain = ReturnType<typeof fakeBrain>;

function setup() {
  const store = new BrainStore(openDb(':memory:'));
  const registry = new LiveSessionRegistry<Brain>();
  const spawn = vi.fn(async (o: { sessionId: string; ownerUserId: number }) => {
    store.createSession({ id: o.sessionId, userId: o.ownerUserId, model: 'kimi' });
    return fakeBrain();
  });
  const svc = new ChannelSessionService({ registry, store, users: { get: () => ({ username: 'o' }) }, spawn } as never);
  const channelId = 'discord-c1';
  const sessionId = channelSessionId(channelId);
  const opts = (userId?: number, onEvent?: (e: unknown) => void) => ({
    channelId, ownerUserId: 1, policy: { allowedProjectIds: 'all' as const, allowedPaths: () => [] },
    identity: userId != null ? { userId } : undefined, onEvent,
  });
  return { store, registry, svc, channelId, sessionId, opts };
}

describe('ChannelSessionService — mid-turn steering (Discord double-message)', () => {
  it('a SAME-SENDER message arriving mid-turn is STEERED into the running turn (no new turn, persisted)', async () => {
    const { store, registry, svc, channelId, sessionId, opts } = setup();
    await svc.send(opts(7), 'first'); // spawns + runs turn 1
    const live = registry.channelGet(channelId)!;
    live.session.isStreaming = true; // a turn is now in flight
    live.turnSender = 7;
    const before = live.session.prompt.mock.calls.length;
    const beforeMsgs = store.getMessages(sessionId).length;

    const ret = await svc.send(opts(7), 'second'); // same sender, mid-turn

    expect(ret).toBe('');                                               // steered, nothing to return
    expect(live.session.steer).toHaveBeenCalledWith('second', undefined); // injected into the running turn
    expect(live.session.prompt.mock.calls.length).toBe(before);         // no extra turn ran
    // Persisted immediately (agent_end never re-persists user messages) so it reaches history.
    expect(store.getMessages(sessionId).length).toBe(beforeMsgs + 1);
    expect(store.getMessages(sessionId).at(-1)!.content).toContain('second');
  });

  it('a DIFFERENT-sender mid-turn message is NOT steered (falls through to its own turn)', async () => {
    const { registry, svc, channelId, opts } = setup();
    await svc.send(opts(7), 'first');
    const live = registry.channelGet(channelId)!;
    live.session.isStreaming = true;
    live.turnSender = 7;
    // Member 9 (different sender) — must not steer into 7's turn; runs its own (here: proceeds since the
    // fake lets isStreaming drop).
    live.session.isStreaming = false;
    await svc.send(opts(9), 'from someone else');
    expect(live.session.steer).not.toHaveBeenCalled(); // never steered under the other sender
  });
});
