import { daemonUrl, clearCookie, namedCookie, readNamedCookie, requireSameOrigin, tokenFromCookie, RETURN_COOKIE, IMPERSONATING_COOKIE, isHttps } from '../../../../lib/proxy';

// Proxy-owned logout: cancel an impersonation transition atomically when its proof is present, otherwise
// revoke the active session, then expire every browser auth cookie even if the daemon is unreachable.
export async function POST(req: Request): Promise<Response> {
  // Reject cross-origin logout (logout CSRF — a forced sign-out is a nuisance DoS otherwise).
  const blocked = requireSameOrigin(req);
  if (blocked) return blocked;
  const secure = isHttps(req);
  const token = tokenFromCookie(req);
  const returnCode = readNamedCookie(req, RETURN_COOKIE);
  let transitionCancelled = false;
  if (token && returnCode) {
    try {
      const cancelled = await fetch(`${daemonUrl()}/auth/impersonation/cancel`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ returnCode }),
      });
      transitionCancelled = cancelled.ok;
    } catch { /* daemon down: still clear locally */ }
  }
  if (token && !transitionCancelled) {
    await fetch(`${daemonUrl()}/auth/logout`, { method: 'POST', headers: { authorization: `Bearer ${token}` } })
      .catch(() => { /* daemon down: still clear locally */ });
  }
  const headers = new Headers({ 'content-type': 'application/json' });
  headers.append('set-cookie', clearCookie(secure));
  headers.append('set-cookie', namedCookie(RETURN_COOKIE, '', secure, 0));
  headers.append('set-cookie', namedCookie(IMPERSONATING_COOKIE, '', secure, 0, false));
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
}
