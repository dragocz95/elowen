import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { PluginHttpResponse } from '../../plugins/api.js';

/** Convert the plugin contract's multi-value header map into a real Headers object. `Headers.append`
 * preserves duplicate Set-Cookie fields; passing a plain object would coerce an array into one comma-
 * joined cookie, which changes its semantics. */
export function pluginResponseHeaders(input: PluginHttpResponse['headers']): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(input ?? {})) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else {
      headers.set(name, value);
    }
  }
  return headers;
}

/** Statuses that carry no body by definition — `new Response(body, { status })` throws for these. */
const NO_BODY_STATUS = new Set([204, 205, 304]);

/** Tie a plugin's stream to the lifetime of the request that asked for it.
 *
 *  The Node HTTP writer already cancels a response body when the socket closes, but only once it has
 *  started writing: a client that disappears while the handler is still working leaves the source open,
 *  which for a file stream is a descriptor nobody will ever close. The request's abort signal closes it
 *  in that window too.
 *
 *  A read failure once the response is under way cannot become a status code any more, so it is logged
 *  here rather than vanishing. It is NOT turned into a clean end: the response is errored, and a client
 *  reading against the plugin's own content-length sees the answer come up short. (The Node HTTP writer
 *  reads the first chunks before it commits the headers, and swallows a failure in exactly that window
 *  — which is the other reason a large body should always state its content-length.) */
function requestScopedStream(
  source: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  onError: (error: unknown) => void,
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  const abort = (): void => { void reader.cancel(new Error('client disconnected')).catch(() => {}); };
  if (signal.aborted) abort();
  else signal.addEventListener('abort', abort, { once: true });
  const release = (): void => signal.removeEventListener('abort', abort);
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          release();
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch (error) {
        release();
        onError(error);
        controller.error(error);
      }
    },
    cancel(reason) {
      release();
      return reader.cancel(reason);
    },
  });
}

/** Map a plugin handler's response onto a real HTTP response — the ONE place both plugin surfaces
 *  (`/hooks/*` and the authenticated plugin API) decide what a body means, so they cannot drift.
 *
 *  A string or byte body is sent as it stands; anything else that is not a stream is JSON. A stream is
 *  passed through unbuffered, which is what lets a plugin serve a file larger than the daemon's heap. */
export function pluginResponse(
  res: PluginHttpResponse,
  ctx: { method: string; signal: AbortSignal; onStreamError: (error: unknown) => void },
): Response {
  const status = (res.status ?? 200) as ContentfulStatusCode;
  const headers = pluginResponseHeaders(res.headers);
  const body = res.body;
  if (body === undefined || typeof body === 'string') return new Response(body ?? '', { status, headers });
  if (body instanceof Uint8Array) {
    return new Response(body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer, { status, headers });
  }
  if (body instanceof ReadableStream) {
    // HEAD keeps the GET's status and headers — content-length included — and carries no body, so the
    // source is cancelled here rather than handed to a writer that must not write it. A status that
    // carries no body at all is the same case: the Response constructor rejects one, and the throw
    // would strand the plugin's open file with nobody left holding a handle to close it.
    if (ctx.method === 'HEAD' || NO_BODY_STATUS.has(status)) {
      void body.cancel().catch(() => {});
      return new Response(null, { status, headers });
    }
    return new Response(requestScopedStream(body as ReadableStream<Uint8Array>, ctx.signal, ctx.onStreamError), { status, headers });
  }
  if (!headers.has('content-type')) headers.set('content-type', 'application/json; charset=UTF-8');
  return new Response(JSON.stringify(body), { status, headers });
}
