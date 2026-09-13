import { describe, it, expect, vi } from 'vitest';
import { ChannelSessionService } from '../../src/brain/channels.js';
import { channelSessionId } from '../../src/brain/sessionId.js';
import { LiveSessionRegistry } from '../../src/brain/session/liveRegistry.js';
import { ElicitationRegistry } from '../../src/brain/elicitation.js';
import { BrainStore } from '../../src/store/brainStore.js';
import { openDb, type Db } from '../../src/store/db.js';

/** A minimal fake LiveBrain — only the fields ChannelSessionService.send/abortTree touch (mirrors
 *  channelIdleRollover.test.ts's harness, plus the abort surface abortSessionWork needs). */
function fakeBrain(sessionId: string, ownerUserId: number, settingsUserId: number) {
  const messages: { role?: string; content?: unknown }[] = [];
  const session = {
    isStreaming: false,
    getContextUsage: () => ({ tokens: 50, contextWindow: 8000, percent: 1 }),
    messages,
    prompt: vi.fn(async () => { messages.push({ role: 'assistant', content: 'ok' }); }),
    dispose: vi.fn(() => {}),
    abort: vi.fn(async () => {}),
    clearQueue: vi.fn(() => ({ steering: [], followUp: [] })),
    getAllTools: () => [] as { name: string }[],
    getActiveToolNames: () => [] as string[],
    setActiveToolsByName: () => {},
  };
  return {
    session, sessionId,
    // A real LiveBrain always carries both: the spawner writes `ownerUserId` and `direct: opts.direct === true`.
    // Omitting them here made send() see an ownership/classification change on every turn and respawn the
    // pre-seeded room, which is exactly the cache-destroying behaviour the comparison exists to avoid.
    // …and `settingsUserId`, the account the session was actually COMPOSED from, which is what a
    // settings-driven reset matches on. A room belongs to whoever opened it; its prompt does not.
    ownerUserId, settingsUserId, direct: false,
    model: 'kimi', thinkingLevel: undefined as string | undefined, providerId: 'moonshot',
    pluginToolNames: new Set<string>(), turnSender: undefined as number | undefined,
    interactedAt: undefined as number | undefined, listeners: new Set<(e: unknown) => void>(),
    turnContext: () => ({ beforeUser: '', afterUser: '' }),
  };
}

type Brain = ReturnType<typeof fakeBrain>;

const ALLOW_ALL = { allowedProjectIds: 'all' as const, allowedPaths: () => [] };

function setup() {
  const db: Db = openDb(':memory:');
  const store = new BrainStore(db);
  const registry = new LiveSessionRegistry<Brain>();
  const elicitation = new ElicitationRegistry(5000);
  const cancelWorkflows = vi.fn(async () => {});
  const spawn = vi.fn(async () => { throw new Error('spawn should not be needed — the channel is pre-seeded'); });
  const svc = new ChannelSessionService({
    registry, store, users: { get: () => ({ username: 'owner' }) }, spawn, elicitation, cancelWorkflows,
  } as never);
  /** Register a live channel session directly (no spawn round-trip), mirroring an already-open room. */
  const seedChannel = (channelId: string, ownerUserId: number, settingsUserId = ownerUserId): Brain => {
    const sessionId = channelSessionId(channelId);
    store.createSession({ id: sessionId, userId: ownerUserId, model: 'kimi' });
    const brain = fakeBrain(sessionId, ownerUserId, settingsUserId);
    registry.channelTouch(channelId, brain);
    return brain;
  };
  /** Register the durable run and live child edge an idle DelegateContinue(background:true) leaves behind
   *  after the runner releases it back to the daemon. */
  const seedDelegatedChannel = (
    channelId: string,
    parentSessionId: string,
    background: boolean,
  ): Brain => {
    const sessionId = channelSessionId(channelId);
    store.createSession({
      id: sessionId,
      userId: 1,
      model: 'kimi',
      parentSessionId,
      delegatedAccess: { admin: true, owner: true, projectIds: [], permissionBoundary: null },
    });
    store.upsertSubagentRun(parentSessionId, {
      id: `call-${channelId}`,
      sessionId,
      status: 'running',
      task: 'continue the delegated work',
      tools: 1,
      seconds: 1,
      ...(background ? { background: true, autoDeliver: true } : {}),
    });
    const brain = fakeBrain(sessionId, 1, 1);
    registry.channelTouch(channelId, brain);
    registry.setChildRunning(parentSessionId, sessionId, true);
    return brain;
  };
  return { db, store, registry, elicitation, cancelWorkflows, spawn, svc, seedChannel, seedDelegatedChannel };
}

describe('ChannelSessionService.resetChannels', () => {
  it('disposes every channel when no owner filter is given (plugin reload: global by design)', async () => {
    const t = setup();
    const a = t.seedChannel('c1', 1);
    const b = t.seedChannel('c2', 2);

    await t.svc.resetChannels('plugins reloaded');

    expect(a.session.dispose).toHaveBeenCalledOnce();
    expect(b.session.dispose).toHaveBeenCalledOnce();
    expect(t.registry.channelGet('c1')).toBeUndefined();
    expect(t.registry.channelGet('c2')).toBeUndefined();
  });

  it('prompt refresh resets the parent without aborting, disposing, or waiting on its running background child', async () => {
    const t = setup();
    const parent = t.seedChannel('room', 1);
    t.store.setDelegationBootId('before-refresh');
    const child = t.seedDelegatedChannel('subagent-background', parent.sessionId, true);
    let releaseChildLock!: () => void;
    let childLockHeld!: () => void;
    const childLockReady = new Promise<void>((resolve) => { childLockHeld = resolve; });
    const childLockGate = new Promise<void>((resolve) => { releaseChildLock = resolve; });
    const held = t.registry.withLock(child.sessionId, async () => { childLockHeld(); await childLockGate; });
    await childLockReady;

    const reset = t.svc.resetChannels('user instructions changed', {
      intent: 'prompt_refresh',
      settingsFilter: () => true,
    });
    let timeout!: ReturnType<typeof setTimeout>;
    const outcome = await Promise.race([
      reset.then(() => 'reset'),
      new Promise<'timeout'>((resolve) => { timeout = setTimeout(() => resolve('timeout'), 1_000); }),
    ]);
    clearTimeout(timeout);

    expect(outcome).toBe('reset');
    expect(parent.session.dispose).toHaveBeenCalledOnce();
    expect(child.session.abort).not.toHaveBeenCalled();
    expect(child.session.dispose).not.toHaveBeenCalled();
    expect(t.registry.channelGet('subagent-background')).toBe(child);
    expect(t.registry.childrenOf(parent.sessionId)).toContain(child.sessionId);
    expect(t.store.getSubagentRuns(parent.sessionId)[0]).toMatchObject({ status: 'running', background: true });
    releaseChildLock();
    await held;
  });

  it('prompt refresh spares a foreground grandchild beneath a running background child', async () => {
    const t = setup();
    const root = t.seedChannel('room', 1);
    const child = t.seedDelegatedChannel('subagent-background', root.sessionId, true);
    const grandchild = t.seedDelegatedChannel('subagent-foreground-grandchild', child.sessionId, false);

    await t.svc.resetChannels('user instructions changed', { intent: 'prompt_refresh' });

    expect(root.session.dispose).toHaveBeenCalledOnce();
    expect(child.session.abort).not.toHaveBeenCalled();
    expect(child.session.dispose).not.toHaveBeenCalled();
    expect(grandchild.session.abort).not.toHaveBeenCalled();
    expect(grandchild.session.dispose).not.toHaveBeenCalled();
    expect(t.registry.channelGet('subagent-background')).toBe(child);
    expect(t.registry.channelGet('subagent-foreground-grandchild')).toBe(grandchild);
  });

  it('prompt refresh still aborts and disposes a foreground delegated child', async () => {
    const t = setup();
    const parent = t.seedChannel('room', 1);
    const child = t.seedDelegatedChannel('subagent-foreground', parent.sessionId, false);

    await t.svc.resetChannels('brand changed', { intent: 'prompt_refresh' });

    expect(child.session.abort).toHaveBeenCalled();
    expect(child.session.dispose).toHaveBeenCalledOnce();
    expect(t.registry.pendingAbort(child.sessionId)).toMatchObject({ origin: 'parent_teardown', reason: 'brand changed' });
    expect(t.registry.channelGet('subagent-foreground')).toBeUndefined();
  });

  it.each(['plugins reloaded', 'ordinary reset'])('%s still aborts and disposes both delegated levels', async (reason) => {
    const t = setup();
    const parent = t.seedChannel('room', 1);
    const child = t.seedDelegatedChannel('subagent-background', parent.sessionId, true);
    const grandchild = t.seedDelegatedChannel('subagent-foreground-grandchild', child.sessionId, false);

    await t.svc.resetChannels(reason);

    expect(child.session.abort).toHaveBeenCalled();
    expect(grandchild.session.abort).toHaveBeenCalled();
    expect(child.session.dispose).toHaveBeenCalledOnce();
    expect(grandchild.session.dispose).toHaveBeenCalledOnce();
    expect(t.registry.pendingAbort(child.sessionId)).toMatchObject({ origin: 'parent_teardown', reason });
    expect(t.registry.pendingAbort(grandchild.sessionId)).toMatchObject({ origin: 'parent_teardown', reason });
    expect(t.registry.channelGet('subagent-background')).toBeUndefined();
    expect(t.registry.channelGet('subagent-foreground-grandchild')).toBeUndefined();
  });

  it('prompt refresh spares a recursive background grandchild while resetting its foreground parent', async () => {
    const t = setup();
    const root = t.seedChannel('room', 1);
    const child = t.seedDelegatedChannel('subagent-middle', root.sessionId, false);
    const grandchild = t.seedDelegatedChannel('subagent-grandchild', child.sessionId, true);

    await t.svc.resetChannels('user instructions changed', { intent: 'prompt_refresh' });

    expect(root.session.dispose).toHaveBeenCalledOnce();
    expect(child.session.abort).toHaveBeenCalled();
    expect(child.session.dispose).toHaveBeenCalledOnce();
    expect(grandchild.session.abort).not.toHaveBeenCalled();
    expect(grandchild.session.dispose).not.toHaveBeenCalled();
    expect(t.registry.channelGet('subagent-grandchild')).toBe(grandchild);
    expect(t.registry.childrenOf(child.sessionId)).toContain(grandchild.sessionId);
  });

  it.each(['missing parent row', 'parent cycle'])('prompt refresh fails closed and destroys both levels for a %s', async (corruption) => {
    const t = setup();
    const root = t.seedChannel('room', 1);
    const child = t.seedDelegatedChannel('subagent-background', root.sessionId, true);
    const grandchild = t.seedDelegatedChannel('subagent-foreground-grandchild', child.sessionId, false);
    t.db.prepare('UPDATE brain_sessions SET parent_session_id = ? WHERE id = ?').run(
      corruption === 'parent cycle' ? grandchild.sessionId : 'brain-ch-subagent-missing',
      child.sessionId,
    );

    await t.svc.resetChannels('user instructions changed', { intent: 'prompt_refresh' });

    expect(child.session.abort).toHaveBeenCalled();
    expect(grandchild.session.abort).toHaveBeenCalled();
    expect(child.session.dispose).toHaveBeenCalledOnce();
    expect(grandchild.session.dispose).toHaveBeenCalledOnce();
    expect(t.registry.channelGet('subagent-background')).toBeUndefined();
    expect(t.registry.channelGet('subagent-foreground-grandchild')).toBeUndefined();
  });

  it('restart recovery claims and completes a child spared by prompt refresh exactly once', async () => {
    const t = setup();
    const parent = t.seedChannel('room', 1);
    t.store.setDelegationBootId('boot-before');
    const child = t.seedDelegatedChannel('subagent-recoverable', parent.sessionId, true);

    await t.svc.resetChannels('brand changed', { intent: 'prompt_refresh' });
    t.store.setDelegationBootId('boot-after');
    const claimed = t.store.claimRecoverableRuns();

    expect(claimed).toHaveLength(1);
    expect(claimed[0]).toMatchObject({ parentSessionId: parent.sessionId, childSessionId: child.sessionId });
    expect(t.store.completeRecoveredRun(parent.sessionId, claimed[0]!.toolCallId, {
      id: 'recovered-result',
      toolCallId: claimed[0]!.toolCallId,
      sessionId: child.sessionId,
      status: 'done',
      task: 'continue the delegated work',
      result: 'finished after restart',
      tools: 2,
      seconds: 3,
    })).toBe(true);
    expect(t.store.pendingSubagentResults(parent.sessionId)).toHaveLength(1);
    expect(t.store.completeRecoveredRun(parent.sessionId, claimed[0]!.toolCallId, {
      id: 'duplicate-result',
      toolCallId: claimed[0]!.toolCallId,
      sessionId: child.sessionId,
      status: 'done',
      task: 'continue the delegated work',
      result: 'duplicate',
      tools: 2,
      seconds: 3,
    })).toBe(false);
    t.store.setDelegationBootId('boot-third');
    expect(t.store.claimRecoverableRuns()).toEqual([]);
    expect(t.store.pendingSubagentResults(parent.sessionId)).toHaveLength(1);
  });

  it.each(['user_stop', 'tree_abort'] as const)('%s still terminates both delegated levels with its exact origin', async (origin) => {
    const t = setup();
    const parent = t.seedChannel('room', 1);
    const child = t.seedDelegatedChannel('subagent-background', parent.sessionId, true);
    const grandchild = t.seedDelegatedChannel('subagent-foreground-grandchild', child.sessionId, false);

    await t.svc.abort('room', { origin, reason: `${origin} requested` });

    expect(child.session.abort).toHaveBeenCalled();
    expect(grandchild.session.abort).toHaveBeenCalled();
    expect(t.registry.pendingAbort(child.sessionId)).toEqual({ origin, reason: `${origin} requested` });
    expect(t.registry.pendingAbort(grandchild.sessionId)).toEqual({ origin, reason: `${origin} requested` });
    expect(t.registry.childrenOf(parent.sessionId)).toEqual([]);
    expect(t.registry.childrenOf(child.sessionId)).toEqual([]);
  });

  it('DelegateStop-style targeted abort still terminates the selected child and its grandchild only', async () => {
    const t = setup();
    const root = t.seedChannel('room', 1);
    const child = t.seedDelegatedChannel('subagent-background', root.sessionId, true);
    const grandchild = t.seedDelegatedChannel('subagent-foreground-grandchild', child.sessionId, false);

    await t.svc.abort('subagent-background');

    expect(root.session.abort).not.toHaveBeenCalled();
    expect(child.session.abort).toHaveBeenCalled();
    expect(grandchild.session.abort).toHaveBeenCalled();
    expect(t.registry.pendingAbort(child.sessionId)).toMatchObject({ origin: 'user_stop' });
    expect(t.registry.pendingAbort(grandchild.sessionId)).toMatchObject({ origin: 'user_stop' });
    expect(t.registry.childrenOf(root.sessionId)).toContain(child.sessionId);
    expect(t.registry.childrenOf(child.sessionId)).toEqual([]);
  });

  it('resets only the channels the settings filter matches — another account\'s channel survives untouched (personality change)', async () => {
    const t = setup();
    const mine = t.seedChannel('c1', 1);
    const theirs = t.seedChannel('c2', 2);

    await t.svc.resetChannels('personality changed', { settingsFilter: (settingsUserId) => settingsUserId === 1 });

    expect(mine.session.dispose).toHaveBeenCalledOnce();
    expect(t.registry.channelGet('c1')).toBeUndefined();
    // The other user's channel is not merely "not yet reset" — it is the SAME live object, never touched.
    expect(theirs.session.dispose).not.toHaveBeenCalled();
    expect(t.registry.channelGet('c2')).toBe(theirs);
  });

  it('follows the account a room was COMPOSED from, not the account that opened it', async () => {
    const t = setup();
    // User 2 opened the room; user 1 wrote the turn that spawned it, so 1's instructions and persona are
    // what the live system prompt renders. Filtering on ownership resets exactly the wrong one of these.
    const composedForOne = t.seedChannel('c1', 2, 1);
    const openedByOne = t.seedChannel('c2', 1, 2);

    await t.svc.resetChannels('personality changed', { settingsFilter: (settingsUserId) => settingsUserId === 1 });

    expect(composedForOne.session.dispose).toHaveBeenCalledOnce();
    expect(openedByOne.session.dispose).not.toHaveBeenCalled();
  });

  it('cancels the workflow engine for every reset channel before tearing it down', async () => {
    const t = setup();
    t.seedChannel('c1', 1);

    await t.svc.resetChannels('plugins reloaded');

    expect(t.cancelWorkflows).toHaveBeenCalledWith(channelSessionId('c1'));
  });

  // The fence marks the session as aborting and is released in a finally. Cancelling workflows reaches
  // into the plugin registry, so it can throw (a reload racing an abort) — and a throw that escapes the
  // fence would leave the session marked aborting for the rest of the daemon's life, refusing every
  // later delegation from it.
  it('releases the abort fence even when cancelling workflows throws', async () => {
    const t = setup();
    const brain = t.seedChannel('c1', 1);
    t.cancelWorkflows.mockRejectedValueOnce(new Error('plugin registry reloading'));

    await expect(t.svc.resetChannels('plugins reloaded')).rejects.toThrow('plugin registry reloading');

    expect(t.registry.isParentAborting(brain.sessionId)).toBe(false);
  });

  it('releases a channel parked on a question instead of leaving it to time out', async () => {
    const t = setup();
    const brain = t.seedChannel('c1', 1);
    const answer = t.elicitation.ask(brain.sessionId, [
      { question: 'Continue?', header: 'Continue', multiSelect: false, options: [] },
    ], () => {});
    expect(t.elicitation.pendingForSession(brain.sessionId)).not.toBeNull();

    await t.svc.resetChannels('personality changed', { settingsFilter: () => true });

    expect(t.elicitation.pendingForSession(brain.sessionId)).toBeNull();
    await expect(answer).rejects.toThrow();
  });

  it('disposes only under the channel lock — a turn already in flight is not torn out from under itself', async () => {
    const t = setup();
    const brain = t.seedChannel('c1', 1);
    let releasePrompt!: () => void;
    const promptGate = new Promise<void>((resolve) => { releasePrompt = resolve; });
    brain.session.prompt.mockImplementationOnce(async () => { await promptGate; });

    const turn = t.svc.send({ channelId: 'c1', ownerUserId: 1, policy: ALLOW_ALL }, 'hi');
    await vi.waitFor(() => expect(brain.session.prompt).toHaveBeenCalled());

    const reset = t.svc.resetChannels('test reset');
    // The fence/abort phase does not need the lock and can run immediately...
    await vi.waitFor(() => expect(brain.session.abort).toHaveBeenCalled());
    // ...but the dispose must wait behind the running turn's hold on the channel lock.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(brain.session.dispose).not.toHaveBeenCalled();
    expect(t.registry.channelGet('c1')).toBe(brain);

    releasePrompt();
    await Promise.all([turn, reset]);
    expect(brain.session.dispose).toHaveBeenCalledOnce();
    expect(t.registry.channelGet('c1')).toBeUndefined();
  });
});
