/** The HTTP forward the plugin's tools reach the daemon REST API with — the same shape as the daemon's
 *  own src/shared/apiClient.ts (headers, defensive JSON parse, never throwing on a non-JSON body),
 *  copied because a plugin may not import daemon code at runtime. Kept deliberately identical so a tool
 *  moved out of the core produces byte-identical requests and error text. */
export interface CallOpts { url: string; token: string; fetchImpl?: typeof fetch }
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
  });
  const text = await res.text();
  let data: unknown;
  try { data = text ? JSON.parse(text) : undefined; } catch { data = undefined; }
  return { status: res.status, ok: res.ok, data, text };
}
