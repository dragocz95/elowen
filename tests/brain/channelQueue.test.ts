import { describe, it, expect, vi } from 'vitest';
import { ChannelSessionService } from '../../src/brain/channels.js';
import { channelSessionId } from '../../src/brain/sessionId.js';
import { LiveSessionRegistry } from '../../src/brain/session/liveRegistry.js';
import { BrainStore } from '../../src/store/brainStore.js';
import { openDb } from '../../src/store/db.js';
import { LiveEventReplay } from '../../src/brain/session/liveEventReplay.js';
import type { BrainEvent } from '../../src/brain/events.js';
import { currentCardEmitter, currentSubagentEmitter, currentTurnPermissions } from '../../src/plugins/policyContext.js';
import { CardRegistry } from '../../src/brain/cards.js';
import { resolveToolPermission } from '../../src/brain/toolPermissions.js';
import type { DelegatedExecutionScope } from '../../src/brain/delegatedScope.js';

/** Minimal fake LiveBrain — only what ChannelSessionService.send touches. prompt() appends a settled
 *  assistant message so reply extraction has something to read. isStreaming is flipped by the test to
 *  simulate a turn already in flight when the second message arrives. steer() stands in for PI's native
 *  mid-turn injection. */
function fakeBrain(providerId = 'moonshot', model = 'kimi', onPrompt?: () => void, sessionId = '', templates: { name: string }[] = [], beforeUser = '') {
  const messages: { role?: string; content?: unknown }[] = [];
  const session = {
    isStreaming: false,
    getContextUsage: () => ({ tokens: 50, contextWindow: 8000, percent: 1 }),
    messages,
    // Plugin prompt-command macros the session knows (drives isPromptCommand's RAW-routing gate).
    promptTemplates: templates,
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
    turnRecallUserId: undefined as number | null | undefined,
    listeners, replay: new LiveEventReplay(listeners), turnContext: () => ({ beforeUser, afterUser: '' }),
  };
}
type Brain = ReturnType<typeof fakeBrain>;

function setup(maxChannels?: number, templates: { name: string }[] = [], beforeUser = '', channelId = 'discord-c1') {
  const store = new BrainStore(openDb(':memory:'));
  const registry = new LiveSessionRegistry<Brain>();
  const cards = new CardRegistry(() => store);
  const spawn = vi.fn(async (o: { sessionId: string; ownerUserId: number; selection?: { provider?: string; model?: string }; parentSessionId?: string; delegatedAccess?: DelegatedExecutionScope }) => {
    if (!store.getSession(o.sessionId)) store.createSession({
      id: o.sessionId, userId: o.ownerUserId, model: o.selection?.model ?? 'kimi',
      parentSessionId: o.parentSessionId, delegatedAccess: o.delegatedAccess,
    });
    return fakeBrain(o.selection?.provider ?? 'moonshot', o.selection?.model ?? 'kimi', undefined, o.sessionId, templates, beforeUser);
  });
  const svc = new ChannelSessionService({ registry, store, cards, users: { get: () => ({ username: 'o' }) }, spawn, maxChannels } as never);
  const sessionId = channelSessionId(channelId);
  const opts = (userId?: number, onEvent?: (e: unknown) => void) => ({
    channelId, ownerUserId: 1, policy: { allowedProjectIds: 'all' as const, allowedPaths: () => [] },
    identity: userId != null ? { userId } : undefined, onEvent,
  });
  return { store, registry, cards, svc, channelId, sessionId, opts };
}

describe('ChannelSessionService — display cards', () => {
  it('persists a sub-agent/channel card through the shared registry and publishes it live', async () => {
    const { store, registry, svc, channelId, sessionId, opts } = setup(undefined, [], '', 'subagent-card-test');
    const card = { id: 'todos', title: 'Todos', pinned: true, items: [{ text: 'Inspect', status: 'in_progress' }] };
    const liveEvents: BrainEvent[] = [];

    expect(sessionId).toBe('brain-ch-subagent-card-test');
    await svc.send({ ...opts(7), onEvent: (event: BrainEvent) => liveEvents.push(event) }, 'first');
    const live = registry.channelGet(channelId)!;

    // Run a second turn with the emitter invoked inside the active policy context.
    live.session.prompt.mockImplementationOnce(async () => {
      currentCardEmitter()?.(card);
      live.session.messages.push({ role: 'assistant', content: 'done' });
    });
    await svc.send({ ...opts(7), onEvent: (event: BrainEvent) => liveEvents.push(event) }, 'second');

    expect(store.getCards(sessionId)).toEqual([card]);
    expect(liveEvents).toContainEqual({ type: 'card', card });
  });
});

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

  it('keeps a running delegated child claimed when a steered continuation settles its progress row mid-turn', async () => {
    const store = new BrainStore(openDb(':memory:'));
    const registry = new LiveSessionRegistry<Brain>();
    const childId = 'brain-ch-subagent-child';
    let activeAfterDone: boolean | undefined;
    const spawn = vi.fn(async (o: { sessionId: string; ownerUserId: number }) => {
      store.createSession({ id: o.sessionId, userId: o.ownerUserId, model: 'kimi' });
      store.createSession({ id: childId, userId: o.ownerUserId, model: 'kimi', parentSessionId: o.sessionId });
      return fakeBrain('moonshot', 'kimi', () => {
        // The child's ORIGINAL delegated run holds its lifecycle claim, exactly as beginDelegatedCall
        // registers it when the delegation's send is admitted...
        registry.setChildRunning(o.sessionId, childId, true);
        const emit = currentSubagentEmitter()!;
        // ...while a DelegateContinue that STEERED into the running child raises and settles ITS OWN
        // progress row inside the delegating turn. The terminal update must not un-claim the child.
        emit({ id: 'continue-1', sessionId: childId, status: 'running', task: 'steer', tools: 0, seconds: 0 });
        emit({ id: 'continue-1', sessionId: childId, status: 'done', task: 'steer', tools: 0, seconds: 0 });
        activeAfterDone = registry.isActiveChild(childId);
      }, o.sessionId);
    });
    const svc = new ChannelSessionService({ registry, store, users: { get: () => ({ username: 'o' }) }, spawn } as never);
    await svc.send({
      channelId: 'discord-steering', ownerUserId: 1, policy: { allowedProjectIds: 'all' as const, allowedPaths: () => [] },
      identity: { platform: 'discord', userId: '7', admin: false, owner: false },
    }, 'continue the child');

    // DelegateStop, the parent abort tree and the shutdown gate all read this claim — the child's
    // original run is still in flight, so it must still be registered.
    expect(activeAfterDone).toBe(true);
    const live = registry.channelGet('discord-steering')!;
    expect(registry.childrenOf(live.sessionId)).toEqual([childId]);
    // Once the original run really ends (endDelegatedCall), the child deregisters cleanly.
    registry.setChildRunning(live.sessionId, childId, false);
    expect(registry.isActiveChild(childId)).toBe(false);
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
        rules: [{ scope: 'tools', pattern: 'Write', action: 'deny' }],
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
      tools: { Write: 'allow' as const }, bash: {}, yolo: false, unattendedAsks: 'allow' as const,
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
      expect(resolveToolPermission(permissions?.ruleset ?? [], 'Write').action).toBe('deny');
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

  it('steers a hidden result for a delegated parent into its RUNNING turn', async () => {
    // A background sub-agent whose own parent is itself a delegated child: the result has to reach that
    // child mid-turn, exactly as it does for owner chat. It rides PI's custom seam, not the visible queue
    // mirror — a hidden message must not surface as a queue chip or a durable user row — and it must not
    // start a second turn on a session that is already running one.
    const store = new BrainStore(openDb(':memory:'));
    const registry = new LiveSessionRegistry<Brain>();
    const parentSessionId = 'brain-parent-result';
    const childChannel = 'subagent-result-mid-run';
    const childSessionId = channelSessionId(childChannel);
    const scope: DelegatedExecutionScope = { admin: true, projectIds: [], owner: true, permissionBoundary: null };
    store.createSession({ id: parentSessionId, userId: 1, model: 'kimi' });
    store.createSession({ id: childSessionId, userId: 1, model: 'kimi', parentSessionId, delegatedAccess: scope });
    const child = fakeBrain('moonshot', 'kimi', undefined, childSessionId);
    child.session.isStreaming = true;
    const sendCustomMessage = vi.fn(async () => {});
    // Mid-turn delivery rides the agent's steering queue since PI 0.84.2; sendCustomMessage is kept on the
    // fake so the test can assert the running turn was NOT handed the message through a call that only
    // records it (see steerCustomMessage).
    const agentSteer = vi.fn();
    Object.assign(child.session, { sendCustomMessage, clearQueue: vi.fn(), agent: { steer: agentSteer } });
    registry.channelTouch(childChannel, child);
    const svc = new ChannelSessionService({ registry, store, users: { get: () => ({ username: 'owner' }) }, spawn: vi.fn() } as never);
    const content = '<system-reminder>\n<subagent-result id="res-1" status="done"></subagent-result>\n</system-reminder>';

    const reply = await svc.send({
      channelId: childChannel, ownerUserId: 1, parentSessionId,
      policy: { allowedProjectIds: 'all' as const, allowedPaths: () => [] }, trusted: true, ownerSteer: true,
      delegatedAccess: scope, identity: { platform: 'subagent', userId: 'subagent', admin: true, owner: true },
      internalSystem: { customType: 'subagent-result', resultId: 'res-1' },
    } as never, content);

    expect(reply).toBe('');
    expect(agentSteer).toHaveBeenCalledWith({
      role: 'custom',
      customType: 'subagent-result',
      content,
      display: false,
      details: { source: 'elowen', resultId: 'res-1' },
      timestamp: expect.any(Number),
    });
    expect(sendCustomMessage).not.toHaveBeenCalled();
    expect(child.session.prompt).not.toHaveBeenCalled();
    expect(child.session.steer).not.toHaveBeenCalled(); // never mirrored as a visible queued message
    expect(store.getMessages(childSessionId)).toEqual([]); // and never persisted as a user row
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

  it('owner-steer into a streaming child with no pending abort enqueues a steer and returns ""', async () => {
    const store = new BrainStore(openDb(':memory:'));
    const registry = new LiveSessionRegistry<Brain>();
    const parentSessionId = 'brain-parent';
    const childChannel = 'subagent-steer-clean';
    const childSessionId = channelSessionId(childChannel);
    const scope: DelegatedExecutionScope = { admin: true, projectIds: [], owner: true, permissionBoundary: null };
    store.createSession({ id: parentSessionId, userId: 1, model: 'kimi' });
    store.createSession({ id: childSessionId, userId: 1, model: 'kimi', parentSessionId, delegatedAccess: scope });
    const child = fakeBrain('moonshot', 'kimi', undefined, childSessionId);
    child.session.isStreaming = true;
    Object.assign(child.session, { clearQueue: vi.fn() });
    registry.channelTouch(childChannel, child);
    const svc = new ChannelSessionService({ registry, store, users: { get: () => ({ username: 'owner' }) }, spawn: vi.fn() } as never);
    const opts = {
      channelId: childChannel, ownerUserId: 1, parentSessionId,
      policy: { allowedProjectIds: 'all' as const, allowedPaths: () => [] }, trusted: true, ownerSteer: true,
      delegatedAccess: scope, identity: { platform: 'subagent', userId: 'subagent', admin: true, owner: true },
    };

    const ret = await svc.send(opts, 'redirect the child');

    expect(ret).toBe('');
    expect(child.session.steer).toHaveBeenCalledWith('redirect the child', undefined);
    expect(child.session.clearQueue).not.toHaveBeenCalled();
    expect(child.queuedSteer).toEqual([
      expect.objectContaining({ text: 'redirect the child', echo: expect.objectContaining({ persistText: 'redirect the child', publish: true }) }),
    ]);
  });

  it('owner-steer with a pending abort BEFORE the steer throws and enqueues nothing', async () => {
    const store = new BrainStore(openDb(':memory:'));
    const registry = new LiveSessionRegistry<Brain>();
    const parentSessionId = 'brain-parent';
    const childChannel = 'subagent-steer-pre-abort';
    const childSessionId = channelSessionId(childChannel);
    const scope: DelegatedExecutionScope = { admin: true, projectIds: [], owner: true, permissionBoundary: null };
    store.createSession({ id: parentSessionId, userId: 1, model: 'kimi' });
    store.createSession({ id: childSessionId, userId: 1, model: 'kimi', parentSessionId, delegatedAccess: scope });
    const child = fakeBrain('moonshot', 'kimi', undefined, childSessionId);
    child.session.isStreaming = true;
    Object.assign(child.session, { clearQueue: vi.fn() });
    registry.channelTouch(childChannel, child);
    // A child stop is already pending when the steer arrives → the pre-await fence rejects before enqueue.
    registry.requestPendingAbort(childSessionId);
    const svc = new ChannelSessionService({ registry, store, users: { get: () => ({ username: 'owner' }) }, spawn: vi.fn() } as never);
    const opts = {
      channelId: childChannel, ownerUserId: 1, parentSessionId,
      policy: { allowedProjectIds: 'all' as const, allowedPaths: () => [] }, trusted: true, ownerSteer: true,
      delegatedAccess: scope, identity: { platform: 'subagent', userId: 'subagent', admin: true, owner: true },
    };

    await expect(svc.send(opts, 'late redirect')).rejects.toThrow('delegation aborted');
    expect(child.session.steer).not.toHaveBeenCalled();
    expect(child.queuedSteer ?? []).toEqual([]);
  });

  it('owner-steer where a pending abort lands AFTER enqueue clears the queue and throws', async () => {
    const store = new BrainStore(openDb(':memory:'));
    const registry = new LiveSessionRegistry<Brain>();
    const parentSessionId = 'brain-parent';
    const childChannel = 'subagent-steer-post-abort';
    const childSessionId = channelSessionId(childChannel);
    const scope: DelegatedExecutionScope = { admin: true, projectIds: [], owner: true, permissionBoundary: null };
    store.createSession({ id: parentSessionId, userId: 1, model: 'kimi' });
    store.createSession({ id: childSessionId, userId: 1, model: 'kimi', parentSessionId, delegatedAccess: scope });
    const child = fakeBrain('moonshot', 'kimi', undefined, childSessionId);
    child.session.isStreaming = true;
    Object.assign(child.session, {
      clearQueue: vi.fn(() => { child.queuedSteer = []; }),
      // The stop lands while native steer() is admitting the message → observed only on the post-await fence.
      steer: vi.fn(async () => { registry.requestPendingAbort(childSessionId); }),
    });
    registry.channelTouch(childChannel, child);
    const svc = new ChannelSessionService({ registry, store, users: { get: () => ({ username: 'owner' }) }, spawn: vi.fn() } as never);
    const opts = {
      channelId: childChannel, ownerUserId: 1, parentSessionId,
      policy: { allowedProjectIds: 'all' as const, allowedPaths: () => [] }, trusted: true, ownerSteer: true,
      delegatedAccess: scope, identity: { platform: 'subagent', userId: 'subagent', admin: true, owner: true },
    };

    await expect(svc.send(opts, 'redirect racing a stop')).rejects.toThrow('delegation aborted');
    expect(child.session.steer).toHaveBeenCalledOnce();
    expect(child.session.clearQueue).toHaveBeenCalledOnce();
  });

  it('a same-sender mid-turn follow-up with an image steers it in with the image mirrored', async () => {
    const { registry, svc, channelId, opts } = setup();
    await svc.send(opts(7), 'first');
    const live = registry.channelGet(channelId)!;
    live.session.isStreaming = true;
    live.turnSender = 7;

    const ret = await svc.send({ ...opts(7), images: [{ data: 'AAA', mimeType: 'image/png' }] }, 'look at this');

    expect(ret).toBe('');
    expect(live.session.steer).toHaveBeenCalledWith('look at this', [{ type: 'image', data: 'AAA', mimeType: 'image/png' }]);
    expect(live.queuedSteer).toEqual([
      expect.objectContaining({
        text: 'look at this',
        images: [{ type: 'image', data: 'AAA', mimeType: 'image/png' }],
        echo: expect.objectContaining({ persistText: 'look at this\n[📎 1× image]', publish: false }),
      }),
    ]);
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

// The single-source slash feature (Part B): a plugin `/name` prompt-command must reach PI RAW (starting
// with the slash, no context wrap, no sender prefix) so PI expands the macro, while every ordinary message
// stays byte-identical to before — the sender prefix (identity line) applied AND the per-turn context wrap.
describe('ChannelSessionService — plugin prompt-command RAW routing', () => {
  const textOf = (store: BrainStore, sessionId: string) =>
    store.getMessages(sessionId).map((r) => (JSON.parse(r.content) as { content: string }).content);

  it('routes a known plugin /command RAW — no sender prefix, no context wrap', async () => {
    const { svc, store, sessionId, registry, opts } = setup(undefined, [{ name: 'deploy' }], 'CTX ');
    await svc.send({ ...opts(7), senderPrefix: '[V]\n' }, '/deploy prod now');
    const live = registry.channelGet('discord-c1')!;
    expect(live.session.prompt).toHaveBeenCalledWith('/deploy prod now'); // RAW: PI expands the macro itself
    expect(textOf(store, sessionId)).toEqual(['/deploy prod now']);        // persisted RAW too
  });

  it('an ordinary message keeps the sender prefix AND the context wrap (behavior-identical)', async () => {
    const { svc, store, sessionId, registry, opts } = setup(undefined, [{ name: 'deploy' }], 'CTX ');
    await svc.send({ ...opts(7), senderPrefix: '[V]\n' }, '[Bob] hello there');
    const live = registry.channelGet('discord-c1')!;
    // Prefix applied at ingress, THEN context-wrapped — exactly the previous `verifiedPrefix + text` shape.
    expect(live.session.prompt).toHaveBeenCalledWith('CTX [V]\n[Bob] hello there');
    expect(textOf(store, sessionId)).toEqual(['[V]\n[Bob] hello there']); // persisted with the identity prefix
  });

  it('an unknown /slash is NOT treated as a macro (no adapter sends one, so it stays a normal turn)', async () => {
    const { svc, registry, opts } = setup(undefined, [{ name: 'deploy' }], 'CTX ');
    await svc.send({ ...opts(7), senderPrefix: '[V]\n' }, '/notacommand');
    const live = registry.channelGet('discord-c1')!;
    expect(live.session.prompt).toHaveBeenCalledWith('CTX /notacommand'); // gate found no template → wrapped
  });
});

/** Mid-turn recall in a shared room reads this field, so what the channel writes into it IS the privacy
 *  boundary (the rule it feeds is pinned in liveRecallGate.test.ts). A channel serves several senders and
 *  the session is owned by one of them, so falling back to the owner would hand their private memories to
 *  whoever else happens to be typing. */
describe('ChannelSessionService — whose memories a turn may recall', () => {
  it('pins the verified sender for the turn', async () => {
    const { registry, svc, channelId, opts } = setup();

    await svc.send({ ...opts(7), writerUserId: 42 }, 'ahoj');

    expect(registry.channelGet(channelId)!.turnRecallUserId).toBe(42);
  });

  it('leaves nobody pinned for an unlinked sender rather than falling back to the channel owner', async () => {
    const { registry, svc, channelId, opts } = setup();

    await svc.send(opts(7), 'ahoj'); // no linked account → no writerUserId

    expect(registry.channelGet(channelId)!.turnRecallUserId).toBeNull();
  });

  it('re-pins on every turn, so the next sender never inherits the previous one\'s identity', async () => {
    const { registry, svc, channelId, opts } = setup();
    await svc.send({ ...opts(7), writerUserId: 42 }, 'first');

    await svc.send({ ...opts(9), writerUserId: 8 }, 'second');

    expect(registry.channelGet(channelId)!.turnRecallUserId).toBe(8);
  });

  it('clears the pin when a linked sender is followed by an unlinked one', async () => {
    const { registry, svc, channelId, opts } = setup();
    await svc.send({ ...opts(7), writerUserId: 42 }, 'first');

    await svc.send(opts(9), 'second');

    expect(registry.channelGet(channelId)!.turnRecallUserId).toBeNull();
  });
});
