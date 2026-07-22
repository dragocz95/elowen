import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  CACHE_DROP_MIN_TOKENS,
  installCacheWatch,
} from '../../../src/brain/session/cacheWatch.js';
import { setLogSink } from '../../../src/shared/logger.js';

const T0 = 1_000_000;
const TTL = 60_000;

interface Captured { level: string; scope: string; message: string }
let captured: Captured[] = [];

beforeEach(() => {
  captured = [];
  setLogSink({ push: (e) => { captured.push(e); } });
});
afterEach(() => setLogSink(undefined));

type Listener = (event: unknown) => void;

function harness(): { fire: Listener } {
  let listener: Listener = () => undefined;
  const session = { subscribe: (fn: Listener) => { listener = fn; } };
  // The watcher only needs the subscribe seam; the cast mirrors the factory's real AgentSession.
  installCacheWatch(session as never, { ttlMs: TTL });
  return { fire: (e) => listener(e) };
}

const assistantUsage = (cacheRead: number, timestamp: number) => ({
  type: 'message_end',
  message: { role: 'assistant', timestamp, usage: { cacheRead } },
});

const warnings = (): Captured[] => captured.filter((c) => c.level === 'warn' && c.scope === 'brain-cache');

describe('installCacheWatch', () => {
  it('warns when cacheRead drops sharply within a warm window', () => {
    const { fire } = harness();
    fire(assistantUsage(100_000, T0));
    fire(assistantUsage(80_000, T0 + 10_000)); // −20k, warm
    expect(warnings()).toHaveLength(1);
    expect(warnings()[0]?.message).toContain('100000 → 80000');
  });

  it('stays silent for small drops and for growth', () => {
    const { fire } = harness();
    fire(assistantUsage(100_000, T0));
    fire(assistantUsage(100_000 - CACHE_DROP_MIN_TOKENS + 500, T0 + 10_000)); // below the token floor
    fire(assistantUsage(120_000, T0 + 20_000)); // growth is normal
    expect(warnings()).toHaveLength(0);
  });

  it('treats a drop after a TTL-exceeding gap as expiry, not a break', () => {
    const { fire } = harness();
    fire(assistantUsage(100_000, T0));
    fire(assistantUsage(10_000, T0 + TTL + 5_000)); // cache simply expired
    expect(warnings()).toHaveLength(0);
  });

  it('resets its baseline after a real compaction (the smaller context is by design)', () => {
    const { fire } = harness();
    fire(assistantUsage(100_000, T0));
    fire({ type: 'compaction_end', aborted: false, result: { summary: '…' } });
    fire(assistantUsage(20_000, T0 + 10_000)); // post-compact context — no baseline, no warning
    expect(warnings()).toHaveLength(0);
    // …but a drop AFTER the new baseline warns again.
    fire(assistantUsage(15_000, T0 + 20_000));
    expect(warnings()).toHaveLength(1);
  });

  it('ignores aborted compactions, non-assistant messages and missing usage', () => {
    const { fire } = harness();
    fire(assistantUsage(100_000, T0));
    fire({ type: 'compaction_end', aborted: true }); // not a real compaction — baseline must survive
    fire({ type: 'message_end', message: { role: 'toolResult', timestamp: T0 + 5_000 } });
    fire({ type: 'message_end', message: { role: 'assistant', timestamp: T0 + 6_000 } }); // no usage
    fire(assistantUsage(80_000, T0 + 10_000));
    expect(warnings()).toHaveLength(1);
  });

  it('is a no-op without the subscribe seam', () => {
    expect(() => installCacheWatch({} as never, { ttlMs: TTL })).not.toThrow();
  });
});
