import { daemonUrl, requireSameOrigin, tokenFromCookie, readCookie, sessionCookie, namedCookie, RETURN_COOKIE, IMPERSONATING_COOKIE, isHttps, jsonError } from '../../../../lib/proxy';

// End an impersonation started by /api/auth/impersonate: restore the admin token stashed in
// RETURN_COOKIE as the active session, revoke the (ephemeral) impersonation token daemon-side, and
// clear the impersonation cookies. No-op error when there's nothing to restore.
export async function POST(req: Request): Promise<Response> {
  const blocked = requireSameOrigin(req);
  if (blocked) return blocked;
  const adminToken = readCookie(req, RETURN_COOKIE);
  if (!adminToken) return jsonError('not_impersonating', 400);

  // Revoke the impersonation token so it doesn't linger past this session (best-effort).
  const current = tokenFromCookie(req);
  if (current && current !== adminToken) {
    await fetch(`${daemonUrl()}/auth/logout`, { method: 'POST', headers: { authorization: `Bearer ${current}` } }).catch(() => { /* daemon down: still restore locally */ });
  }

  const secure = isHttps(req);
  const headers = new Headers({ 'content-type': 'application/json' });
  headers.append('set-cookie', sessionCookie(adminToken, secure, 30 * 86400)); // restore the admin session
  headers.append('set-cookie', namedCookie(RETURN_COOKIE, '', secure, 0));                 // clear stash
  headers.append('set-cookie', namedCookie(IMPERSONATING_COOKIE, '', secure, 0, false));   // clear hint
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
}
