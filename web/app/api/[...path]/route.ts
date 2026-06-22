import { daemonUrl, forwardHeaders, isSameOrigin, clearCookie, isHttps, COOKIE_NAME } from '../../../lib/proxy';

// Catch-all BFF proxy: every browser REST/SSE call hits this same-origin route, which reads the
// httpOnly session cookie, injects it as a daemon bearer token server-side, and streams the response
// straight back (SSE frames included). The token never reaches browser JS.
type Ctx = { params: Promise<{ path: string[] }> };

function tokenFrom(req: Request): string | null {
  const m = (req.headers.get('cookie') ?? '').match(new RegExp(`${COOKIE_NAME}=([^;]+)`));
  return m ? m[1] : null;
}

const MUTATING = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

/** Reject path segments that could traverse out of the intended daemon route (`.`, `..`, empty, or
 *  a segment carrying a slash/backslash/NUL via percent-encoding). The host is already pinned by
 *  daemonUrl(), so this only guards against in-daemon traversal. */
function safeSegments(path: string[]): boolean {
  return path.every((seg) => seg !== '' && seg !== '.' && seg !== '..' && !/[/\\\0]/.test(seg));
}

async function proxy(req: Request, ctx: Ctx): Promise<Response> {
  if (MUTATING.has(req.method) && !isSameOrigin(req)) {
    return new Response(JSON.stringify({ error: 'forbidden' }), { status: 403, headers: { 'content-type': 'application/json' } });
  }
  const token = tokenFrom(req);
  if (!token) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: { 'content-type': 'application/json' } });
  }
  const { path } = await ctx.params;
  if (!safeSegments(path)) {
    return new Response(JSON.stringify({ error: 'bad_request' }), { status: 400, headers: { 'content-type': 'application/json' } });
  }
  const search = new URL(req.url).search;
  const headers = forwardHeaders(req);
  headers.set('authorization', `Bearer ${token}`);
  const upstream = await fetch(`${daemonUrl()}/${path.join('/')}${search}`, {
    method: req.method,
    headers,
    body: MUTATING.has(req.method) ? await req.text() : undefined,
  });
  const resHeaders = new Headers(upstream.headers);
  // Never relay a daemon-set cookie to the browser; the proxy is the sole owner of the session cookie.
  resHeaders.delete('set-cookie');
  // A daemon 401 means the session token is stale/revoked — expire the cookie so the gate logs out.
  if (upstream.status === 401) resHeaders.append('set-cookie', clearCookie(isHttps(req)));
  return new Response(upstream.body, { status: upstream.status, headers: resHeaders });
}

export const GET = (req: Request, ctx: Ctx) => proxy(req, ctx);
export const POST = (req: Request, ctx: Ctx) => proxy(req, ctx);
export const PATCH = (req: Request, ctx: Ctx) => proxy(req, ctx);
export const PUT = (req: Request, ctx: Ctx) => proxy(req, ctx);
export const DELETE = (req: Request, ctx: Ctx) => proxy(req, ctx);
