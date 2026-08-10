'use client';

/** Hard floor under both silence limits, mirroring the daemon's `MIN_STREAM_SILENCE_MS`
 *  (`src/store/configStore.ts`, which clamps to the same value on save). The daemon heartbeats every 30 s
 *  whether or not a turn is running, and that beat is the only reason silence is measurable at all: a limit
 *  at or below the beat interval declares a healthy stream dead in the ordinary gap BETWEEN two beats, and
 *  the reconnect it triggers produces the next gap, so the tear-down repeats for as long as the setting
 *  stands. Re-applied here rather than trusted from the wire, because the browser does not control which
 *  daemon version answered GET /config. */
export const MIN_SILENCE_LIMIT_MS = 35_000;

/** The two silence limits — a PAIR describing one question ("how long may the stream go without a sign of
 *  life") asked at two different moments. Operator-tunable through `runtime.limits`. */
export interface StreamSilenceLimits {
  /** No frame at all for this long, on a page the user is looking at, means the stream is dead. */
  limitMs: number;
  /** How stale a stream may be at a wake-up before it is reconnected without waiting for the watchdog. A
   *  frozen page runs no timers, so the tick that should have caught this never happened. */
  reviveLimitMs: number;
}

/** Used until the daemon's config lands, and for any field it does not carry (an older daemon). Both keep
 *  the values that were hardcoded before the setting existed. */
export const DEFAULT_STREAM_SILENCE: StreamSilenceLimits = { limitMs: 75_000, reviveLimitMs: 45_000 };

/** Poll granularity: the silence is detected within this much of the limit. */
const CHECK_INTERVAL_MS = 5_000;

const floored = (value: number | undefined, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? Math.max(MIN_SILENCE_LIMIT_MS, value) : fallback;

/** Read the configured pair out of the daemon's runtime limits, per field, holding each at the heartbeat
 *  floor. Structurally typed rather than importing `RuntimeLimits`, so a caller may pass the limits block
 *  of a config that has not arrived yet (or came from a daemon too old to carry these fields). */
export function resolveStreamSilence(
  limits?: { streamSilenceLimitMs?: number; streamReviveSilenceLimitMs?: number },
): StreamSilenceLimits {
  return {
    limitMs: floored(limits?.streamSilenceLimitMs, DEFAULT_STREAM_SILENCE.limitMs),
    reviveLimitMs: floored(limits?.streamReviveSilenceLimitMs, DEFAULT_STREAM_SILENCE.reviveLimitMs),
  };
}

/** Only a server-sent data frame proves liveness. Native EventSource transport errors carry no `data`; if
 *  they refreshed the clock, repeated failed reconnects would suppress the silence watchdog forever. */
export function isStreamDataFrame(event: Event): boolean {
  return typeof (event as MessageEvent).data === 'string';
}

export interface StreamWatchdogOptions {
  /** When the last frame (event OR heartbeat) arrived, as a wall-clock timestamp. */
  lastFrameAt: () => number;
  /** The stream has gone silent — close it and reconnect. */
  onSilent: () => void;
  now?: () => number;
  hidden?: () => boolean;
  limitMs?: number;
  intervalMs?: number;
}

/** Watch a stream for silence and report it. Returns the stop function.
 *
 *  The check is always made against the wall clock, never against how often the interval fired: mobile
 *  browsers freeze timers on a locked phone, so a tick count says nothing about elapsed time. For the same
 *  reason a hidden page is skipped entirely — its timers are unreliable and its stream is expected to be
 *  idle; the wake-up path re-reads the clock instead. */
export function startStreamWatchdog(opts: StreamWatchdogOptions): () => void {
  const now = opts.now ?? (() => Date.now());
  const hidden = opts.hidden ?? (() => document.visibilityState === 'hidden');
  // Floored even when passed explicitly: the caller's value comes from the same untrusted config.
  const limitMs = floored(opts.limitMs, DEFAULT_STREAM_SILENCE.limitMs);
  const timer = setInterval(() => {
    if (hidden()) return;
    if (now() - opts.lastFrameAt() > limitMs) opts.onSilent();
  }, opts.intervalMs ?? CHECK_INTERVAL_MS);
  return () => clearInterval(timer);
}
