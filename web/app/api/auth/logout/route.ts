import { daemonUrl, clearCookie, namedCookie, readCookie, requireSameOrigin, tokenFromCookie, RETURN_COOKIE, IMPERSONATING_COOKIE, isHttps } from '../../../../lib/proxy';

// Proxy-owned logout: best-effort daemon-side logout with the cookie's token, then expire the cookie
// regardless so the browser session ends even if the daemon is unreachable. If the user is logged out
// mid-impersonation, ALSO revoke + clear the stashed admin token — otherwise that admin credential
// lingers in the browser (httpOnly, 30 days) and a later "stop impersonating" could resurrect it.
export async function POST(req: Request): Promise<Response> {
  // Reject cross-origin logout (logout CSRF — a forced sign-out is a nuisance DoS otherwise).
  const blocked = requireSameOrigin(req);
  if (blocked) return blocked;
  const secure = isHttps(req);
  const token = tokenFromCookie(req);
  const returnToken = readCookie(req, RETURN_COOKIE); // admin token stashed while impersonating, if any
  // Revoke both the active session token AND any stashed admin token (distinct tokens → both need it).
  const revoke = [token, returnToken && returnToken !== token ? returnToken : undefined].filter(Boolean) as string[];
  await Promise.all(revoke.map((t) =>
    fetch(`${daemonUrl()}/auth/logout`, { method: 'POST', headers: { authorization: `Bearer ${t}` } }).catch(() => { /* daemon down: still clear locally */ }),
  ));
  const headers = new Headers({ 'content-type': 'application/json' });
  headers.append('set-cookie', clearCookie(secure));
  headers.append('set-cookie', namedCookie(RETURN_COOKIE, '', secure, 0));
  headers.append('set-cookie', namedCookie(IMPERSONATING_COOKIE, '', secure, 0, false));
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
}
