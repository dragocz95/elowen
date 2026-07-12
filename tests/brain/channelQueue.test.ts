import { describe, it, expect, vi } from 'vitest';
import { ChannelSessionService } from '../../src/brain/channels.js';
import { channelSessionId } from '../../src/brain/sessionId.js';
import { LiveSessionRegistry } from '../../src/brain/session/liveRegistry.js';
import { BrainStore } from '../../src/store/brainStore.js';
import { openDb } from '../../src/store/db.js';
import { LiveEventReplay } from '../../src/brain/session/liveEventReplay.js';
import type { BrainEvent } from '../../src/brain/events.js';
import { currentSubagentEmitter, currentTurnPermissions } from '../../src/plugins/policyContext.js';
import { resolveToolPermission } from '../../src/brain/toolPermissions.js';
import type { DelegatedExecutionScope } from '../../src/brain/delegatedScope.js';

/** Minimal fake LiveBrain — only what ChannelSessionService.send touches. prompt() appends a settled
 *  assistant message so reply extraction has something to read. isStreaming is flipped by the test to
 *  simulate a turn already in flight when the second message arrives. steer() stands in for PI's native
 *  mid-turn injection. */
function fakeBrain(providerId = 'moonshot', model = 'kimi', onPrompt?: () => void, sessionId = '') {
  const messages: { role?: string; content?: unknown }[] = [];
  const session = {
    isStreaming: false,
    getContextUsage: () => ({ tokens: 50, contextWindow: 8000, percent: 1 }),
    messages,
    prompt: vi.fn(async (t: string) => { onPrompt?.(); messages.push({ role: 'assistant', content: `re: ${t}` }); }),
    steer: vi.fn(async () => {}),
    dispose: vi.fn(() => {}),
    getAllTools: () => [] as { name: string }[],
    getActiveToolNames: () => [] as string[],
    setActiveToolsByName: () => {},
  };
  const listeners = new Set<(e: BrainEvent) => void>();
  return {
    session, sessionId, model, thinkingLevel: undefined as string | undefined, providerId,
    requestProfile: { fast: false }, fastAvailable: false, thinkingLabels: {},
    pluginToolNames: new Set<string>(),
    turnSender: undefined as number | undefined, interactedAt: undefined as number | undefined,
    listeners, replay: new LiveEventReplay(listeners), turnContext: () => ({ beforeUser: '', afterUser: '' }),
  };
}
type Brain = ReturnType<typeof fakeBrain>;

function setup(maxChannels?: number) {
  const store = new BrainStore(openDb(':memory:'));
  const registry = new LiveSessionRegistry<Brain>();
  const spawn = vi.fn(async (o: { sessionId: string; ownerUserId: number; selection?: { provider?: string; model?: string }; parentSessionId?: string; delegatedAccess?: DelegatedExecutionScope }) => {
    if (!store.getSession(o.sessionId)) store.createSession({
      id: o.sessionId, userId: o.ownerUserId, model: o.selection?.model ?? 'kimi',
      parentSessionId: o.parentSessionId, delegatedAccess: o.delegatedAccess,
    });
    return fakeBrain(o.selection?.provider ?? 'moonshot', o.selection?.model ?? 'kimi', undefined, o.sessionId);
  });
  const svc = new ChannelSessionService({ registry, store, users: { get: () => ({ username: 'o' }) }, spawn, maxChannels } as never);
  const channelId = 'discord-c1';
  const sessionId = channelSessionId(channelId);
  const opts = (userId?: number, onEvent?: (e: unknown) => void) => ({
    channelId, ownerUserId: 1, policy: { allowedProjectIds: 'all' as const, allowedPaths: () => [] },
    identity: userId != null ? { userId } : undefined, onEvent,
  });
  return { store, registry, svc, channelId, sessionId, opts };
}

describe('ChannelSessionService — mid-turn steering (Discord double-message)', () => {
  it('a SAME-SENDER message arriving mid-turn stays queue-only until PI delivers it', async () => {
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
    // Pending queue state is not conversation history. The spawner projects/journals the user marker only
    // when PI emits message_start for this queued item.
    expect(store.getMessages(sessionId).length).toBe(beforeMsgs);
    expect(live.replay.snapshot().events).not.toContainEqual(expect.objectContaining({ type: 'user', text: 'second' }));
    expect(live.queuedSteer).toEqual([
      expect.objectContaining({ text: 'second', echo: expect.objectContaining({ persistText: 'second', publish: false }) }),
    ]);
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

  it('respawns when the provider changes even if both providers expose the same model id', async () => {
    const { registry, svc, channelId, opts } = setup();
    await svc.send({ ...opts(7), model: { provider: 'provider-a', model: 'shared-model' } }, 'first');
    const first = registry.channelGet(channelId)!;

    await svc.send({ ...opts(7), model: { provider: 'provider-b', model: 'shared-model' } }, 'second');

    expect(first.session.dispose).toHaveBeenCalledOnce();
    expect(registry.channelGet(channelId)).not.toBe(first);
    expect(registry.channelGet(channelId)?.providerId).toBe('provider-b');
  });

  it('tracks delegated children through the channel turn emitter and replays their progress', async () => {
    const store = new BrainStore(openDb(':memory:'));
    const registry = new LiveSessionRegistry<Brain>();
    const spawn = vi.fn(async (o: { sessionId: string; ownerUserId: number }) => {
      store.createSession({ id: o.sessionId, userId: o.ownerUserId, model: 'kimi' });
      store.createSession({
        id: 'brain-ch-subagent-child', userId: o.ownerUserId, model: 'kimi', parentSessionId: o.sessionId,
      });
      return fakeBrain('moonshot', 'kimi', () => {
        currentSubagentEmitter()?.({
          id: 'delegate-1', sessionId: 'brain-ch-subagent-child', status: 'running', task: 'inspect', tools: 0, seconds: 0,
        });
      }, o.sessionId);
    });
    const svc = new ChannelSessionService({ registry, store, users: { get: () => ({ username: 'o' }) }, spawn } as never);
    const channelId = 'discord-delegating';
    await svc.send({
      channelId, ownerUserId: 1, policy: { allowedProjectIds: 'all' as const, allowedPaths: () => [] },
      identity: { platform: 'discord', userId: '7', admin: false, owner: false },
    }, 'delegate this');

    const live = registry.channelGet(channelId)!;
    expect(registry.childrenOf(live.sessionId)).toEqual(['brain-ch-subagent-child']);
    expect(live.replay.snapshot().events).toContainEqual(expect.objectContaining({
      type: 'subagent', id: 'delegate-1', sessionId: 'brain-ch-subagent-child', status: 'running',
    }));
    expect(store.getSubagentRuns(`brain-ch-${channelId}`)).toEqual([expect.objectContaining({
      toolCallId: 'delegate-1', sessionId: 'brain-ch-subagent-child', status: 'running',
    })]);
  });

  it('requires a delegated child owner to match its durable parent owner', async () => {
    const store = new BrainStore(openDb(':memory:'));
    const registry = new LiveSessionRegistry<Brain>();
    store.createSession({ id: 'brain-2', userId: 2, model: 'kimi' });
    const spawn = vi.fn(async (o: { sessionId: string; ownerUserId: number; parentSessionId?: string; delegatedAccess?: DelegatedExecutionScope }) => {
      store.createSession({
        id: o.sessionId, userId: o.ownerUserId, model: 'kimi', parentSessionId: o.parentSessionId,
        delegatedAccess: o.delegatedAccess,
      });
      return fakeBrain('moonshot', 'kimi', undefined, o.sessionId);
    });
    const svc = new ChannelSessionService({ registry, store, users: { get: () => ({ username: 'u2' }) }, spawn } as never);
    const base = {
      policy: { allowedProjectIds: 'all' as const, allowedPaths: () => [] }, parentSessionId: 'brain-2', trusted: true,
      delegatedAccess: { admin: true, projectIds: [], owner: false, permissionBoundary: null },
      identity: { platform: 'subagent', userId: 'subagent', admin: true, owner: false },
    };

    await svc.send({ ...base, channelId: 'subagent-valid', ownerUserId: 2 }, 'inspect');
    expect(store.getSession('brain-ch-subagent-valid')).toMatchObject({ user_id: 2, parent_session_id: 'brain-2' });
    expect(store.delegatedAccessFor('brain-ch-subagent-valid')).toEqual({ admin: true, projectIds: [], owner: false, permissionBoundary: null });

    await expect(svc.send({ ...base, channelId: 'subagent-forged', ownerUserId: 1 }, 'inspect'))
      .rejects.toThrow('invalid parent session');
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('uses a linked non-owner captured granular deny after the child goes idle, never its row owner settings', async () => {
    const store = new BrainStore(openDb(':memory:'));
    const registry = new LiveSessionRegistry<Brain>();
    store.createSession({ id: 'brain-owner-parent', userId: 1, model: 'kimi' });
    const observed: ReturnType<typeof currentTurnPermissions>[] = [];
    const childId = 'brain-ch-subagent-linked-non-owner';
    const child = fakeBrain('moonshot', 'kimi', () => observed.push(currentTurnPermissions()), childId);
    const scope: DelegatedExecutionScope = {
      admin: false, projectIds: [3], owner: false,
      // This was captured while a linked non-owner was driving the parent channel. The durable child row
      // is nevertheless anchored to owner #1, whose current account settings below would ALLOW it.
      permissionBoundary: {
        rules: [{ scope: 'tools', pattern: 'write_file', action: 'deny' }],
        unattendedAsks: 'deny',
      },
    };
    const spawn = vi.fn(async (o: { sessionId: string; ownerUserId: number; parentSessionId?: string; delegatedAccess?: DelegatedExecutionScope }) => {
      if (!store.getSession(o.sessionId)) {
        store.createSession({
          id: o.sessionId, userId: o.ownerUserId, model: 'kimi', parentSessionId: o.parentSessionId,
          delegatedAccess: o.delegatedAccess,
        });
      }
      return child;
    });
    const ownerPermissions = vi.fn(() => ({
      tools: { write_file: 'allow' as const }, bash: {}, yolo: false, unattendedAsks: 'allow' as const,
    }));
    const svc = new ChannelSessionService({
      registry, store, users: { get: () => ({ username: 'owner' }) }, spawn, permissions: ownerPermissions,
    } as never);
    const opts = {
      channelId: 'subagent-linked-non-owner', ownerUserId: 1, parentSessionId: 'brain-owner-parent',
      policy: { allowedProjectIds: new Set([3]), allowedPaths: () => [] }, trusted: false,
      delegatedAccess: scope, identity: { platform: 'subagent', userId: 'subagent', admin: false, owner: false },
    };

    await svc.send(opts, 'first child turn');
    // A fresh send after settling is the idle drill-in continuation path. Reuse the persisted canonical
    // scope just as BrainService.sendToSubagent does after an LRU respawn.
    registry.channelDispose(opts.channelId);
    await svc.send({ ...opts, delegatedAccess: store.delegatedAccessFor(childId)! }, 'continue after idle');

    expect(ownerPermissions).not.toHaveBeenCalled();
    expect(observed).toHaveLength(2);
    for (const permissions of observed) {
      expect(permissions?.unattendedAsks).toBe('deny');
      expect(resolveToolPermission(permissions?.ruleset ?? [], 'write_file').action).toBe('deny');
      expect(permissions?.yolo).toBe(false);
    }
  });

  it('never reattaches an existing child to a different same-owner parent while it is live', async () => {
    const store = new BrainStore(openDb(':memory:'));
    const registry = new LiveSessionRegistry<Brain>();
    store.createSession({ id: 'brain-parent-a', userId: 1, model: 'kimi' });
    store.createSession({ id: 'brain-parent-b', userId: 1, model: 'kimi' });
    const scope = { admin: false, projectIds: [3], owner: false, permissionBoundary: null, toolPolicy: { allow: [] } };
    store.createSession({
      id: 'brain-ch-subagent-existing', userId: 1, model: 'kimi', parentSessionId: 'brain-parent-a', delegatedAccess: scope,
    });
    const child = fakeBrain('moonshot', 'kimi', undefined, 'brain-ch-subagent-existing');
    registry.channelTouch('subagent-existing', child);
    const spawn = vi.fn(async () => child);
    const svc = new ChannelSessionService({ registry, store, users: { get: () => ({ username: 'u1' }) }, spawn } as never);

    await expect(svc.send({
      channelId: 'subagent-existing', ownerUserId: 1, parentSessionId: 'brain-parent-b',
      policy: { allowedProjectIds: new Set([3]), allowedPaths: () => [] }, trusted: false,
      delegatedAccess: scope, identity: { platform: 'subagent', userId: 'subagent', admin: false, owner: false },
    }, 'continue')).rejects.toThrow('delegated access unavailable');
    expect(child.session.prompt).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
    expect(registry.childrenOf('brain-parent-b')).toEqual([]);
  });

  it('cancels a delegated child even when stop wins the race with its awaited spawn', async () => {
    const store = new BrainStore(openDb(':memory:'));
    const registry = new LiveSessionRegistry<Brain>();
    store.createSession({ id: 'brain-parent', userId: 1, model: 'kimi' });
    const child = fakeBrain('moonshot', 'kimi', undefined, 'brain-ch-subagent-pending');
    let releaseSpawn!: () => void;
    const spawnGate = new Promise<void>((resolve) => { releaseSpawn = resolve; });
    let markSpawnStarted!: () => void;
    const spawnStarted = new Promise<void>((resolve) => { markSpawnStarted = resolve; });
    const spawn = vi.fn(async (o: { sessionId: string; ownerUserId: number; parentSessionId?: string; delegatedAccess?: DelegatedExecutionScope }) => {
      store.createSession({
        id: o.sessionId, userId: o.ownerUserId, model: 'kimi', parentSessionId: o.parentSessionId,
        delegatedAccess: o.delegatedAccess,
      });
      markSpawnStarted();
      await spawnGate;
      return child;
    });
    const svc = new ChannelSessionService({ registry, store, users: { get: () => ({ username: 'u1' }) }, spawn } as never);
    const sending = svc.send({
      channelId: 'subagent-pending', ownerUserId: 1, parentSessionId: 'brain-parent',
      policy: { allowedProjectIds: 'all' as const, allowedPaths: () => [] },
      trusted: true, delegatedAccess: { admin: true, projectIds: [], owner: true, permissionBoundary: null },
      identity: { platform: 'subagent', userId: 'subagent', admin: true, owner: true },
    }, 'inspect');
    await spawnStarted;
    expect(registry.childrenOf('brain-parent')).toEqual(['brain-ch-subagent-pending']);

    await svc.abort('subagent-pending');
    releaseSpawn();

    await expect(sending).rejects.toThrow('delegation aborted');
    expect(child.session.dispose).toHaveBeenCalledOnce();
    expect(child.session.prompt).not.toHaveBeenCalled();
    expect(registry.childrenOf('brain-parent')).toEqual([]);
  });

  it('keeps an overlapping owner steer attached and rejects the live child run when its parent stops', async () => {
    const store = new BrainStore(openDb(':memory:'));
    const registry = new LiveSessionRegistry<Brain>();
    store.createSession({ id: 'brain-parent', userId: 1, model: 'kimi' });
    const childId = 'brain-ch-subagent-live';
    const child = fakeBrain('moonshot', 'kimi', undefined, childId);
    let promptStarted!: () => void;
    const started = new Promise<void>((resolve) => { promptStarted = resolve; });
    let releasePrompt!: () => void;
    const promptGate = new Promise<void>((resolve) => { releasePrompt = resolve; });
    child.session.prompt.mockImplementationOnce(async () => {
      child.session.isStreaming = true;
      promptStarted();
      await promptGate;
      child.session.messages.push({ role: 'assistant', content: 'partial output before cancellation', stopReason: 'aborted' } as never);
      child.session.isStreaming = false;
    });
    Object.assign(child.session, {
      clearQueue: vi.fn(),
      abort: vi.fn(async () => { releasePrompt(); }),
    });
    const spawn = vi.fn(async (o: { sessionId: string; ownerUserId: number; parentSessionId?: string; delegatedAccess?: DelegatedExecutionScope }) => {
      store.createSession({
        id: o.sessionId, userId: o.ownerUserId, model: 'kimi', parentSessionId: o.parentSessionId,
        delegatedAccess: o.delegatedAccess,
      });
      return child;
    });
    const svc = new ChannelSessionService({ registry, store, users: { get: () => ({ username: 'u1' }) }, spawn } as never);
    const opts = {
      channelId: 'subagent-live', ownerUserId: 1, parentSessionId: 'brain-parent',
      policy: { allowedProjectIds: 'all' as const, allowedPaths: () => [] }, ownerSteer: true, trusted: true,
      delegatedAccess: { admin: true, projectIds: [], owner: true, permissionBoundary: null },
      identity: { platform: 'subagent', userId: 'subagent', admin: true, owner: true },
    };

    const running = svc.send(opts, 'initial');
    await started;
    await svc.send(opts, 'steer while running');
    expect(child.session.steer).toHaveBeenCalledWith('steer while running', undefined);
    expect(registry.childrenOf('brain-parent')).toEqual([childId]); // short steer did not release the original run

    await svc.abort('subagent-live');
    await expect(running).rejects.toThrow('delegation aborted');
    expect(registry.childrenOf('brain-parent')).toEqual([]);
  });

  it('clears a late owner-steer queue entry when the parent abort wins while steer() awaits', async () => {
    const store = new BrainStore(openDb(':memory:'));
    const registry = new LiveSessionRegistry<Brain>();
    const parentChannel = 'subagent-parent-race';
    const parentSessionId = channelSessionId(parentChannel);
    const childChannel = 'subagent-child-race';
    const childSessionId = channelSessionId(childChannel);
    const scope: DelegatedExecutionScope = { admin: true, projectIds: [], owner: true, permissionBoundary: null };
    store.createSession({ id: parentSessionId, userId: 1, model: 'kimi' });
    store.createSession({ id: childSessionId, userId: 1, model: 'kimi', parentSessionId, delegatedAccess: scope });
    const parent = fakeBrain('moonshot', 'kimi', undefined, parentSessionId);
    const child = fakeBrain('moonshot', 'kimi', undefined, childSessionId);
    parent.session.isStreaming = true;
    child.session.isStreaming = true;
    const queued: string[] = [];
    let signalSteer!: () => void;
    const steerStarted = new Promise<void>((resolve) => { signalSteer = resolve; });
    let releaseSteer!: () => void;
    const steerGate = new Promise<void>((resolve) => { releaseSteer = resolve; });
    Object.assign(parent.session, { clearQueue: vi.fn(), abort: vi.fn(async () => {}) });
    Object.assign(child.session, {
      clearQueue: vi.fn(() => { queued.length = 0; }),
      abort: vi.fn(async () => {}),
      steer: vi.fn(async (text: string) => { signalSteer(); await steerGate; queued.push(text); }),
    });
    registry.channelTouch(parentChannel, parent);
    registry.channelTouch(childChannel, child);
    const svc = new ChannelSessionService({ registry, store, users: { get: () => ({ username: 'owner' }) }, spawn: vi.fn() } as never);
    const opts = {
      channelId: childChannel, ownerUserId: 1, parentSessionId,
      policy: { allowedProjectIds: 'all' as const, allowedPaths: () => [] }, trusted: true, ownerSteer: true,
      delegatedAccess: scope, identity: { platform: 'subagent', userId: 'subagent', admin: true, owner: true },
    };

    const steering = svc.send(opts, 'late instruction');
    await steerStarted;
    // This begins the actual parent abort tree while the native steer promise is unresolved. It clears
    // the child once, then the fast-path's post-await fence must clear the instruction enqueued after it.
    await svc.abort(parentChannel);
    releaseSteer();

    await expect(steering).rejects.toThrow('delegation aborted');
    expect(queued).toEqual([]);
    expect(child.session.clearQueue).toHaveBeenCalledTimes(2);
  });

  it('fences a fresh nested child while its parent abort is still draining', async () => {
    const store = new BrainStore(openDb(':memory:'));
    const registry = new LiveSessionRegistry<Brain>();
    const parentChannel = 'subagent-parent';
    const parentSessionId = channelSessionId(parentChannel);
    store.createSession({ id: parentSessionId, userId: 1, model: 'kimi' });
    const parent = fakeBrain('moonshot', 'kimi', undefined, parentSessionId);
    let abortStarted!: () => void;
    const started = new Promise<void>((resolve) => { abortStarted = resolve; });
    let releaseAbort!: () => void;
    const gate = new Promise<void>((resolve) => { releaseAbort = resolve; });
    Object.assign(parent.session, {
      clearQueue: vi.fn(),
      abort: vi.fn(async () => { abortStarted(); await gate; }),
    });
    registry.channelTouch(parentChannel, parent);
    const spawn = vi.fn(async () => fakeBrain('moonshot', 'kimi', undefined, 'brain-ch-subagent-new'));
    const svc = new ChannelSessionService({ registry, store, users: { get: () => ({ username: 'u1' }) }, spawn } as never);

    const stopping = svc.abort(parentChannel);
    await started;
    await expect(svc.send({
      channelId: 'subagent-new', ownerUserId: 1, parentSessionId,
      policy: { allowedProjectIds: new Set([3]), allowedPaths: () => [] }, trusted: false,
      delegatedAccess: { admin: false, projectIds: [3], owner: false, permissionBoundary: null, toolPolicy: { allow: [] } },
      identity: { platform: 'subagent', userId: 'subagent', admin: false, owner: false },
    }, 'continue')).rejects.toThrow('delegation aborted');
    expect(spawn).not.toHaveBeenCalled();

    releaseAbort();
    await stopping;
    expect(registry.isParentAborting(parentSessionId)).toBe(false);
  });

  it('keeps an LRU channel live while its background child is running', async () => {
    const { store, registry, svc, opts } = setup(1);
    const busyId = 'discord-busy';
    const busySessionId = channelSessionId(busyId);
    const busy = fakeBrain('moonshot', 'kimi', undefined, busySessionId);
    store.createSession({ id: busySessionId, userId: 1, model: 'kimi' });
    registry.channelTouch(busyId, busy);
    registry.setChildRunning(busySessionId, 'brain-ch-subagent-running', true);

    await svc.send({ ...opts(7), channelId: 'discord-new' }, 'hello');

    expect(busy.session.dispose).not.toHaveBeenCalled();
    expect(registry.channelGet(busyId)).toBe(busy);
    expect(registry.channelGet('discord-new')).toBeDefined(); // busy entries make the cap temporarily soft
  });
});
