import { safeSsoNext, SSO_FLOW_COOKIE, SSO_FLOW_TTL_SECONDS, ssoErrorCode } from '../../../../../../lib/authSso';
import { daemonUrl, forwardHeaders, isHttps, namedCookie } from '../../../../../../lib/proxy';

// A RELATIVE Location, resolved by the browser against the address it actually asked for. Building an
// absolute one from `req.url` sent the user to the server's own listen address instead: behind a proxy
// Next resolves that to `localhost:4500`, so every SSO failure bounced the operator off the site
// entirely — and onto a URL that only exists inside the VM.
function errorRedirect(code: unknown): Response {
  return new Response(null, {
    status: 302,
    headers: { location: `/?sso_error=${encodeURIComponent(ssoErrorCode(code))}` },
  });
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
    return errorRedirect('sso_failed');
  }

  if (!upstream.ok) {
    let code: unknown;
    try { code = ((await upstream.json()) as { error?: unknown }).error; } catch { /* invalid daemon body */ }
    return errorRedirect(code);
  }

  let flowId: string;
  let authorizationUrl: string;
  try {
    ({ flowId, authorizationUrl } = (await upstream.json()) as { flowId: string; authorizationUrl: string });
    const destination = new URL(authorizationUrl);
    if (!flowId || destination.protocol !== 'https:') throw new Error('invalid SSO start response');
  } catch {
    return errorRedirect('sso_failed');
  }

  const responseHeaders = new Headers({ location: authorizationUrl });
  responseHeaders.append('set-cookie', namedCookie(SSO_FLOW_COOKIE, flowId, isHttps(req), SSO_FLOW_TTL_SECONDS));
  return new Response(null, { status: 302, headers: responseHeaders });
}
