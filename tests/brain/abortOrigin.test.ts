import { describe, expect, it, vi } from 'vitest';
import { LiveSessionRegistry } from '../../src/brain/session/liveRegistry.js';
import { ChannelSessionService } from '../../src/brain/channels.js';
import { DelegatedSessionService } from '../../src/brain/service/delegatedSession.js';
import { BrainStore } from '../../src/store/brainStore.js';
import { openDb } from '../../src/store/db.js';
import { setLogSink } from '../../src/shared/logger.js';

function setup() {
  const db = openDb(':memory:');
  const store = new BrainStore(db);
  store.setDelegationBootId('old');
  const parent = 'brain-parent';
  const child = 'brain-ch-subagent-child';
  store.createSession({ id: parent, userId: 1, model: 'test' });
  store.createSession({ id: child, userId: 1, model: 'test', parentSessionId: parent,
    delegatedAccess: { admin: true, projectIds: [], owner: true, permissionBoundary: null },
  });
  store.upsertSubagentRun(parent, { id: 'call', sessionId: child, status: 'running', task: 'test', tools: 0, seconds: 0 });
  store.setDelegationBootId('new');
  const [run] = store.claimRecoverableRuns(30_000);
  const registry = new LiveSessionRegistry();
  const channel = new ChannelSessionService({ registry, store, users: { get: () => null }, spawn: vi.fn() } as never);
  const delegated = new DelegatedSessionService({ store, sessions: registry, channelService: channel } as never);
  return { db, store, parent, child, run: run!, registry, channel, delegated };
}

describe('delegated abort origins', () => {
  it('retains machine-readable reason and origin, with user Stop winning a later recovery abort', () => {
    const registry = new LiveSessionRegistry();
    registry.requestPendingAbort('child', { origin: 'user_stop', reason: 'Stop button' });
    registry.requestPendingAbort('child', { origin: 'recovery', reason: 'restart cleanup' });
    expect(registry.consumePendingAbort('child')).toEqual({ origin: 'user_stop', reason: 'Stop button' });
    expect(registry.hasPendingAbort('child')).toBe(false);
  });

  it.each([false, true])('logs actual Stop once with structured fields, active=%s', async (active) => {
    const { db, parent, child, registry, channel } = setup();
    const messages: string[] = [];
    setLogSink({ push: (entry) => { messages.push(entry.message); } });
    try {
      if (active) registry.setChildRunning(parent, child, true);
      await channel.abort('subagent-child');
      await channel.abort('subagent-child');
      await channel.abort('absent-child');
      const aborts = messages.filter((message) => message.startsWith('delegation aborted ('));
      expect(aborts).toHaveLength(1);
      expect(aborts[0]).toBe(`delegation aborted (user_stop) ${JSON.stringify({ sessionId: child, origin: 'user_stop', reason: 'aborted' })}`);
    } finally { setLogSink(undefined); db.close(); }
  });

  it('reports the actual origin after remote execution unwinds', async () => {
    const { db, registry, channel, parent, child } = setup();
    try {
      await expect(channel.sendRemote({ channelId: 'subagent-child', ownerUserId: 1, parentSessionId: parent }, async () => {
        registry.requestPendingAbort(child, { origin: 'parent_teardown', reason: 'client closed' });
        return 'partial';
      })).rejects.toMatchObject({ message: 'delegation aborted (parent_teardown)', origin: 'parent_teardown', reason: 'client closed' });
    } finally { db.close(); }
  });

  it('preserves the Stop origin when local spawn rejects during cancellation', async () => {
    const { db, store, parent, child, registry } = setup();
    const scope = store.delegatedAccessFor(child)!;
    const channel = new ChannelSessionService({
      registry, store, users: { get: () => null },
      spawn: async () => {
        await channel.abort('subagent-child');
        throw new Error('spawn interrupted');
      },
    } as never);
    try {
      await expect(channel.send({
        channelId: 'subagent-child', ownerUserId: 1, parentSessionId: parent,
        policy: { allowedProjectIds: 'all', allowedPaths: () => [] },
        delegatedAccess: scope, trusted: true,
        identity: { platform: 'subagent', userId: 'subagent', admin: true, owner: true, conversation: 'delegated' },
      }, 'work')).rejects.toMatchObject({ message: 'delegation aborted (user_stop)', origin: 'user_stop', reason: 'aborted' });
      expect(registry.hasPendingAbort(child)).toBe(false);
    } finally { db.close(); }
  });

  it('rechecks Stop after awaiting the remote runtime release, before starting the recovered turn', async () => {
    const { db, store, parent, child, run, registry, channel } = setup();
    store.appendMessage({ id: 'user', sessionId: child, parentId: null, role: 'user', content: { role: 'user', content: 'continue work' } });
    const send = vi.spyOn(channel, 'send').mockResolvedValue('must not run');
    const delegated = new DelegatedSessionService({
      store, sessions: registry, channelService: channel,
      users: { get: () => ({ is_admin: true }) },
      identity: { forDelegatedTurn: vi.fn() },
      releaseRemote: async () => {
        await delegated.stopSubagent(parent, child);
        return { busy: false };
      },
    } as never);
    try {
      expect(await delegated.recoverClaimedRun(run)).toBe('terminalized');
      expect(send).not.toHaveBeenCalled();
      store.setDelegationBootId('third');
      expect(store.claimRecoverableRuns(30_000)).toEqual([]);
    } finally { db.close(); }
  });

  it('keeps Stop terminal while an already-running recovery unwinds with an error', async () => {
    const { db, store, parent, child, run, registry, delegated } = setup();
    store.appendMessage({ id: 'user', sessionId: child, parentId: null, role: 'user', content: { role: 'user', content: 'continue work' } });
    vi.spyOn(delegated, 'sendDelegated').mockImplementation(async () => {
      registry.setChildRunning(parent, child, true);
      await delegated.stopSubagent(parent, child);
      registry.throwIfPendingAbort(child);
      return 'partial';
    });
    const park = vi.spyOn(store, 'markRecoveryRequired');
    try {
      expect(await delegated.recoverClaimedRun(run)).toBe('terminalized');
      expect(park).not.toHaveBeenCalled();
      expect(store.pendingSubagentResults(parent)[0]).toMatchObject({ status: 'error', error: 'delegation aborted (user_stop)' });
      store.setDelegationBootId('third');
      expect(store.claimRecoverableRuns(30_000)).toEqual([]);
    } finally { db.close(); }
  });

  it('terminalizes a claimed child on Stop before resume and never revives it on another boot', async () => {
    const { db, store, parent, child, run, delegated } = setup();
    const send = vi.spyOn(delegated, 'sendDelegated').mockResolvedValue('must not run');
    store.appendMessage({ id: 'user', sessionId: child, parentId: null, role: 'user', content: { role: 'user', content: 'continue work' } });
    try {
      expect(store.recoveringSubagentSessionIds(parent)).toContain(child);
      await delegated.stopSubagent(parent, child);
      expect(store.recoveringSubagentSessionIds(parent)).not.toContain(child);
      expect(await delegated.recoverClaimedRun(run)).toBe('terminalized');
      expect(send).not.toHaveBeenCalled();
      store.setDelegationBootId('third');
      expect(store.claimRecoverableRuns(30_000)).toEqual([]);
    } finally { db.close(); }
  });
});
