import { describe, it, expect, vi } from 'vitest';
import { ChannelSessionService } from '../../src/brain/channels.js';

/** A minimal fake LiveBrain — only the fields status/abort/compact touch. */
function fakeChannel(overrides: Record<string, unknown> = {}) {
  return {
    model: 'kimi',
    session: {
      isStreaming: true,
      getContextUsage: () => ({ tokens: 1200, contextWindow: 8000, percent: 15 }),
      messages: [],
      abort: vi.fn(async () => {}),
      compact: vi.fn(async () => {}),
    },
    ...overrides,
  };
}

/** Build a service whose registry is a stub map keyed by the RAW channel key (what keyOf produces). */
function serviceWith(map: Map<string, unknown>) {
  const registry = {
    channelGet: (id: string) => map.get(id),
    withLock: <K>(_id: string, fn: () => Promise<K>) => fn(),
  };
  // Only `registry` is exercised by the control methods; the rest of the deps are never reached.
  return new ChannelSessionService({ registry } as never);
}

describe('ChannelSessionService — channel-scoped slash control (stop/status/compact)', () => {
  it('status returns the live model + usage, or null when the channel has no session', () => {
    const ch = fakeChannel();
    const svc = serviceWith(new Map([['discord-c1#0', ch]]));
    expect(svc.status('discord-c1#0')).toEqual({
      model: 'kimi',
      streaming: true,
      usage: { tokens: 1200, contextWindow: 8000, percent: 15, totalTokens: 0, cost: 0 },
    });
    expect(svc.status('discord-unknown#0')).toBeNull();
  });

  it('abort signals the in-flight turn (and no-ops on an unknown channel)', () => {
    const ch = fakeChannel();
    const svc = serviceWith(new Map([['discord-c1#0', ch]]));
    svc.abort('discord-c1#0');
    expect((ch.session.abort as ReturnType<typeof vi.fn>)).toHaveBeenCalledOnce();
    expect(() => svc.abort('discord-missing#0')).not.toThrow(); // idle channel → silent
  });

  it('compact runs session.compact under the lock and returns { usage, compacted }; null if no session', async () => {
    const ch = fakeChannel();
    const svc = serviceWith(new Map([['discord-c1#0', ch]]));
    const res = await svc.compact('discord-c1#0');
    expect((ch.session.compact as ReturnType<typeof vi.fn>)).toHaveBeenCalledOnce();
    expect(res).toMatchObject({ compacted: true, usage: { tokens: 1200, contextWindow: 8000 } });
    expect(await svc.compact('discord-missing#0')).toBeNull();
  });

  it('compact reports a benign no-op (compacted:false) when there is nothing to compact', async () => {
    const ch = fakeChannel({
      session: { ...fakeChannel().session, compact: vi.fn(async () => { throw new Error('Nothing to compact (session too small)'); }) },
    });
    const svc = serviceWith(new Map([['discord-c1#0', ch]]));
    const res = await svc.compact('discord-c1#0');
    expect(res).toMatchObject({ compacted: false });
    expect(res?.usage).toMatchObject({ tokens: 1200 });
  });
});
