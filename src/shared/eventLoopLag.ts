import { monitorEventLoopDelay } from 'node:perf_hooks';

/** Event loop delay figures in MILLISECONDS, over the reported sampling window. */
export interface LoopLag {
  p50: number;
  p99: number;
  max: number;
  /** Time the loop spent in SEVERE stalls — individual late timer gaps of at least
   *  {@link STALL_FLOOR_MS} — clipped to the reported window. `max` is the single worst stall; this is
   *  their SUM, and the sum, not the max, is what bounds how long a request may have queued behind the
   *  loop. Measured incident: `/health` took 19.9 s (plus two 20 s client timeouts) while `max`
   *  reported 4.1 s, because each request waited through a CHAIN of multi-second stalls, none of which
   *  was individually 20 s long.
   *
   *  The floor makes this a LOWER bound, and the name says so: a dense run of sub-floor stalls
   *  (a hundred 49 ms pauses is 4.9 s of real queueing) contributes NOTHING here — but it saturates
   *  the delay histogram, so that pattern is visible in `p50`/`p99` instead. The two metrics cover
   *  each other's blind spot: rare long stalls barely move a percentile, dense short ones never reach
   *  this sum. */
  severeStalledMs: number;
  /** How much history the numbers above describe. Between half and one full configured window once the
   *  monitor has warmed up — see the double-buffering note in {@link startLoopLagMonitor}. */
  windowMs: number;
}

export interface LoopLagMonitor {
  /** Figures over the older of the two staggered windows. */
  lag(): LoopLag;
  /** Stop sampling and release the timers. */
  stop(): void;
}

/** How long a sampling window lasts. Percentiles that accumulate since process start are useless for
 *  "is it starving RIGHT NOW": one bad minute during a fan-out would keep p99 high for days afterwards,
 *  and a daemon that has been up a week would never show a fresh spike. */
const WINDOW_MS = 60_000;

/** Sampling interval, and therefore the FLOOR of every reading: the histogram records the interval it
 *  actually observed, so an idle loop reports ~`RESOLUTION_MS`, not zero (measured: resolution 1 → idle
 *  p50 1.1 ms, resolution 20 → 20.2 ms). It is set to 1 ms so the numbers stay comparable with the ~1 ms
 *  `/health` round-trip; a coarser sampler would report 20 ms on a perfectly healthy daemon and make
 *  every threshold meaningless. The timer is native (libuv), so the cost is not the JS-side one it looks
 *  like. */
const RESOLUTION_MS = 1;

/** Tick of the JS-side stall accumulator. Coarse on purpose: normal scheduling jitter is single-digit
 *  milliseconds, so at 100 ms the tick itself contributes nothing, and any stall worth counting is far
 *  longer than the tick. */
const STALL_TICK_MS = 100;

/** A late tick only counts as a SEVERE stall above this. Below it is scheduler jitter — and summing
 *  jitter over a 60 s window (600 ticks) would fabricate whole seconds of "stall" on a perfectly
 *  healthy loop. The histogram's 1 ms floor has the same disease in additive form, which is why the
 *  stall sum cannot be derived from the histogram's mean × count. The cost of the floor — dense
 *  sub-floor lateness going uncounted here — is covered by the percentiles (see LoopLag). */
const STALL_FLOOR_MS = 50;

/** One severe stall, as an interval on the performance.now() timeline. Kept as intervals rather than a
 *  per-window running total so a reader can clip them to ITS window: a stall that straddles a window
 *  roll used to be credited in full to BOTH halves, which produced readings where the stall sum
 *  exceeded the window it claimed to describe (observed: stalled 351 ms of a 120 ms window). */
interface StallInterval { start: number; end: number }

const toMs = (nanos: number): number => (Number.isFinite(nanos) ? Math.round(nanos / 1e5) / 10 : 0);

/** Measure how late the event loop runs its own timers — the one number that says whether this process
 *  is keeping up. It is what distinguishes "the provider is slow" from "we never got round to reading
 *  the response", which is invisible from every other metric the daemon reports. */
/** Sustained p99 above this means the loop is not keeping up: callbacks are waiting a tenth of a second
 *  for their turn, which is already visible as a sluggish CLI and web UI. */
const SUSTAINED_P99_MS = 150;

/** Log when the loop starts and stops keeping up. Only the TRANSITIONS are logged — a fan-out that
 *  saturates the daemon for ten minutes should leave two lines, not one per check, or the signal drowns
 *  in the noise it generates. Returns a stop function. */
export function watchLoopLag(
  monitor: LoopLagMonitor,
  log: { warn(m: string): void; info(m: string): void },
  opts: { checkMs?: number; thresholdMs?: number } = {},
): () => void {
  const threshold = opts.thresholdMs ?? SUSTAINED_P99_MS;
  let saturated = false;
  const timer = setInterval(() => {
    const { p50, p99, max, severeStalledMs, windowMs } = monitor.lag();
    if (p99 > threshold && !saturated) {
      saturated = true;
      log.warn(`event loop is not keeping up — p50 ${p50}ms, p99 ${p99}ms, max ${max}ms, severe stalls ${severeStalledMs}ms of the last ${Math.round(windowMs / 1000)}s (a queued request can wait through the SUM of stalls, not just the worst one)`);
    } else if (p99 <= threshold && saturated) {
      saturated = false;
      log.info(`event loop recovered — p50 ${p50}ms, p99 ${p99}ms`);
    }
  }, opts.checkMs ?? 30_000);
  timer.unref();
  return () => clearInterval(timer);
}

export function startLoopLagMonitor(windowMs = WINDOW_MS): LoopLagMonitor {
  // Two histograms staggered by half a window, reset alternately; reads always come from the OLDER one.
  // A single histogram reset on its own timer has a proven failure mode: after a long stall the overdue
  // reset fires in the same timer sweep as the overdue readers, so `/health` and the watchdog read a
  // freshly cleared histogram at the exact moment the spike matters (observed in production: a 5.7 s
  // `/health` response carrying `max: 0`, and a "recovered — p99 0ms" line 30 s after a 4 s stall
  // warning). With the stagger, the reader-facing half always holds between half and one full window of
  // history, so a spike stays visible for at least half a window no matter when it lands.
  const now = () => performance.now();
  const startedAt = now();
  const makeHalf = () => {
    const h = monitorEventLoopDelay({ resolution: RESOLUTION_MS });
    h.enable();
    return { h, resetAt: startedAt };
  };
  // `older` is always the read side and always the next to reset; the roll swaps the roles.
  let older = makeHalf();
  let younger = makeHalf();
  // JS-side stall clock: the histogram can report the worst single stall, but not the total time lost
  // to stalls — its per-sample floor (~0.1 ms of overhead each) sums to seconds over a window, so the
  // total has to be measured directly with a floor that jitter cannot reach. A blocked loop coalesces
  // the missed intervals into one late tick, so a 4 s stall is recorded once, as one ~3.9 s interval.
  // The intervals are shared by both halves and clipped to the read window at read time.
  const stalls: StallInterval[] = [];
  const roll = setInterval(() => {
    older.h.reset();
    older.resetAt = now();
    [older, younger] = [younger, older];
    // Drop what no window can see any more. `older` is now the read side with the EARLIEST resetAt, so
    // anything that ended before it can never be clipped into a future reading.
    while (stalls.length > 0 && (stalls[0] as StallInterval).end <= older.resetAt) stalls.shift();
  }, Math.max(1, windowMs / 2));
  // Never hold the process open for a metric — a daemon shutting down must not wait for this.
  roll.unref();

  let lastTick = now();
  const stallTick = setInterval(() => {
    const t = now();
    const gap = t - lastTick - STALL_TICK_MS;
    lastTick = t;
    if (gap >= STALL_FLOOR_MS) stalls.push({ start: t - gap, end: t });
  }, STALL_TICK_MS);
  stallTick.unref();

  return {
    lag: () => {
      const from = older.resetAt;
      const to = now();
      // Clip each stall to [from, to]. The intervals are disjoint (each ends at the tick that recorded
      // it, and the next starts no earlier), so the clipped sum can never exceed the window length —
      // the invariant 0 <= severeStalledMs <= windowMs holds by construction.
      let stalled = 0;
      for (const s of stalls) stalled += Math.max(0, Math.min(s.end, to) - Math.max(s.start, from));
      return {
        p50: toMs(older.h.percentile(50)),
        p99: toMs(older.h.percentile(99)),
        max: toMs(older.h.max),
        severeStalledMs: Math.round(stalled),
        windowMs: Math.max(1, Math.round(to - from)),
      };
    },
    stop: () => {
      clearInterval(roll);
      clearInterval(stallTick);
      older.h.disable();
      younger.h.disable();
    },
  };
}
