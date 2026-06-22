import { daemonUrl, sessionCookie, isSameOrigin, isHttps } from '../../../../lib/proxy';

// Proxy-owned login: forward credentials to the daemon, and on success mint the httpOnly session
// cookie here. The daemon token is placed in the cookie and never returned to the browser body, so
// page JS (and any XSS) can't read it.
export async function POST(req: Request): Promise<Response> {
  // Reject cross-origin logins (login CSRF: an attacker could otherwise force a victim into the
  // attacker's session). The session cookie isn't sent on the forging request, so SameSite won't help.
  if (!isSameOrigin(req)) {
    return new Response(JSON.stringify({ error: 'forbidden' }), { status: 403, headers: { 'content-type': 'application/json' } });
  }
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
  try {
    ({ token } = (await upstream.json()) as { token: string });
  } catch {
    // Daemon answered 200 with a non-JSON body (e.g. an upstream gateway error page) — fail closed.
    return new Response(JSON.stringify({ error: 'bad_gateway' }), { status: 502, headers: { 'content-type': 'application/json' } });
  }
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'content-type': 'application/json', 'set-cookie': sessionCookie(token, isHttps(req)) },
  });
}
