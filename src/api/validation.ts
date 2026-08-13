import { ZodError, type ZodType } from 'zod';
import { bodyLimit } from 'hono/body-limit';
import type { Context, MiddlewareHandler } from 'hono';

/** Hard cap on a request body, enforced BEFORE anything reads it. Every body-reading path buffers the
 *  whole thing (`c.req.json()` here, `c.req.arrayBuffer()` in the webhook dispatcher) and a chunked
 *  request carries no `content-length` to pre-check, so a public endpoint without this lets one
 *  anonymous request stream the daemon out of memory. Used on the surfaces reachable WITHOUT a token
 *  (login, plugin webhooks) so JSON routes and webhooks are bounded the same way; everything else is
 *  answered 401 by the auth guard before a handler touches the body. */
export function bodyLimitBytes(maxSize: number): MiddlewareHandler {
  return bodyLimit({ maxSize, onError: (c) => c.json({ error: 'payload too large' }, 413) });
}

/** Read a request body into memory with a HARD cap, for a dispatcher that cannot be fronted by
 *  {@link bodyLimitBytes} middleware — the root plugin-API catch-all resolves its route from the live
 *  registry, so there is no path pattern to hang a middleware on that would not also cap every core
 *  route. Returns null when the body is (or claims to be) larger than the cap, so the caller answers
 *  413. Buffering first and measuring afterwards is what this replaces: the cap then bounds the ANSWER
 *  while the allocation is already made. `content-length` is checked before a byte is read; a chunked
 *  body with no such header is bounded by the running total, and the stream is cancelled the moment it
 *  crosses the cap. */
export async function readBoundedBody(c: Context, maxBytes: number): Promise<Buffer | null> {
  const declared = Number(c.req.header('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) return null;
  const body = c.req.raw.body;
  if (!body) return Buffer.alloc(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) { await reader.cancel(); return null; }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/** Parse and validate a JSON request body against a zod schema. A malformed/empty body throws a
 *  SyntaxError (which `onError` maps to a clean `invalid JSON body` 400), and a well-formed body of the
 *  wrong shape throws a {@link ZodError} (mapped to a 400 listing the offending fields). Single source
 *  of truth for request-body shape across the route families: handlers declare a schema and read typed
 *  fields, instead of hand-rolling `typeof` ladders. */
export async function parseBody<T>(c: Context, schema: ZodType<T>): Promise<T> {
  return schema.parse(await c.req.json());
}

/** Parse a query-string integer with a fallback and an optional clamp. The one place list endpoints read a
 *  `?limit`/`?days`/`?offset`: non-numeric or non-finite input (`?limit=abc`) falls back instead of reaching
 *  a store as `NaN`, a present value is floored and clamped to `[min, max]` when those are given. Pass a
 *  numeric `fallback` for "always a number", or `undefined` for "omit when absent/garbage". */
export function queryInt(raw: string | undefined, opts: { min?: number; max?: number; fallback: number }): number;
export function queryInt(raw: string | undefined, opts: { min?: number; max?: number; fallback?: undefined }): number | undefined;
export function queryInt(raw: string | undefined, opts: { min?: number; max?: number; fallback?: number }): number | undefined {
  if (raw === undefined || raw === '') return opts.fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return opts.fallback;
  let v = Math.floor(n);
  if (opts.min !== undefined) v = Math.max(opts.min, v);
  if (opts.max !== undefined) v = Math.min(opts.max, v);
  return v;
}

/** Flatten a {@link ZodError} into a short, human-readable `path: message; …` string for the 400 body. */
export function formatZodError(err: ZodError): string {
  return err.issues.map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message)).join('; ');
}
