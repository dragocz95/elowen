/** The ONE place the daemon decides where a request came from and whether that claim can be trusted.
 *  Every caller that needs a client IP — the login brute-force guard, usage attribution — asks here, so
 *  the precedence rule and the trust decision exist exactly once. */

/** Minimal structural view of the request the rule reads. The real Hono context satisfies it, so
 *  handlers pass `c` directly and tests pass a plain object with the headers they care about. */
export interface OriginRequestCtx {
  req: { header(name: string): string | undefined };
}

/** Where a turn came from. `value` is the rollup/rate-limit key; `kind` says how to read it:
 *  - `ip`       a network address claimed by a proxy header
 *  - `local`    no forwarding header at all — a loopback client (CLI, daemon-local tooling)
 *  - `internal` no HTTP request behind it (cron, boot recovery, sub-agent respawn)
 *  - `platform` a chat platform bridge (`platform:discord`), which has no IP by nature
 *  `trusted` is false whenever the value is a claim the client itself could have written. */
export interface ClientOrigin {
  value: string;
  kind: 'ip' | 'local' | 'internal' | 'platform';
  trusted: boolean;
}

/** Origin for work that no HTTP request ordered. Never falls back to the last human IP: attributing a
 *  cron turn to whoever happened to browse last would be a silent lie in the admin view. */
export const INTERNAL_ORIGIN: ClientOrigin = { value: 'internal', kind: 'internal', trusted: true };

/** Origin for a chat-platform bridge, e.g. `platformOrigin('discord')`. */
export function platformOrigin(platform: string): ClientOrigin {
  return { value: `platform:${platform}`, kind: 'platform', trusted: true };
}

/** Resolve the caller's origin.
 *
 *  `x-real-ip` is written by OUR nginx (`proxy_set_header X-Real-IP $remote_addr`, overwriting whatever
 *  the client sent) and is re-forwarded by the web BFF, so behind the installed proxy it is a fact —
 *  hence `trusted = trustProxy`. `x-forwarded-for` is accepted only as a last-resort hint and is ALWAYS
 *  untrusted: the client writes it itself and the BFF refuses to forward it. No header at all means
 *  nobody proxied the request, i.e. a loopback client.
 *
 *  `trustProxy` is the operator's single switch (`security.trustProxy`): on an install without our nginx
 *  in front, even `x-real-ip` is just a claim. The BFF does not make this decision — it only forwards
 *  the header — so the trust rule lives here alone. */
export function clientOrigin(c: OriginRequestCtx, trustProxy: boolean): ClientOrigin {
  const realIp = c.req.header('x-real-ip')?.trim();
  if (realIp) return { value: realIp, kind: 'ip', trusted: trustProxy };
  const forwarded = c.req.header('x-forwarded-for')?.split(',')[0]?.trim();
  if (forwarded) return { value: forwarded, kind: 'ip', trusted: false };
  return { value: 'local', kind: 'local', trusted: true };
}
