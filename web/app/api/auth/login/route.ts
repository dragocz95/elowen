import { daemonUrl, sessionCookie, namedCookie, requireSameOrigin, jsonError, isHttps, RETURN_COOKIE, IMPERSONATING_COOKIE } from '../../../../lib/proxy';

// Proxy-owned login: forward credentials to the daemon, and on success mint the httpOnly session
// cookie here. The daemon token is placed in the cookie and never returned to the browser body, so
// page JS (and any XSS) can't read it.
export async function POST(req: Request): Promise<Response> {
  // Reject cross-origin logins (login CSRF: an attacker could otherwise force a victim into the
  // attacker's session). The session cookie isn't sent on the forging request, so SameSite won't help.
  const blocked = requireSameOrigin(req);
  if (blocked) return blocked;
  const body = await req.text();
  // Forward the trusted client IP so the daemon's login rate-limit keys per-source instead of
  // bucketing every login as 'unknown'. The reverse proxy sets x-real-ip on the inbound request
  // (overwriting any client-supplied value), and the daemon is localhost-only, so this can't be forged.
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const realIp = req.headers.get('x-real-ip');
  if (realIp) headers['x-real-ip'] = realIp;
  const upstream = await fetch(`${daemonUrl()}/auth/login`, { method: 'POST', headers, body });
  if (!upstream.ok) {
    // Pass the daemon's status/body through (e.g. 401 bad credentials) without minting a cookie.
    return new Response(await upstream.text(), { status: upstream.status, headers: { 'content-type': 'application/json' } });
  }
  let token: string;
  let tokenTtlDays: number | undefined;
  try {
    ({ token, tokenTtlDays } = (await upstream.json()) as { token: string; tokenTtlDays?: number });
  } catch {
    // Daemon answered 200 with a non-JSON body (e.g. an upstream gateway error page) — fail closed.
    return jsonError('bad_gateway', 502);
  }
  // Persist the cookie for the token's full lifetime. Fall back to 30 days to match the daemon default
  // if an older daemon doesn't report its TTL, so the cookie is never a short-lived session cookie.
  const ttlDays = typeof tokenTtlDays === 'number' && tokenTtlDays > 0 ? tokenTtlDays : 30;
  // A fresh login starts a clean session — clear any stale impersonation stash so a previous admin's
  // "sign in as" token can't survive across a re-login on the same browser.
  const secure = isHttps(req);
  const resHeaders = new Headers({ 'content-type': 'application/json' });
  resHeaders.append('set-cookie', sessionCookie(token, secure, ttlDays * 86400));
  resHeaders.append('set-cookie', namedCookie(RETURN_COOKIE, '', secure, 0));
  resHeaders.append('set-cookie', namedCookie(IMPERSONATING_COOKIE, '', secure, 0, false));
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: resHeaders });
}
