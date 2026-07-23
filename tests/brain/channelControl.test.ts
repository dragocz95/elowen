import { describe, it, expect, vi } from 'vitest';
import { ChannelSessionService } from '../../src/brain/channels.js';
import { LiveSessionRegistry } from '../../src/brain/session/liveRegistry.js';

/** A minimal fake LiveBrain — only the fields status/abort/compact touch. */
function fakeChannel(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: 'brain-ch-discord-c1#0',
    model: 'kimi',
    providerId: 'moonshot',
    requestProfile: { fast: false },
    fastAvailable: false,
    session: {
      isStreaming: true,
      getContextUsage: () => ({ tokens: 1200, contextWindow: 8000, percent: 15 }),
      messages: [],
      dispose: vi.fn(),
      clearQueue: vi.fn(),
      abort: vi.fn(async () => {}),
      compact: vi.fn(async () => {}),
    },
    ...overrides,
  };
}

/** Build a service whose registry is a stub map keyed by the RAW channel key (what keyOf produces). */
function serviceWith(map: Map<string, unknown>, extra: Record<string, unknown> = {}) {
  const registry = new LiveSessionRegistry<ReturnType<typeof fakeChannel>>();
  for (const [id, value] of map) {
    const channel = value as ReturnType<typeof fakeChannel> & { activeChildren?: Set<string> };
    registry.channelTouch(id, channel);
    for (const child of channel.activeChildren ?? []) registry.setChildRunning(channel.sessionId, child, true);
  }
  const store = { descendantUsage: () => ({ totalTokens: 0, cost: 0 }) };
  // Control methods read the live registry plus persisted descendant usage for the aggregate meter.
  return { svc: new ChannelSessionService({ registry, store, ...extra } as never), registry };
}

describe('ChannelSessionService — channel-scoped slash control (stop/status/compact)', () => {
  it('status returns the live model + usage, or null when the channel has no session', () => {
    const ch = fakeChannel();
    const { svc } = serviceWith(new Map([['discord-c1#0', ch]]));
    expect(svc.status('discord-c1#0')).toEqual({
      provider: 'moonshot',
      model: 'kimi',
      streaming: true,
      usage: { tokens: 1200, contextWindow: 8000, percent: 15, totalTokens: 0, cost: 0 },
      fast: false,
      fastAvailable: false,
    });
    expect(svc.status('discord-unknown#0')).toBeNull();
  });

  it('reports a channel as running while a background delegate remains active', () => {
    const ch = fakeChannel({
      activeChildren: new Set(['brain-ch-subagent-child']),
      session: { ...fakeChannel().session, isStreaming: false },
    });
    const { svc } = serviceWith(new Map([['discord-c1#0', ch]]));
    expect(svc.status('discord-c1#0')?.streaming).toBe(true);
  });

  it('abort signals the in-flight turn (and no-ops on an unknown channel)', async () => {
    const ch = fakeChannel();
    const { svc } = serviceWith(new Map([['discord-c1#0', ch]]));
    await svc.abort('discord-c1#0');
    expect((ch.session.abort as ReturnType<typeof vi.fn>)).toHaveBeenCalledOnce();
    expect((ch.session.clearQueue as ReturnType<typeof vi.fn>)).toHaveBeenCalledOnce();
    await expect(svc.abort('discord-missing#0')).resolves.toBeUndefined(); // idle channel → silent
  });

  it('cancels a parked ask before aborting the channel session', async () => {
    const order: string[] = [];
    const ch = fakeChannel({ session: {
      ...fakeChannel().session,
      clearQueue: vi.fn(() => { order.push('queue'); }),
      abort: vi.fn(async () => { order.push('abort'); }),
    } });
    const { svc } = serviceWith(new Map([['discord-c1#0', ch]]), {
      elicitation: { cancelForSession: vi.fn(() => { order.push('ask'); }) },
    });

    await svc.abort('discord-c1#0');

    expect(order).toEqual(['queue', 'ask', 'abort']);
  });

  // The Esc-Esc workflow bug, channel edition: a `/stop` must first tell the workflow engine to stop
  // launching nodes for this origin, and only then tear the session down — the reverse order leaves a
  // window where an aborted node's settle relaunches the rest of the DAG.
  it('cancels workflows for the channel session before aborting it', async () => {
    const order: string[] = [];
    const ch = fakeChannel({ session: {
      ...fakeChannel().session,
      abort: vi.fn(async () => { order.push('abort'); }),
    } });
    const { svc } = serviceWith(new Map([['discord-c1#0', ch]]), {
      cancelWorkflows: vi.fn(async (sessionId: string) => { order.push(`wf:${sessionId}`); }),
    });

    await svc.abort('discord-c1#0');

    expect(order).toEqual(['wf:brain-ch-discord-c1#0', 'abort']);
  });

  it('aborts nested delegated channels depth-first before their parent', async () => {
    const order: string[] = [];
    const grandchild = fakeChannel({ sessionId: 'brain-ch-subagent-grand', session: { ...fakeChannel().session, abort: vi.fn(async () => { order.push('grandchild'); }) } });
    const child = fakeChannel({
      sessionId: 'brain-ch-subagent-child', activeChildren: new Set(['brain-ch-subagent-grand']),
      session: { ...fakeChannel().session, abort: vi.fn(async () => { order.push('child'); }) },
    });
    const parent = fakeChannel({
      activeChildren: new Set(['brain-ch-subagent-child']),
      session: { ...fakeChannel().session, abort: vi.fn(async () => { order.push('parent'); }) },
    });
    const { svc, registry } = serviceWith(new Map([
      ['discord-c1#0', parent], ['subagent-child', child], ['subagent-grand', grandchild],
    ]));

    await svc.abort('discord-c1#0');

    expect(order).toEqual(['grandchild', 'child', 'parent']);
    expect(registry.childrenOf(parent.sessionId)).toEqual([]);
    expect(registry.childrenOf(child.sessionId)).toEqual([]);
  });

  it('compact runs session.compact under the lock and returns { usage, compacted }; null if no session', async () => {
    const ch = fakeChannel();
    const { svc } = serviceWith(new Map([['discord-c1#0', ch]]));
    const res = await svc.compact('discord-c1#0');
    expect((ch.session.compact as ReturnType<typeof vi.fn>)).toHaveBeenCalledOnce();
    expect(res).toMatchObject({ compacted: true, usage: { tokens: 1200, contextWindow: 8000 } });
    expect(await svc.compact('discord-missing#0')).toBeNull();
  });

  it('compact forwards a caller custom instruction to session.compact', async () => {
    const ch = fakeChannel();
    const { svc } = serviceWith(new Map([['discord-c1#0', ch]]));
    await svc.compact('discord-c1#0', 'keep only the decisions');
    expect(ch.session.compact as ReturnType<typeof vi.fn>).toHaveBeenCalledWith('keep only the decisions');
  });

  it('compact reports a benign no-op (compacted:false) when there is nothing to compact', async () => {
    const ch = fakeChannel({
      session: { ...fakeChannel().session, compact: vi.fn(async () => { throw new Error('Nothing to compact (session too small)'); }) },
    });
    const { svc } = serviceWith(new Map([['discord-c1#0', ch]]));
    const res = await svc.compact('discord-c1#0');
    expect(res).toMatchObject({ compacted: false });
    expect(res?.usage).toMatchObject({ tokens: 1200 });
  });
});
