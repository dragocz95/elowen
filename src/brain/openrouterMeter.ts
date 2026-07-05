import { AsyncLocalStorage } from 'node:async_hooks';
import { logger } from '../shared/logger.js';

const log = logger('openrouter-meter');

/** Accumulates the provider-reported cost of every OpenRouter completion made during one brain run.
 *  pi-ai's openai-completions client ignores OpenRouter's `usage.cost`, so we capture it ourselves at
 *  the fetch layer and stash it here, keyed to the current run via AsyncLocalStorage. */
export interface CostMeter {
  /** Sum of the provider-reported `usage.cost` across all completions in the run (USD credits). */
  costUsd: number;
  currency: string | null;
  /** True once at least one completion returned a numeric `usage.cost`. */
  reported: boolean;
  /** The last provider `usage` object seen (tokens + cost only — no prompt/response content). */
  raw?: Record<string, unknown>;
}

export function newCostMeter(): CostMeter {
  return { costUsd: 0, currency: null, reported: false };
}

const meterStore = new AsyncLocalStorage<CostMeter>();

/** Run `fn` with `meter` as the ambient cost accumulator. Any OpenRouter completion issued during the
 *  awaited work (pi-ai calls the global fetch, which propagates this async context) folds its reported
 *  cost into `meter`. */
export function runWithMeter<T>(meter: CostMeter, fn: () => Promise<T>): Promise<T> {
  return meterStore.run(meter, fn);
}

function isOpenRouterCompletions(url: string, method: string): boolean {
  if (method.toUpperCase() !== 'POST') return false;
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    return (host === 'openrouter.ai' || host.endsWith('.openrouter.ai')) && u.pathname.includes('/chat/completions');
  } catch { return false; }
}

/** Add OpenRouter's usage-accounting flag to a JSON request body so the response includes `usage.cost`.
 *  Returns the (possibly rewritten) body, or the original untouched on any parse issue. */
function withUsageAccounting(body: unknown): unknown {
  if (typeof body !== 'string') return body; // only the SDK's JSON string body is rewritten
  try {
    const obj = JSON.parse(body) as Record<string, unknown>;
    const existing = (obj.usage && typeof obj.usage === 'object') ? obj.usage as Record<string, unknown> : {};
    obj.usage = { ...existing, include: true };
    return JSON.stringify(obj);
  } catch { return body; }
}

/** Wrap a streamed SSE response so it passes through byte-for-byte while sniffing each `data:` frame
 *  for the final `usage.cost`, folding it into `meter`. Never alters or blocks the stream. */
function meterStream(res: Response, meter: CostMeter): Response {
  if (!res.body) return res;
  const decoder = new TextDecoder();
  let buf = '';
  const sniff = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      controller.enqueue(chunk); // pass-through FIRST — the sniff must never affect what pi-ai reads
      try {
        buf += decoder.decode(chunk, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === '[DONE]') continue;
          const obj = JSON.parse(payload) as { usage?: { cost?: unknown } };
          const cost = obj.usage?.cost;
          if (typeof cost === 'number' && Number.isFinite(cost)) {
            meter.costUsd += cost;
            meter.reported = true;
            meter.currency = 'USD';
            meter.raw = obj.usage as Record<string, unknown>;
          }
        }
      } catch { /* best-effort sniff — a partial/odd frame must not break the response */ }
    },
  });
  // Re-wrap without content-encoding/length: the body is already the decoded SSE stream.
  const headers = new Headers(res.headers);
  headers.delete('content-encoding');
  headers.delete('content-length');
  return new Response(res.body.pipeThrough(sniff), { status: res.status, statusText: res.statusText, headers });
}

/** Wrap a base fetch so OpenRouter chat-completions POSTs get the usage-accounting flag and have their
 *  reported cost metered into the ambient CostMeter; every other request passes straight through. Pure
 *  (no global mutation) so it's directly unit-testable. */
export function createMeteredFetch(base: typeof fetch): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    // Decide + rewrite BEFORE the fetch. Any failure here (never expected) degrades to a plain pass-through
    // WITHOUT having sent the request yet, so base() is still called exactly once below.
    let nextInit = init;
    let meterIt = false;
    try {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
      if (isOpenRouterCompletions(url, method)) {
        meterIt = true;
        // Only rewrite the plain (url, init) shape pi-ai's SDK uses; a Request-object body is left as-is.
        if (init && typeof init.body === 'string') nextInit = { ...init, body: withUsageAccounting(init.body) as string };
      }
    } catch (e) {
      log.error('openrouter meter wrapper setup failed, falling back to plain fetch', e);
      nextInit = init; meterIt = false;
    }
    // base() runs ONCE. A fetch rejection must propagate (pi-ai owns retries) — never re-issue the request
    // here, or a dropped connection would silently double-send a chat-completions POST (double model cost).
    const res = await base(input as never, nextInit);
    if (!meterIt) return res;
    const meter = meterStore.getStore();
    if (!meter) return res; // no active run to attribute to — pass through (accounting flag still set)
    try { return meterStream(res, meter); } catch (e) { log.error('openrouter meter stream tee failed, passing raw response', e); return res; }
  }) as typeof fetch;
}

let installed = false;

/** Install the global-fetch wrapper (idempotent). Safe to call from provider setup before any brain
 *  request; every non-OpenRouter request is untouched. */
export function installOpenRouterMeter(): void {
  if (installed) return;
  installed = true;
  globalThis.fetch = createMeteredFetch(globalThis.fetch.bind(globalThis));
  log.info('installed OpenRouter cost meter (global fetch wrapper)');
}
