/**
 * The single HTTP-forward core for reaching the Elowen REST API with a bearer token. Both the
 * `elowen api` CLI verb and every MCP tool delegate here, so the forward logic (headers, JSON parse,
 * error handling) lives in exactly one place — adding a new REST endpoint makes it work in both
 * with zero edits, and there is never any duplicated request logic to keep in sync.
 */
import type { Agent } from 'undici';

export interface CallOpts {
  url: string; token: string;
  /** Wait as long as the daemon takes, instead of undici's 300 s default headersTimeout/bodyTimeout
   *  (undici's Client defaults both to `300e3`). Set by the two operator escape hatches — the
   *  `elowen api` verb and the MCP `elowen_request` tool — because the routes they exist for,
   *  `/brain/compact` and friends, legitimately go minutes without sending a byte.
   *
   *  The ceiling removed here is that 300 s idle timeout and nothing else. The commits that
   *  introduced this (d12ce30e, 705f4b9c) blamed a request "the daemon answered in 62 s", which
   *  cannot trip a 300 s idle timer and is not supported by anything: the daemon logs no inbound
   *  request lines, so no record of that response exists. No proxy is involved either — these calls
   *  go straight to the daemon port, and the installed vhosts read for 3600 s anyway
   *  (`src/cli/install/proxy.ts`). */
  noTimeout?: boolean;
}
export interface CallResult { status: number; ok: boolean; data: unknown; text: string }

let noTimeoutAgent: Agent | undefined;

/** The no-timeout request. Node's global fetch ignores a `dispatcher` from the npm undici package (a
 *  100 ms headersTimeout agent let an 800 ms response through untouched) while the package's own
 *  fetch honours it, so this path fetches through undici with an agent whose timeouts are 0 — undici
 *  reads 0 as "no timeout". The import is dynamic and reached only here: `elowen status` and
 *  `elowen --version` load this module and must not pay for undici. */
async function fetchWithoutTimeout(url: string, init: RequestInit): Promise<Response> {
  const { Agent: UndiciAgent, fetch: undiciFetch } = await import('undici');
  noTimeoutAgent ??= new UndiciAgent({ headersTimeout: 0, bodyTimeout: 0 });
  return await undiciFetch(url, { ...init, dispatcher: noTimeoutAgent } as never) as unknown as Response;
}

export async function callElowenApi(method: string, path: string, body: unknown | undefined, opts: CallOpts): Promise<CallResult> {
  const m = method.toUpperCase();
  const headers: Record<string, string> = { authorization: `Bearer ${opts.token}` };
  const hasBody = body !== undefined && m !== 'GET' && m !== 'HEAD';
  if (hasBody) headers['content-type'] = 'application/json';
  const url = `${opts.url}${path.startsWith('/') ? path : `/${path}`}`;
  const init: RequestInit = { method: m, headers, body: hasBody ? JSON.stringify(body) : undefined };
  const res = opts.noTimeout ? await fetchWithoutTimeout(url, init) : await fetch(url, init);
  const text = await res.text();
  let data: unknown;
  // External/daemon response — parse defensively so a non-JSON body never throws here.
  try { data = text ? JSON.parse(text) : undefined; } catch { data = undefined; }
  return { status: res.status, ok: res.ok, data, text };
}
