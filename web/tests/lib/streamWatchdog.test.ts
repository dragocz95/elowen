import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { isStreamDataFrame, startStreamWatchdog, resolveStreamSilence, DEFAULT_STREAM_SILENCE, MIN_SILENCE_LIMIT_MS } from '../../lib/streamWatchdog';

// A dropped SSE connection can stay in readyState OPEN with nothing ever arriving on it, so silence is the
// only observable symptom. The daemon heartbeats every 30 s, which is what makes silence measurable.

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('isStreamDataFrame', () => {
  it('counts server frames but not bare EventSource transport errors as liveness', () => {
    expect(isStreamDataFrame({ data: '{}' } as MessageEvent)).toBe(true);
    expect(isStreamDataFrame(new Event('error'))).toBe(false);
  });
});

describe('startStreamWatchdog', () => {
  const run = (opts: { silentMs: number; hidden?: boolean; limitMs?: number }) => {
    const onSilent = vi.fn();
    const lastFrameAt = Date.now();
    const stop = startStreamWatchdog({
      lastFrameAt: () => lastFrameAt,
      onSilent,
      hidden: () => opts.hidden ?? false,
      limitMs: opts.limitMs,
      intervalMs: 1_000, // fine granularity so the assertion is about the limit, not the poll rate
    });
    vi.advanceTimersByTime(opts.silentMs);
    stop();
    return onSilent;
  };

  it('reports a visible stream that has been silent past the limit', () => {
    expect(run({ silentMs: 76_000 })).toHaveBeenCalled();
  });

  it('leaves a stream that is merely between heartbeats alone', () => {
    expect(run({ silentMs: 74_000 })).not.toHaveBeenCalled();
  });

  it('never fires while the page is hidden', () => {
    expect(run({ silentMs: 300_000, hidden: true })).not.toHaveBeenCalled();
  });

  it('measures the wall clock, not how many ticks it saw', () => {
    const onSilent = vi.fn();
    let clock = 1_000_000;
    // Timers frozen by a locked phone: exactly one tick is delivered, long after the silence began.
    const stop = startStreamWatchdog({
      lastFrameAt: () => 1_000_000,
      onSilent,
      hidden: () => false,
      now: () => clock,
      intervalMs: 15_000,
    });
    clock += DEFAULT_STREAM_SILENCE.limitMs + 1_000;
    vi.advanceTimersByTime(15_000); // a single tick
    stop();
    expect(onSilent).toHaveBeenCalledTimes(1);
  });

  it('stops checking once stopped', () => {
    const onSilent = vi.fn();
    const stop = startStreamWatchdog({ lastFrameAt: () => 0, onSilent, hidden: () => false });
    stop();
    vi.advanceTimersByTime(300_000);
    expect(onSilent).not.toHaveBeenCalled();
  });

  it('watches for the operator-configured limit rather than the built-in default', () => {
    expect(run({ silentMs: 41_000, limitMs: 40_000 })).toHaveBeenCalled();
    expect(run({ silentMs: 41_000 })).not.toHaveBeenCalled(); // the 75 s default would still be waiting
  });

  // The floor is a correctness bound: the daemon beats every 30 s, so a shorter limit would fire in the
  // ordinary gap between two beats and tear down a live stream.
  it('never watches on a limit below the heartbeat floor, however it was configured', () => {
    expect(run({ silentMs: MIN_SILENCE_LIMIT_MS - 1_000, limitMs: 5_000 })).not.toHaveBeenCalled();
    expect(run({ silentMs: MIN_SILENCE_LIMIT_MS + 1_000, limitMs: 5_000 })).toHaveBeenCalled();
  });
});

describe('resolveStreamSilence', () => {
  it('takes both halves of the pair from the daemon config', () => {
    expect(resolveStreamSilence({ streamSilenceLimitMs: 120_000, streamReviveSilenceLimitMs: 60_000 }))
      .toEqual({ limitMs: 120_000, reviveLimitMs: 60_000 });
  });

  it('holds each half at the heartbeat floor, whatever the wire carried', () => {
    expect(resolveStreamSilence({ streamSilenceLimitMs: 5_000, streamReviveSilenceLimitMs: 0 }))
      .toEqual({ limitMs: MIN_SILENCE_LIMIT_MS, reviveLimitMs: MIN_SILENCE_LIMIT_MS });
  });

  // An older daemon, or one that has not answered yet, must leave behaviour exactly as it was.
  it('falls back per field to the previously hardcoded defaults', () => {
    expect(resolveStreamSilence(undefined)).toEqual(DEFAULT_STREAM_SILENCE);
    expect(resolveStreamSilence({ streamReviveSilenceLimitMs: 90_000 }))
      .toEqual({ limitMs: DEFAULT_STREAM_SILENCE.limitMs, reviveLimitMs: 90_000 });
    expect(resolveStreamSilence({ streamSilenceLimitMs: Number.NaN }).limitMs).toBe(DEFAULT_STREAM_SILENCE.limitMs);
  });
});
