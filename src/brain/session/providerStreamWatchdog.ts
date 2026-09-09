import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { Api, FetchFunction, Model } from '@earendil-works/pi-ai';
import { logger } from '../../shared/logger.js';

const log = logger('brain-provider');

/** How long a provider response body may deliver NOTHING before the request is aborted.
 *
 *  A streaming response that goes silent after its headers has no transport deadline anywhere below us:
 *  the socket stays ESTABLISHED, pi-ai waits on the next chunk forever, and the turn, its parent Delegate
 *  wait and the whole workflow stall until an operator kills the socket by hand (observed: 50 minutes on
 *  one chat request against a custom OpenAI-compatible endpoint).
 *
 *  120 s is chosen against what a HEALTHY silence looks like. Reasoning models can think for a long time
 *  before the first content token, but they do not do it silently: Anthropic sends `ping` events, OpenAI
 *  Responses sends periodic events and SSE comments, and every relay in between sends its own keep-alive
 *  comment lines to hold the connection open. The watchdog counts BYTES on the body, so an SSE comment or a
 *  `ping` event rearms it exactly like a content delta does. Two minutes without a single byte therefore
 *  means the connection is dead, not that the model is thinking.
 *
 *  This is deliberately NOT a request timeout: the timer only runs while a read on the body is outstanding,
 *  so a non-streaming call that legitimately takes minutes before its headers arrive is untouched. */
export const PROVIDER_STREAM_IDLE_MS = 120_000;

/** pi's retry classification (`isRetryableAssistantError`) matches on the error TEXT; "timeout" is one of
 *  its retryable patterns, so this wording is what routes the failure into pi's existing auto-retry. */
const idleMessage = (): string =>
  `provider stream idle timeout: no data for ${Math.round(PROVIDER_STREAM_IDLE_MS / 1000)}s`;

function callerSignal(input: Parameters<FetchFunction>[0], init: Parameters<FetchFunction>[1]): AbortSignal | undefined {
  return init?.signal ?? (input instanceof Request ? input.signal : undefined);
}

/** Wrap one fetch so the response body is read under an idle deadline. */
function withIdleWatchdog(base: FetchFunction): FetchFunction {
  return async (input, init) => {
    const controller = new AbortController();
    const caller = callerSignal(input, init);
    const forward = () => controller.abort(caller?.reason);
    if (caller?.aborted) forward();
    else caller?.addEventListener('abort', forward, { once: true });
    const response = await base(input, { ...init, signal: controller.signal });
    if (!response.body) return response;

    const reader = response.body.getReader();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let idle = false;
    const clear = () => { if (timer !== undefined) { clearTimeout(timer); timer = undefined; } };
    const guarded = new ReadableStream<Uint8Array>({
      async pull(out) {
        // Armed only around an outstanding read: a consumer that stops pulling (backpressure) is not
        // provider silence, and a stream that keeps delivering rearms on every chunk.
        timer = setTimeout(() => {
          idle = true;
          const error = new Error(idleMessage());
          log.warn(`${error.message} — aborting the request`);
          // Abort releases the socket; failing the stream here is what the reader actually observes, so
          // the request fails on its own rather than waiting for the transport to honour the abort.
          controller.abort(error);
          out.error(error);
          void reader.cancel(error).catch(() => {});
        }, PROVIDER_STREAM_IDLE_MS);
        try {
          const { done, value } = await reader.read();
          clear();
          if (idle) return;
          if (done) out.close();
          else out.enqueue(value);
        } catch (error) {
          clear();
          if (!idle) out.error(error);
        }
      },
      cancel(reason) {
        clear();
        return reader.cancel(reason);
      },
    });
    return new Response(guarded, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}

/**
 * Session-local runtime wrapper that bounds provider STREAMS: it installs the idle watchdog on the fetch
 * every provider call ends up using, so a body that goes silent fails the request instead of hanging it.
 * The failure surfaces as an ordinary stream error, which means pi's own retry path and Elowen's provider
 * request recorder both see a normal terminal event and the attempt row is finalized rather than left
 * `pending`.
 */
export function guardProviderStreamIdle(runtime: ModelRuntime): ModelRuntime {
  return new Proxy(runtime, {
    get(target, property, receiver) {
      if (property !== 'streamSimple') {
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      }
      return (
        model: Model<Api>,
        context: Parameters<ModelRuntime['streamSimple']>[1],
        options: Parameters<ModelRuntime['streamSimple']>[2],
      ) => target.streamSimple(model, context, {
        ...options,
        fetch: withIdleWatchdog(options?.fetch ?? ((input, init) => globalThis.fetch(input, init))),
      });
    },
  });
}
