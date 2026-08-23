import { daemonUrl, forwardHeaders, requireSameOrigin, jsonError, tokenFromCookie, clearCookie, isHttps } from '../../../lib/proxy';

// Catch-all BFF proxy: every browser REST/SSE call hits this same-origin route, which reads the
// httpOnly session cookie, injects it as a daemon bearer token server-side, and streams the response
// straight back (SSE frames included). The token never reaches browser JS.
type Ctx = { params: Promise<{ path: string[] }> };

const MUTATING = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

/** Reject path segments that could traverse out of the intended daemon route (`.`, `..`, empty, or
 *  a segment carrying a slash/backslash/NUL via percent-encoding). The host is already pinned by
 *  daemonUrl(), so this only guards against in-daemon traversal. */
function safeSegments(path: string[]): boolean {
  return path.every((seg) => seg !== '' && seg !== '.' && seg !== '..' && !/[/\\\0]/.test(seg));
}

async function proxy(req: Request, ctx: Ctx): Promise<Response> {
  if (MUTATING.has(req.method)) {
    const blocked = requireSameOrigin(req);
    if (blocked) return blocked;
  }
  const token = tokenFromCookie(req);
  const { path } = await ctx.params;
  if (!safeSegments(path)) return jsonError('bad_request', 400);
  const search = new URL(req.url).search;
  const headers = forwardHeaders(req);
  // With a session cookie, inject it as the daemon bearer. Without one, forward tokenless and let the
  // daemon's own global auth guard decide: it 401s every protected route unless the install is fresh
  // (no users yet), which is exactly what keeps first-run onboarding — GET /setup, then creating the
  // first admin — reachable through this proxy before any session cookie can exist.
  if (token) headers.set('authorization', `Bearer ${token}`);
  const upstream = await fetch(`${daemonUrl()}/${path.join('/')}${search}`, {
    method: req.method,
    headers,
    // STREAM the body through rather than reading it into memory. It must not be req.text() — decoding
    // a binary upload as UTF-8 mangles it — but it must not be arrayBuffer() either: that holds the
    // whole request in this process's heap, which is fine for a JSON patch and ruinous for a file
    // upload, whose entire point is that it is not bounded by what fits in a message. Passing the body
    // stream keeps both cases binary-exact at constant memory.
    body: MUTATING.has(req.method) ? req.body : undefined,
    // Required by undici whenever the body is a stream: we are not reading the response before we
    // finish sending the request, which is the "half duplex" case.
    duplex: 'half',
  } as RequestInit & { duplex: 'half' });
  const resHeaders = new Headers(upstream.headers);
  // Never relay a daemon-set cookie to the browser; the proxy is the sole owner of the session cookie.
  resHeaders.delete('set-cookie');
  // A daemon 401 on a request we DID authenticate means the session token is stale/revoked — expire the
  // cookie so the gate logs out. A tokenless 401 (a protected route on an already-set-up install) has no
  // cookie to clear, and must not manufacture a logout during the pre-cookie onboarding window.
  if (upstream.status === 401 && token) resHeaders.append('set-cookie', clearCookie(isHttps(req)));
  return new Response(upstream.body, { status: upstream.status, headers: resHeaders });
}

export const GET = (req: Request, ctx: Ctx) => proxy(req, ctx);
export const POST = (req: Request, ctx: Ctx) => proxy(req, ctx);
export const PATCH = (req: Request, ctx: Ctx) => proxy(req, ctx);
export const PUT = (req: Request, ctx: Ctx) => proxy(req, ctx);
export const DELETE = (req: Request, ctx: Ctx) => proxy(req, ctx);
