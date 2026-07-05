// Server-side BFF proxy helpers. The browser only ever talks to this web origin; these helpers let
// the route handlers translate the httpOnly session cookie into a daemon bearer token, guard against
// cross-origin (CSRF) writes, and forward request headers cleanly. None of this runs in the browser.
export const COOKIE_NAME = 'orca_session';

export function daemonUrl(): string {
  return process.env.ORCA_DAEMON_URL ?? 'http://localhost:4400';
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

/** Mint the httpOnly session cookie. `maxAgeSeconds` MUST match the daemon token's TTL so the browser
 *  keeps the cookie for exactly as long as the daemon will accept the token; without a Max-Age the
 *  browser treats it as a session cookie and drops it on close/suspend (minutes-to-hours on mobile),
 *  logging the user out long before the 30-day token actually expires. */
export function sessionCookie(token: string, secure: boolean, maxAgeSeconds: number): string {
  return `${COOKIE_NAME}=${token}; ${ATTRS}${secure ? '; Secure' : ''}; Max-Age=${Math.floor(maxAgeSeconds)}`;
}

export function clearCookie(secure: boolean): string {
  return `${COOKIE_NAME}=; ${ATTRS}${secure ? '; Secure' : ''}; Max-Age=0`;
}

// Impersonation ("sign in as") cookies, set only while an admin views the app as another user:
//  - RETURN_COOKIE: httpOnly stash of the admin's OWN token, so "stop impersonating" can restore it.
//  - IMPERSONATING_COOKIE: a JS-readable display hint (the target's name) so the UI can show a banner.
//    It carries no authority — the session token in COOKIE_NAME is what actually authenticates.
export const RETURN_COOKIE = 'orca_return';
export const IMPERSONATING_COOKIE = 'orca_as';

/** Build a Set-Cookie string for an arbitrary cookie name. `httpOnly=false` makes it readable by page
 *  JS (used for the non-sensitive impersonation display hint); values are URL-encoded. */
export function namedCookie(name: string, value: string, secure: boolean, maxAgeSeconds: number, httpOnly = true): string {
  const attrs = `${httpOnly ? 'HttpOnly; ' : ''}SameSite=Lax; Path=/`;
  return `${name}=${encodeURIComponent(value)}; ${attrs}${secure ? '; Secure' : ''}; Max-Age=${Math.floor(maxAgeSeconds)}`;
}

/** Read (and URL-decode) an arbitrary cookie by name from the request, or null when absent. Anchored
 *  so one cookie name can't match as a substring of another. */
export function readCookie(req: Request, name: string): string | null {
  const m = (req.headers.get('cookie') ?? '').match(new RegExp(`(?:^|; )${name}=([^;]+)`));
  return m ? decodeURIComponent(m[1]) : null;
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
 *  the cookie is parsed, so every route handler reads it the same way. */
export function tokenFromCookie(req: Request): string | null {
  const m = (req.headers.get('cookie') ?? '').match(new RegExp(`${COOKIE_NAME}=([^;]+)`));
  return m ? m[1] : null;
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
 *  client can never smuggle its own `authorization` (the proxy injects the real bearer), spoof its
 *  source IP via `x-forwarded-for`/`x-real-ip`/`forwarded` (defeating daemon rate-limiting/audit),
 *  or inject hop-by-hop headers. Only content-negotiation headers pass through. */
const FORWARD_ALLOW = new Set(['content-type', 'accept', 'accept-language']);

export function forwardHeaders(req: Request): Headers {
  const h = new Headers();
  for (const [key, value] of req.headers) {
    if (FORWARD_ALLOW.has(key.toLowerCase())) h.set(key, value);
  }
  return h;
}
