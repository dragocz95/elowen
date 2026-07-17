import { describe, it, expect } from 'vitest';
import {
  RATE_LIMIT_IDLE_THROTTLE_MS,
  RATE_LIMIT_RUNNING_INTERVAL_MS,
  shouldRefreshRateLimits,
} from '../../../src/cli/chat/rateLimitRefresh.js';

describe('shouldRefreshRateLimits', () => {
  it('throttles turn-settle refreshes to the usage-cache TTL', () => {
    const now = 1_000_000;
    // First settle after a fresh start (last fetch long ago) fires.
    expect(shouldRefreshRateLimits(0, now, 'idle')).toBe(true);
    // A settle right after a fetch is throttled.
    expect(shouldRefreshRateLimits(now, now, 'idle')).toBe(false);
    expect(shouldRefreshRateLimits(now, now + RATE_LIMIT_IDLE_THROTTLE_MS - 1, 'idle')).toBe(false);
    // Once the TTL elapses, the next settle fires again.
    expect(shouldRefreshRateLimits(now, now + RATE_LIMIT_IDLE_THROTTLE_MS, 'idle')).toBe(true);
  });

  it('polls a long-running turn only every 5 minutes since the last fetch', () => {
    const now = 5_000_000;
    expect(shouldRefreshRateLimits(now, now, 'interval')).toBe(false);
    expect(shouldRefreshRateLimits(now, now + RATE_LIMIT_IDLE_THROTTLE_MS, 'interval')).toBe(false);
    expect(shouldRefreshRateLimits(now, now + RATE_LIMIT_RUNNING_INTERVAL_MS - 1, 'interval')).toBe(false);
    expect(shouldRefreshRateLimits(now, now + RATE_LIMIT_RUNNING_INTERVAL_MS, 'interval')).toBe(true);
  });

  it('does not double-fetch: an interval tick soon after a settle refresh is skipped', () => {
    const fetchedAt = 2_000_000;
    // A settle just fetched at `fetchedAt`; a tick 60s later must not fetch again.
    expect(shouldRefreshRateLimits(fetchedAt, fetchedAt + 60_000, 'interval')).toBe(false);
  });
});
