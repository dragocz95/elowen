/**
 * The single HTTP-forward core for reaching the Elowen REST API with a bearer token. Both the
 * `elowen api` CLI verb and every MCP tool delegate here, so the forward logic (headers, JSON parse,
 * error handling) lives in exactly one place — adding a new REST endpoint makes it work in both
 * with zero edits, and there is never any duplicated request logic to keep in sync.
 */
export interface CallOpts {
  url: string; token: string; fetchImpl?: typeof fetch;
  /** Opt-in undici Dispatcher for this request. Only `elowen api` passes one (see
   *  `src/cli/noTimeoutDispatcher.ts`); every other caller keeps Node's default 300 s timeouts. */
  dispatcher?: unknown;
}
export interface CallResult { status: number; ok: boolean; data: unknown; text: string }

export async function callElowenApi(method: string, path: string, body: unknown | undefined, opts: CallOpts): Promise<CallResult> {
  const f = opts.fetchImpl ?? fetch;
  const m = method.toUpperCase();
  const headers: Record<string, string> = { authorization: `Bearer ${opts.token}` };
  const hasBody = body !== undefined && m !== 'GET' && m !== 'HEAD';
  if (hasBody) headers['content-type'] = 'application/json';
  const res = await f(`${opts.url}${path.startsWith('/') ? path : `/${path}`}`, {
    method: m,
    headers,
    body: hasBody ? JSON.stringify(body) : undefined,
    ...(opts.dispatcher ? { dispatcher: opts.dispatcher } : {}),
  } as RequestInit);
  const text = await res.text();
  let data: unknown;
  // External/daemon response — parse defensively so a non-JSON body never throws here.
  try { data = text ? JSON.parse(text) : undefined; } catch { data = undefined; }
  return { status: res.status, ok: res.ok, data, text };
}
