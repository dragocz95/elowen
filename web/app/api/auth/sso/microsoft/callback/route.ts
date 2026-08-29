import { SSO_FLOW_COOKIE, ssoErrorCode } from '../../../../../../lib/authSso';
import {
  daemonUrl,
  forwardHeaders,
  IMPERSONATING_COOKIE,
  isHttps,
  namedCookie,
  readNamedCookie,
  RETURN_COOKIE,
  sessionCookie,
} from '../../../../../../lib/proxy';

// A RELATIVE Location, like the success path already uses for `next`. An absolute one built from
// `req.url` resolves to the server's own listen address behind a proxy, so a failed sign-in landed the
// user on `localhost:4500` — a URL that exists only inside the VM, and one that hid the actual error
// code from the login screen that was supposed to show it.
function redirectWithError(req: Request, code: unknown): Response {
  const headers = new Headers({ location: `/?sso_error=${encodeURIComponent(ssoErrorCode(code))}` });
  headers.append('set-cookie', namedCookie(SSO_FLOW_COOKIE, '', isHttps(req), 0));
  return new Response(null, { status: 302, headers });
}

export async function GET(req: Request): Promise<Response> {
  const flowId = readNamedCookie(req, SSO_FLOW_COOKIE);
  if (!flowId) return redirectWithError(req, 'state_expired');

  const query = new URL(req.url).searchParams;
  const state = query.get('state');
  const code = query.get('code');
  if (!state || !code) return redirectWithError(req, 'sso_failed');

  const headers = forwardHeaders(req);
  headers.set('content-type', 'application/json');
  let upstream: Response;
  try {
    upstream = await fetch(`${daemonUrl()}/auth/sso/msteams/callback`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ flowId, state, code }),
    });
  } catch {
    return redirectWithError(req, 'sso_failed');
  }

  if (!upstream.ok) {
    let error: unknown;
    try { error = ((await upstream.json()) as { error?: unknown }).error; } catch { /* invalid daemon body */ }
    return redirectWithError(req, error);
  }

  let token: string;
  let tokenTtlDays: number | undefined;
  let next: string;
  try {
    ({ token, tokenTtlDays, next } = (await upstream.json()) as { token: string; tokenTtlDays?: number; next: string });
    if (!token || !next) throw new Error('invalid SSO callback response');
  } catch {
    return redirectWithError(req, 'sso_failed');
  }

  // `next` is consumed from the daemon's one-time flow record. It was validated when the flow started,
  // so the callback does not trust or reconstruct a target from its public query string.
  const ttlDays = typeof tokenTtlDays === 'number' && tokenTtlDays > 0 ? tokenTtlDays : 30;
  const secure = isHttps(req);
  const responseHeaders = new Headers({ location: next });
  responseHeaders.append('set-cookie', sessionCookie(token, secure, ttlDays * 86400));
  responseHeaders.append('set-cookie', namedCookie(RETURN_COOKIE, '', secure, 0));
  responseHeaders.append('set-cookie', namedCookie(IMPERSONATING_COOKIE, '', secure, 0, false));
  responseHeaders.append('set-cookie', namedCookie(SSO_FLOW_COOKIE, '', secure, 0));
  return new Response(null, { status: 302, headers: responseHeaders });
}
