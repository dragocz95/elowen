import { isUserTurn } from './userTurn.js';

interface TimedMessage {
  role?: unknown;
  isMeta?: unknown;
  timestamp?: unknown;
}

/** The longest prompt-cache TTL pi-ai ever uses (PI_CACHE_RETENTION=long). Exported as the fail-closed
 * fallback for gates that need the TTL of a request they did not witness (see coldCompactionGateMs). */
export const LONG_CACHE_TTL_MS = 60 * 60_000;
/** OpenAI Responses prompt caching typically starts evicting after about five minutes. This lower bound is
 *  only for diagnostics: a drop after it may be normal provider eviction rather than a payload break. */
export const OPENAI_CACHE_TTL_MS = 5 * 60_000;
/** OpenAI may retain an inactive prompt cache for up to one hour. Destructive egress transforms must use
 *  the upper bound so they never rewrite a prefix that could still be warm. */
export const OPENAI_CACHE_MAX_RETENTION_MS = 60 * 60_000;

/** pi-ai's short cache TTL is 5 minutes, long (PI_CACHE_RETENTION=long) is 1 hour; the daemon defaults
 * to long. Resolved from the same env var pi-ai reads, so Elowen and pi-ai never disagree. */
export function cacheTtlMs(env: NodeJS.ProcessEnv): number {
  return env.PI_CACHE_RETENTION === 'long' ? LONG_CACHE_TTL_MS : 5 * 60_000;
}

/** Destructive egress transforms need the cache to be DEFINITELY cold, so the shared gate rounds the TTL
 * UP by a 1-minute buffer. cacheWatch rounds the same TTL DOWN instead: a drop near the boundary is
 * expiry, not a break. */
export function idleThresholdMs(env: NodeJS.ProcessEnv, ttlMs = cacheTtlMs(env)): number {
  return ttlMs + 60_000;
}

function lastUserIndex(messages: readonly TimedMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (isUserTurn(messages[index])) return index;
  }
  return -1;
}

/** Was the cache definitely cold when this turn started? Compare the last real user message with the
 * message right before it. During an active tool loop the gap is seconds; after an idle longer than the
 * TTL the gap proves the prefix had expired. */
export function cacheColdAtTurnStart(
  messages: readonly TimedMessage[],
  idleMs: number,
  now: number,
): boolean {
  const lastUser = lastUserIndex(messages);
  if (lastUser <= 0) return false;
  const promptAt = messages[lastUser]?.timestamp;
  const previousAt = messages[lastUser - 1]?.timestamp;
  if (typeof promptAt !== 'number' || typeof previousAt !== 'number') return false;
  // A rehydrated session's prompt is fresh while its history is old; `now` bounds a prompt stamped in
  // the future (clock skew) so the gap cannot be inflated beyond the real idle time.
  return Math.min(promptAt, now) - previousAt > idleMs;
}
