import { daemonUrl, requireSameOrigin, tokenFromCookie, sessionCookie, namedCookie, RETURN_COOKIE, IMPERSONATING_COOKIE, isHttps, jsonError } from '../../../../lib/proxy';

// Proxy-owned "sign in as": the current admin cookie authorizes a daemon transition. On success the
// active session becomes the target token and RETURN_COOKIE stores only the daemon's opaque, bounded
// return proof. The browser never receives a reusable admin token.
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
  let returnCode: string;
  let tokenTtlDays: number | undefined;
  let user: { name?: string; username?: string } | undefined;
  try {
    ({ token, returnCode, tokenTtlDays, user } = (await upstream.json()) as {
      token: string; returnCode: string; tokenTtlDays?: number; user?: { name?: string; username?: string };
    });
  } catch { return jsonError('bad_gateway', 502); }
  if (!token || !returnCode) return jsonError('bad_gateway', 502);

  const ttl = (typeof tokenTtlDays === 'number' && tokenTtlDays > 0 ? tokenTtlDays : 30) * 86400;
  const secure = isHttps(req);
  const label = user?.name || user?.username || `#${userId}`;
  const headers = new Headers({ 'content-type': 'application/json' });
  headers.append('set-cookie', sessionCookie(token, secure, ttl));
  headers.append('set-cookie', namedCookie(RETURN_COOKIE, returnCode, secure, ttl));
  headers.append('set-cookie', namedCookie(IMPERSONATING_COOKIE, label, secure, ttl, false));
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
}
