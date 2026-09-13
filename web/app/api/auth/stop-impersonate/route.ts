import { daemonUrl, requireSameOrigin, tokenFromCookie, readNamedCookie, sessionCookie, namedCookie, RETURN_COOKIE, IMPERSONATING_COOKIE, isHttps, jsonError } from '../../../../lib/proxy';

// End an impersonation started by /api/auth/impersonate. The daemon atomically revokes the target
// session and returns a fresh administrator token; a short idempotent retry window covers lost responses.
export async function POST(req: Request): Promise<Response> {
  const blocked = requireSameOrigin(req);
  if (blocked) return blocked;
  const returnCode = readNamedCookie(req, RETURN_COOKIE);
  if (!returnCode) return jsonError('not_impersonating', 400);
  const current = tokenFromCookie(req);
  if (!current) return jsonError('unauthorized', 401);

  let upstream: Response;
  try {
    upstream = await fetch(`${daemonUrl()}/auth/impersonation/stop`, {
      method: 'POST',
      headers: { authorization: `Bearer ${current}`, 'content-type': 'application/json' },
      body: JSON.stringify({ returnCode }),
    });
  } catch {
    return jsonError('bad_gateway', 502);
  }
  if (!upstream.ok) return new Response(await upstream.text(), { status: upstream.status, headers: { 'content-type': 'application/json' } });

  let token: string;
  let tokenTtlDays: number | undefined;
  try { ({ token, tokenTtlDays } = (await upstream.json()) as { token: string; tokenTtlDays?: number }); }
  catch { return jsonError('bad_gateway', 502); }
  if (!token) return jsonError('bad_gateway', 502);

  const secure = isHttps(req);
  const ttl = (typeof tokenTtlDays === 'number' && tokenTtlDays > 0 ? tokenTtlDays : 30) * 86400;
  const headers = new Headers({ 'content-type': 'application/json' });
  headers.append('set-cookie', sessionCookie(token, secure, ttl));
  headers.append('set-cookie', namedCookie(RETURN_COOKIE, '', secure, 0));
  headers.append('set-cookie', namedCookie(IMPERSONATING_COOKIE, '', secure, 0, false));
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
}
