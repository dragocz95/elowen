const LOGIN_MAX = 10;
const LOGIN_WINDOW_MS = 5 * 60_000;

export interface LoginRateLimiter {
  limited(ip: string, now: number): boolean;
  clear(ip: string): void;
}

/** One fixed-window limiter shared by password login and Microsoft SSO for a server process. */
export function createLoginRateLimiter(): LoginRateLimiter {
  const hits = new Map<string, { count: number; resetAt: number }>();
  return {
    limited(ip, now) {
      if (hits.size > 5000) {
        for (const [key, value] of hits) if (now >= value.resetAt) hits.delete(key);
      }
      const hit = hits.get(ip);
      if (!hit || now >= hit.resetAt) {
        hits.set(ip, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
        return false;
      }
      hit.count++;
      return hit.count > LOGIN_MAX;
    },
    clear(ip) {
      hits.delete(ip);
    },
  };
}
