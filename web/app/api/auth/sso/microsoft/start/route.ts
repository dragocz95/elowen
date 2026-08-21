import { safeSsoNext, SSO_FLOW_COOKIE, SSO_FLOW_TTL_SECONDS, ssoErrorCode } from '../../../../../../lib/authSso';
import { daemonUrl, forwardHeaders, isHttps, namedCookie } from '../../../../../../lib/proxy';

function errorRedirect(req: Request, code: unknown): Response {
  const url = new URL('/', req.url);
  url.searchParams.set('sso_error', ssoErrorCode(code));
  return Response.redirect(url, 302);
}

export async function GET(req: Request): Promise<Response> {
  const next = safeSsoNext(new URL(req.url).searchParams.get('next'));
  const headers = forwardHeaders(req);
  headers.set('content-type', 'application/json');

  let upstream: Response;
  try {
    upstream = await fetch(`${daemonUrl()}/auth/sso/msteams/start`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ next }),
    });
  } catch {
    return errorRedirect(req, 'sso_failed');
  }

  if (!upstream.ok) {
    let code: unknown;
    try { code = ((await upstream.json()) as { error?: unknown }).error; } catch { /* invalid daemon body */ }
    return errorRedirect(req, code);
  }

  let flowId: string;
  let authorizationUrl: string;
  try {
    ({ flowId, authorizationUrl } = (await upstream.json()) as { flowId: string; authorizationUrl: string });
    const destination = new URL(authorizationUrl);
    if (!flowId || destination.protocol !== 'https:') throw new Error('invalid SSO start response');
  } catch {
    return errorRedirect(req, 'sso_failed');
  }

  const responseHeaders = new Headers({ location: authorizationUrl });
  responseHeaders.append('set-cookie', namedCookie(SSO_FLOW_COOKIE, flowId, isHttps(req), SSO_FLOW_TTL_SECONDS));
  return new Response(null, { status: 302, headers: responseHeaders });
}
