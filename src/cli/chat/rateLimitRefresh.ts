/** Keeping the right-rail "Limits" section fresh WITHOUT spamming the upstream API. The daemon caches
 *  provider usage for 60 s (single-flight, stale-on-error), so the CLI is free to poll on a turn
 *  settling and on a slow tick during very long turns — those requests ride the cache. The policy is a
 *  pure decision so the throttle/interval boundary is unit-testable away from timers and I/O. */

/** A turn settles at most every 60 s of wall clock as far as a refresh is concerned — matches the
 *  daemon's usage cache TTL, so an idle refresh never reaches past the cache. */
export const RATE_LIMIT_IDLE_THROTTLE_MS = 60_000;

/** While a turn keeps running, refresh every 5 minutes so a very long turn's rail does not go stale. */
export const RATE_LIMIT_RUNNING_INTERVAL_MS = 300_000;

/** `idle` — a turn just settled; `interval` — the periodic tick fired while a turn is still running. */
export type RateLimitRefreshEvent = 'idle' | 'interval';

/** Whether a rate-limit fetch should fire now, given when the last one went out. `idle` is throttled
 *  to the 60 s cache TTL so back-to-back turns fetch once; `interval` is gated to 5 minutes since the
 *  last fetch so an idle refresh immediately before a tick does not double-fetch. Pure. */
export function shouldRefreshRateLimits(
  lastFetchAt: number,
  now: number,
  event: RateLimitRefreshEvent,
): boolean {
  const elapsed = now - lastFetchAt;
  if (event === 'idle') return elapsed >= RATE_LIMIT_IDLE_THROTTLE_MS;
  return elapsed >= RATE_LIMIT_RUNNING_INTERVAL_MS;
}
