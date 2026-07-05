import { daemonUrl, requireSameOrigin, tokenFromCookie, sessionCookie, namedCookie, RETURN_COOKIE, IMPERSONATING_COOKIE, isHttps, jsonError } from '../../../../lib/proxy';

// Proxy-owned "sign in as": an admin swaps their session to another user's. The admin's current token
// (from the session cookie) authorizes a daemon impersonate call; on success we swap COOKIE_NAME to the
// target token, stash the admin token in RETURN_COOKIE (httpOnly) so it can be restored, and drop a
// readable hint cookie for the banner. The daemon enforces admin-only, so a non-admin's token 403s here.
export async function POST(req: Request): Promise<Response> {
  const blocked = requireSameOrigin(req);
  if (blocked) return blocked;
  const adminToken = tokenFromCookie(req);
  if (!adminToken) return jsonError('unauthorized', 401);
  let userId: unknown;
  try { ({ userId } = (await req.json()) as { userId?: unknown }); } catch { return jsonError('bad_request', 400); }
  if (typeof userId !== 'number') return jsonError('bad_request', 400);

  const upstream = await fetch(`${daemonUrl()}/users/${userId}/impersonate`, {
    method: 'POST', headers: { authorization: `Bearer ${adminToken}` },
  });
  if (!upstream.ok) return new Response(await upstream.text(), { status: upstream.status, headers: { 'content-type': 'application/json' } });

  let token: string;
  let tokenTtlDays: number | undefined;
  let user: { name?: string; username?: string } | undefined;
  try { ({ token, tokenTtlDays, user } = (await upstream.json()) as { token: string; tokenTtlDays?: number; user?: { name?: string; username?: string } }); }
  catch { return jsonError('bad_gateway', 502); }

  const ttl = (typeof tokenTtlDays === 'number' && tokenTtlDays > 0 ? tokenTtlDays : 30) * 86400;
  const secure = isHttps(req);
  const label = user?.name || user?.username || `#${userId}`;
  const headers = new Headers({ 'content-type': 'application/json' });
  headers.append('set-cookie', sessionCookie(token, secure, ttl));                              // active session → target
  headers.append('set-cookie', namedCookie(RETURN_COOKIE, adminToken, secure, ttl));            // stash admin token (httpOnly)
  headers.append('set-cookie', namedCookie(IMPERSONATING_COOKIE, label, secure, ttl, false));   // readable banner hint
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
}
