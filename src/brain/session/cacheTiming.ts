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
