import { daemonUrl, clearCookie, requireSameOrigin, tokenFromCookie, isHttps } from '../../../../lib/proxy';

// Proxy-owned logout: best-effort daemon-side logout with the cookie's token, then expire the cookie
// regardless so the browser session ends even if the daemon is unreachable.
export async function POST(req: Request): Promise<Response> {
  // Reject cross-origin logout (logout CSRF — a forced sign-out is a nuisance DoS otherwise).
  const blocked = requireSameOrigin(req);
  if (blocked) return blocked;
  const token = tokenFromCookie(req);
  if (token) {
    await fetch(`${daemonUrl()}/auth/logout`, { method: 'POST', headers: { authorization: `Bearer ${token}` } }).catch(() => { /* daemon down: still clear locally */ });
  }
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'content-type': 'application/json', 'set-cookie': clearCookie(isHttps(req)) },
  });
}
