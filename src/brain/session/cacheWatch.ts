import { logger } from '../../shared/logger.js';
import { cacheTtlMs } from './toolResultClearing.js';

/** Prompt-cache observability, modeled on Claude Code's promptCacheBreakDetection. In a healthy
 *  append-only conversation `cacheRead` grows monotonically: each request reads the prefix the
 *  previous request wrote. A DROP means the prefix changed (a bug in an egress transform, a tools or
 *  system-prompt mutation) — exactly the failure mode toolResultClearing is designed to avoid, so this
 *  watcher is its production tripwire. Detection only, never repair.
 *
 *  Two expected drops are suppressed: a REAL compaction (baseline resets) and an idle gap beyond the
 *  cache TTL (the entry expired; re-caching is unavoidable and not a break). Installed for Anthropic
 *  sessions only — other providers report best-effort cache stats whose drops are routine noise. */

const log = logger('brain-cache');

/** Below BOTH thresholds a drop is noise: small absolute swings happen with thinking-block variance. */
export const CACHE_DROP_MIN_TOKENS = 2000;
export const CACHE_DROP_MIN_RATIO = 0.05;

type SessionEvent = { type?: string; message?: { role?: string; timestamp?: number; usage?: { cacheRead?: number } }; aborted?: boolean; result?: unknown };
type Subscribable = { subscribe?: (listener: (event: SessionEvent) => void) => unknown };

export interface CacheWatchOptions {
  /** Warm window in ms; a drop after a longer gap is TTL expiry, not a break. Defaults to the cache
   *  TTL MINUS a 1-minute buffer — the opposite rounding direction from the clearing gate, because a
   *  drop in the boundary minute (e.g. 60–61 min) is a real expiry and must not cry break. */
  ttlMs?: number;
  now?: () => number;
}

export function installCacheWatch(
  session: Subscribable,
  options: CacheWatchOptions = {},
): void {
  if (typeof session.subscribe !== 'function') return;
  const ttlMs = options.ttlMs ?? (cacheTtlMs(process.env) - 60_000);
  const now = options.now ?? Date.now;
  let previous: { cacheRead: number; at: number } | null = null;
  session.subscribe((event) => {
    if (event.type === 'compaction_end' && !event.aborted && event.result) {
      // Post-compaction history is genuinely smaller; the next request's lower cacheRead is by design.
      previous = null;
      return;
    }
    if (event.type !== 'message_end') return;
    const message = event.message;
    if (message?.role !== 'assistant') return;
    const cacheRead = message.usage?.cacheRead;
    if (typeof cacheRead !== 'number') return;
    const at = typeof message.timestamp === 'number' ? message.timestamp : now();
    if (previous) {
      const drop = previous.cacheRead - cacheRead;
      if (
        drop > CACHE_DROP_MIN_TOKENS
        && drop / previous.cacheRead > CACHE_DROP_MIN_RATIO
        && at - previous.at < ttlMs
      ) {
        log.warn(
          `prompt cache read dropped within a warm window: ${previous.cacheRead} → ${cacheRead} tokens `
          + `(${Math.round((at - previous.at) / 1000)}s apart) — an egress transform or prompt change rewrote the prefix`,
        );
      }
    }
    previous = { cacheRead, at };
  });
}
