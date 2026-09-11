import { describe, it, expect } from 'vitest';
import { startLoopLagMonitor, watchLoopLag, type LoopLag } from '../../src/shared/eventLoopLag.js';

/** Occupy the event loop synchronously for `ms`, the way a long CPU-bound callback does. */
const blockLoop = (ms: number) => {
  const until = Date.now() + ms;
  while (Date.now() < until) { /* deliberately busy */ }
};

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('event loop lag monitor', () => {
  it('reports a low reading on an idle loop', async () => {
    const monitor = startLoopLagMonitor();
    await tick(120);
    const { p50, max, severeStalledMs, windowMs } = monitor.lag();
    monitor.stop();
    // The sampler's own resolution is the floor of every reading, so this is "small", not "zero".
    expect(p50).toBeLessThan(5);
    expect(max).toBeLessThan(100);
    // An idle loop must not accumulate fabricated stall time out of scheduler jitter.
    expect(severeStalledMs).toBeLessThan(50);
    expect(windowMs).toBeGreaterThan(0);
    expect(windowMs).toBeLessThanOrEqual(60_000);
  });

  // The whole point of the metric: work that hogs the loop must be visible. Without this the daemon
  // cannot tell a slow provider from a loop that never got round to reading the response.
  it('reports the delay when the loop is blocked', async () => {
    const monitor = startLoopLagMonitor();
    await tick(40); // let the sampler take a reading before the loop is taken away from it
    blockLoop(250);
    await tick(40);
    const { max } = monitor.lag();
    monitor.stop();
    expect(max).toBeGreaterThan(100);
    // Only `max` is asserted on purpose. At 1 ms resolution a 250 ms stall is ONE sample among ~90, so
    // the 99th percentile stays near the floor — percentiles describe sustained starvation, `max`
    // catches the single long callback. Asserting p99 here would be asserting a false model of the data.
  });

  it('clears the window so an old spike stops being reported', async () => {
    const monitor = startLoopLagMonitor(400);
    await tick(30);
    blockLoop(150);
    await tick(30);
    expect(monitor.lag().max).toBeGreaterThan(100);
    // Past the window: the spike is history and must not keep the reading pinned high.
    await tick(500);
    const after = monitor.lag();
    monitor.stop();
    expect(after.max).toBeLessThan(100);
  });

  // Regression for a production incident: with a single histogram reset on its own timer, a long stall
  // makes the overdue reset fire in the same timer sweep as the overdue readers, so `/health` reported
  // `max: 0` on a response that itself took 5.7 s. The double-buffered window must keep the spike
  // visible to a reader landing right after a roll.
  it('keeps a spike visible to a reader that lands right after the window rolls', async () => {
    const monitor = startLoopLagMonitor(600); // halves roll every 300 ms
    await tick(320); // get past the first half-roll so both halves are in rotation
    blockLoop(200); // the spike — it lands in BOTH halves and delays the next roll behind it
    await tick(120); // the ~t=600 roll fires in here, clearing one half
    const { max } = monitor.lag();
    monitor.stop();
    expect(max).toBeGreaterThan(100);
  });

  // The production discrepancy this metric exists for: /health measured 19.9 s from the client while
  // `max` said 4.1 s — a request queues through the SUM of stalls, and only `severeStalledMs` shows that sum.
  it('severeStalledMs accumulates the sum of stalls while max holds only the worst single one', async () => {
    const monitor = startLoopLagMonitor(2000); // long window: no roll interferes with the sequence
    await tick(150);
    blockLoop(200); await tick(30);
    blockLoop(200); await tick(30);
    blockLoop(200); await tick(100);
    const { max, severeStalledMs } = monitor.lag();
    monitor.stop();
    expect(max).toBeLessThan(450); // no single stall was anywhere near the sum
    expect(severeStalledMs).toBeGreaterThan(250);
    expect(severeStalledMs).toBeGreaterThan(max); // the sum is the bigger — and the truer — queueing bound
  });

  // Sub-floor pauses are excluded from the SEVERE sum by design (summing scheduler jitter over a 60 s
  // window would fabricate seconds of "stall" on a healthy loop) — the name carries the floor. The
  // pattern is NOT invisible though: dense sub-floor lateness saturates the delay histogram, so the
  // percentiles are where a client's cumulative wait behind many small stalls shows up.
  it('excludes sub-floor pauses from severeStalledMs but keeps them visible in the percentiles', async () => {
    const monitor = startLoopLagMonitor(4000);
    // A dense stream of pauses, each safely below the 50 ms floor: individually they are the jitter the
    // floor exists to ignore, but together they are hundreds of ms a queued request really waited.
    for (let i = 0; i < 14; i++) { blockLoop(35); await tick(55); }
    const { severeStalledMs, p99 } = monitor.lag();
    monitor.stop();
    expect(severeStalledMs).toBeLessThan(50);
    // ~40 % of histogram samples sit inside a ~35 ms block, so the tail percentile must be well above
    // the idle floor — this is the half of the contract the severe sum deliberately does not carry.
    expect(p99).toBeGreaterThan(10);
  });

  // Regression for a reproduced accounting bug: a stall spanning a window roll was credited in FULL to
  // both halves, so a reader could be told "351 ms stalled" about a 120 ms window. The intervals must
  // be clipped to the window actually reported.
  it('clips a stall spanning a window roll — severeStalledMs never exceeds windowMs', async () => {
    // 150 ms window → halves roll every 75 ms. The phases matter: when the block ends, the overdue
    // roll (due at 150) fires BEFORE the overdue stall tick (due at 200), so the recorded stall
    // interval straddles the new window edge — the exact shape the old per-half accounting credited
    // in full to both windows ("351 ms stalled" reported about a 120 ms window, reproduced).
    const monitor = startLoopLagMonitor(150);
    await tick(130); // baseline stall tick at ~100, first roll at ~75 — both halves in rotation
    blockLoop(400);
    await tick(30);
    const fresh = monitor.lag(); // this window still reaches back before the stall: all of it counts
    expect(fresh.severeStalledMs).toBeGreaterThan(250);
    expect(fresh.severeStalledMs).toBeLessThanOrEqual(fresh.windowMs);
    // Past the next roll the read window STARTS just after the stall interval's end: only the sliver
    // inside the window may count, however long the interval itself was.
    await tick(70);
    const rolled = monitor.lag();
    monitor.stop();
    expect(rolled.severeStalledMs).toBeLessThanOrEqual(rolled.windowMs);
  });

  it('stops sampling when stopped', async () => {
    const monitor = startLoopLagMonitor();
    await tick(30);
    monitor.stop();
    blockLoop(150);
    await tick(20);
    expect(monitor.lag().max).toBeLessThan(100);
  });
});

describe('loop lag watchdog', () => {
  /** A monitor whose readings the test drives directly — the watchdog's logic is what is under test. */
  const scripted = (readings: LoopLag[]) => {
    let i = 0;
    return { lag: () => readings[Math.min(i++, readings.length - 1)], stop: () => { /* nothing */ } };
  };
  const quiet: LoopLag = { p50: 1, p99: 1, max: 2, severeStalledMs: 0, windowMs: 45_000 };
  const busy: LoopLag = { p50: 40, p99: 400, max: 900, severeStalledMs: 3000, windowMs: 45_000 };

  const collect = async (readings: LoopLag[], checks: number) => {
    const lines: string[] = [];
    const log = { warn: (m: string) => lines.push(`WARN ${m}`), info: (m: string) => lines.push(`INFO ${m}`) };
    const stop = watchLoopLag(scripted(readings), log, { checkMs: 1, thresholdMs: 150 });
    await new Promise((r) => setTimeout(r, checks));
    stop();
    return lines;
  };

  it('says nothing while the loop keeps up', async () => {
    expect(await collect([quiet], 30)).toEqual([]);
  });

  // A saturated daemon must leave a trace — during the incident that motivated this, the only evidence
  // was a masked provider error, and nothing said the loop itself had stalled.
  it('warns once when the loop stops keeping up, not once per check', async () => {
    const lines = await collect([busy], 40);
    expect(lines.filter((l) => l.startsWith('WARN'))).toHaveLength(1);
    expect(lines[0]).toContain('p99 400ms');
    // The sum of stalls is the number that explains client-observed latency; the warning must carry it.
    expect(lines[0]).toContain('severe stalls 3000ms of the last 45s');
  });

  it('reports recovery, and warns again if it degrades a second time', async () => {
    const lines = await collect([busy, busy, quiet, quiet, busy], 60);
    expect(lines.map((l) => l.split(' ')[0])).toEqual(['WARN', 'INFO', 'WARN']);
  });

  it('warns for rare severe stalls even when p99 stays low', async () => {
    const below = { ...quiet, max: 2000, severeStalledMs: 2000 };
    const severe = { ...quiet, max: 2700, severeStalledMs: 2001 };
    const lines = await collect([below, severe, severe], 40);

    expect(lines.filter((l) => l.startsWith('WARN'))).toHaveLength(1);
    expect(lines[0]).toContain('max 2700ms');
    expect(lines[0]).toContain('severe stalls 2001ms of the last 45s');
  });
});
