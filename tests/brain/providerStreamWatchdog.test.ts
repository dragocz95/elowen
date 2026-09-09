import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ModelRegistry } from '@earendil-works/pi-coding-agent';
import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type Model,
} from '@earendil-works/pi-ai';
import { inMemoryModelRuntime } from '../../src/brain/providers.js';
import { ProviderRequestRecorder } from '../../src/brain/session/providerRequestRecorder.js';
import { guardProviderStreamIdle, PROVIDER_STREAM_IDLE_MS } from '../../src/brain/session/providerStreamWatchdog.js';
import { BrainStore } from '../../src/store/brainStore.js';
import { openDb } from '../../src/store/db.js';

/** A provider that answers headers and one chunk, then keeps the body open and silent — the production
 *  failure mode: an ESTABLISHED socket that never delivers another byte. `keepAlive` sends an SSE comment
 *  instead of falling silent, which a healthy thinking model does. */
function silentProviderFetch(options: { keepAliveEveryMs?: number } = {}): typeof globalThis.fetch {
  return () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'));
        if (options.keepAliveEveryMs) {
          setInterval(() => controller.enqueue(new TextEncoder().encode(': ping\n\n')), options.keepAliveEveryMs);
        }
      },
    });
    return Promise.resolve(new Response(body, { status: 200 }));
  };
}

function errorMessageOf(model: Model<Api>, message: string): AssistantMessage {
  return {
    role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id,
    usage: {
      input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'error', errorMessage: message, timestamp: Date.now(),
  };
}

/** Wire a fake provider that consumes the response body the way pi-ai's streaming clients do, wrapped in
 *  the same order production uses: the recorder outside, the watchdog inside. */
async function fixture(baseFetch: typeof globalThis.fetch) {
  const brain = new BrainStore(openDb(':memory:'));
  brain.createSession({ id: 's1', userId: 7, model: 'chat-model', provider: 'configured' });
  const runtime = await inMemoryModelRuntime();
  const registry = new ModelRegistry(runtime);
  const api = `stream-watchdog-${Math.random()}` as Api;
  let bytes = 0;
  registry.registerProvider('wire', {
    name: 'Watchdog provider', api, baseUrl: 'https://provider.invalid', apiKey: 'key',
    streamSimple: async (model, context, request = {}) => {
      await request.onPayload?.({ model: model.id, messages: context.messages }, model);
      const doFetch = request.fetch ?? globalThis.fetch;
      const response = await doFetch('https://provider.invalid/chat/completions', { method: 'POST' });
      await request.onResponse?.({ status: response.status, headers: {} } as never, model);
      const out = createAssistantMessageEventStream();
      void (async () => {
        try {
          const reader = response.body!.getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            bytes += value.length;
          }
          out.push({ type: 'done', reason: 'stop', message: errorMessageOf(model, 'unreachable') });
        } catch (error) {
          out.push({
            type: 'error', reason: 'error',
            error: errorMessageOf(model, error instanceof Error ? error.message : String(error)),
          });
        }
        out.end();
      })();
      return out;
    },
    models: [{
      id: 'chat-model', name: 'chat-model', reasoning: false, input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 2_000, maxTokens: 512,
    }],
  });
  const model = registry.find('wire', 'chat-model');
  if (!model) throw new Error('model missing');
  const recorder = new ProviderRequestRecorder({
    store: brain.providerRequests, sessionId: 's1', configuredProvider: 'configured', enabled: () => true,
  });
  const wrapped = recorder.wrapRuntime(guardProviderStreamIdle(runtime));
  const stream = wrapped.streamSimple(model, { systemPrompt: 'p', messages: [] }, { fetch: baseFetch });
  return { brain, stream, readBytes: () => bytes };
}

describe('provider stream idle watchdog', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('fails a stream that goes silent after its headers and finalizes the request row', async () => {
    const { brain, stream } = await fixture(silentProviderFetch());
    const events: string[] = [];
    const consumed = (async () => {
      for await (const event of stream) events.push(event.type);
    })();

    await vi.advanceTimersByTimeAsync(PROVIDER_STREAM_IDLE_MS - 1_000);
    expect(brain.providerRequests.latestPending('s1')).toBeTruthy();

    await vi.advanceTimersByTimeAsync(2_000);
    await consumed;

    expect(events).toEqual(['error']);
    const row = brain.providerRequests.rows('s1').at(-1)!;
    expect(row.status).toBe('error');
    expect(row.finished_at).not.toBeNull();
    expect(String(row.error_message)).toContain(`no data for ${PROVIDER_STREAM_IDLE_MS / 1000}s`);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps a stream alive while the provider still sends keep-alive bytes', async () => {
    const { brain, stream, readBytes } = await fixture(
      silentProviderFetch({ keepAliveEveryMs: PROVIDER_STREAM_IDLE_MS / 2 }),
    );
    const events: string[] = [];
    void (async () => {
      for await (const event of stream) events.push(event.type);
    })();

    await vi.advanceTimersByTimeAsync(PROVIDER_STREAM_IDLE_MS * 3);

    expect(events).toEqual([]);
    expect(readBytes()).toBeGreaterThan(45);
    expect(brain.providerRequests.latestPending('s1')).toBeTruthy();
  });
});
