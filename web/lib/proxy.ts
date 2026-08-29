// Server-side BFF proxy helpers. The browser only ever talks to this web origin; these helpers let
// the route handlers translate the httpOnly session cookie into a daemon bearer token, guard against
// cross-origin (CSRF) writes, and forward request headers cleanly. None of this runs in the browser.
/** Plain-HTTP installs cannot use the `__Host-` prefix because that prefix requires `Secure`.
 *  Production HTTPS uses a different name, not merely different attributes: a sibling site subdomain
 *  may set `Domain=agent.example` cookies, but browsers refuse to mint a `__Host-` cookie with Domain.
 *  The app deliberately does NOT fall back to the legacy name on HTTPS — such a fallback would reopen
 *  cookie tossing for every browser that had not yet received the new cookie. */
export const COOKIE_NAME = 'elowen_session';
export const SECURE_COOKIE_NAME = '__Host-elowen_session';

export function daemonUrl(): string {
  return process.env.ELOWEN_DAEMON_URL ?? 'http://localhost:4400';
}

const ATTRS = 'HttpOnly; SameSite=Lax; Path=/';

/** Whether the browser reached us over HTTPS. The reverse proxy forwards the original scheme in
 *  X-Forwarded-Proto (nginx: `proxy_set_header X-Forwarded-Proto $scheme`); absent means a direct
 *  plain-HTTP hit (localhost / IP:4500). The session cookie is marked `Secure` ONLY over HTTPS —
 *  marking it Secure on a plain-HTTP deployment makes the browser silently drop it, so every
 *  post-login request arrives without the cookie and the daemon answers 401 across the board. */
export function isHttps(req: Request): boolean {
  return (req.headers.get('x-forwarded-proto') ?? '').split(',')[0].trim().toLowerCase() === 'https';
}

export const sessionCookieName = (secure: boolean): string => secure ? SECURE_COOKIE_NAME : COOKIE_NAME;
const namedCookieName = (name: string, secure: boolean): string => secure ? `__Host-${name}` : name;

/** Mint the httpOnly session cookie. `maxAgeSeconds` MUST match the daemon token's TTL so the browser
 *  keeps the cookie for exactly as long as the daemon will accept the token; without a Max-Age the
 *  browser treats it as a session cookie and drops it on close/suspend (minutes-to-hours on mobile),
 *  logging the user out long before the 30-day token actually expires. */
export function sessionCookie(token: string, secure: boolean, maxAgeSeconds: number): string {
  return `${sessionCookieName(secure)}=${token}; ${ATTRS}${secure ? '; Secure' : ''}; Max-Age=${Math.floor(maxAgeSeconds)}`;
}

export function clearCookie(secure: boolean): string {
  return `${sessionCookieName(secure)}=; ${ATTRS}${secure ? '; Secure' : ''}; Max-Age=0`;
}

// Impersonation ("sign in as") cookies, set only while an admin views the app as another user:
//  - RETURN_COOKIE: httpOnly stash of the admin's OWN token, so "stop impersonating" can restore it.
//  - IMPERSONATING_COOKIE: a JS-readable display hint (the target's name) so the UI can show a banner.
//    It carries no authority — the session token above is what actually authenticates.
export const RETURN_COOKIE = 'elowen_return';
export const IMPERSONATING_COOKIE = 'elowen_as';

/** Build a Set-Cookie string for an arbitrary cookie name. HTTPS cookies get the same sibling-domain
 *  protection as the main session. `httpOnly=false` is reserved for the non-sensitive impersonation
 *  display hint; `__Host-` does not require HttpOnly, only Secure + Path=/ + no Domain. */
export function namedCookie(name: string, value: string, secure: boolean, maxAgeSeconds: number, httpOnly = true): string {
  const attrs = `${httpOnly ? 'HttpOnly; ' : ''}SameSite=Lax; Path=/`;
  return `${namedCookieName(name, secure)}=${encodeURIComponent(value)}; ${attrs}${secure ? '; Secure' : ''}; Max-Age=${Math.floor(maxAgeSeconds)}`;
}

/** Read (and URL-decode) an arbitrary cookie by name from a raw Cookie header, or null when absent.
 *  Anchored so one cookie name can't match as a substring of another. */
export function readCookieHeader(cookieHeader: string, name: string): string | null {
  const m = cookieHeader.match(new RegExp(`(?:^|; )${name}=([^;]+)`));
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    // Cookie bytes are untrusted input. A malformed percent escape means this cookie is unusable, not
    // that every BFF route and server-rendered page should throw 500 before reaching its auth guard.
    return null;
  }
}

/** Read (and URL-decode) an arbitrary cookie by its exact name from the request, or null when absent. */
function readCookie(req: Request, name: string): string | null {
  return readCookieHeader(req.headers.get('cookie') ?? '', name);
}

/** Read a BFF-owned named cookie under the name valid for this transport. There is intentionally no
 *  HTTPS fallback to the unprefixed name: a sibling subdomain can create that legacy cookie for the
 *  parent host, which is why the authoritative cookie was prefixed in the first place. */
export function readNamedCookie(req: Request, name: string): string | null {
  return readCookie(req, namedCookieName(name, isHttps(req)));
}

/** Same-origin guard for mutating requests (CSRF defense-in-depth on top of SameSite=Lax).
 *  A missing Origin header (same-origin GET navigations, some same-origin fetches) is allowed;
 *  a present Origin must match our host. We compare host, not the full origin, because a
 *  TLS-terminating reverse proxy makes the app see http:// internally while the browser's Origin
 *  is https:// — the scheme differs but the host (which is what an attacker can't forge) is what
 *  matters. The host the browser targeted comes from the forwarded Host header. */
export function isSameOrigin(req: Request): boolean {
  const origin = req.headers.get('origin');
  if (origin == null) return true;
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return false; // malformed Origin
  }
  const host = req.headers.get('host') ?? new URL(req.url).host;
  return originHost === host;
}

/** Read the session token from the httpOnly cookie header, or null when absent. The single place
 *  the cookie is parsed, so every route handler reads it the same way — through `readCookie`, whose
 *  pattern is ANCHORED. Matching unanchored made a cookie whose name merely ENDS with this one
 *  (`xelowen_session`) win the match, so anyone able to set a cookie on the domain — a sibling
 *  subdomain, say — could substitute the session the app then acts as. */
export function tokenFromCookie(req: Request): string | null {
  return readCookie(req, sessionCookieName(isHttps(req)));
}

/** A JSON `{ error }` Response with the given status. The uniform error shape every BFF route
 *  returns, so the client's `apiErrorMessage` can read `.error` consistently. */
export function jsonError(error: string, status: number): Response {
  return new Response(JSON.stringify({ error }), { status, headers: { 'content-type': 'application/json' } });
}

/** CSRF guard for a mutating route: a 403 Response when the request is cross-origin, else null
 *  (proceed). Wraps `isSameOrigin` so handlers just `const blocked = requireSameOrigin(req); if (blocked) return blocked;`. */
export function requireSameOrigin(req: Request): Response | null {
  return isSameOrigin(req) ? null : jsonError('forbidden', 403);
}

/** Headers safe to forward from the browser to the daemon. An allow-list (not a deny-list) so a
 *  client can never smuggle its own `authorization` (the proxy injects the real bearer) or inject
 *  hop-by-hop headers. `x-forwarded-for` and `forwarded` stay OUT deliberately: the browser writes
 *  those itself, so forwarding them would let any client dictate the source address the daemon
 *  rate-limits and attributes spend by. Only content-negotiation headers and byte ranges pass through. */
const FORWARD_ALLOW = new Set(['content-type', 'accept', 'accept-language', 'range']);

/** The one header we re-emit rather than pass through. nginx OVERWRITES it with the real peer
 *  (`proxy_set_header X-Real-IP $remote_addr`), so the value arriving here is the proxy's statement,
 *  not the client's — which is precisely why it is the only source address the daemon will consider.
 *  Whether to BELIEVE it is not decided here: the daemon owns that (`security.trustProxy`, read in
 *  `src/api/clientIp.ts`), so the trust rule exists in exactly one place. The login route has forwarded
 *  this header on its own since the rate-limiter needed it; this generalizes that to every proxied
 *  request, which is what lets the daemon attribute usage to an origin at all. */
const REAL_IP_HEADER = 'x-real-ip';

export function forwardHeaders(req: Request): Headers {
  const h = new Headers();
  for (const [key, value] of req.headers) {
    if (FORWARD_ALLOW.has(key.toLowerCase())) h.set(key, value);
  }
  const realIp = req.headers.get(REAL_IP_HEADER);
  if (realIp) h.set(REAL_IP_HEADER, realIp);
  return h;
}
