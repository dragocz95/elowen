import { describe, expect, it, vi } from 'vitest';
import { streamSimple } from '@earendil-works/pi-ai/api/openai-completions';
import type { Api, Model } from '@earendil-works/pi-ai';
import { buildBrainRegistry, inMemoryModelRuntime, type BrainRuntimeConfig } from '../../src/brain/providers.js';

// What the per-model max-output setting is FOR: the number the operator types in Settings → Models has to
// end up in the provider request body. Everything between the config map and the wire (the descriptor, the
// registry, pi-ai's buildBaseOptions and its context clamp) is exercised here against pi's real transport
// with a scripted fetch, so a change anywhere along that path fails this test instead of silently sending
// the old 8192 cap forever.
//
// `streamSimple` — NOT `stream` — is the seam the agent runs on: `stream` takes options.maxTokens verbatim
// and would send nothing at all, while `streamSimple` is what folds the descriptor's maxTokens into the
// request (pi-ai/dist/api/simple-options.js).
const sse = [
  'data: {"id":"1","object":"chat.completion.chunk","created":1,"model":"qwen3.6-35b-a3b","choices":[{"index":0,"delta":{"role":"assistant","content":"ok"},"finish_reason":null}]}\n\n',
  'data: {"id":"1","object":"chat.completion.chunk","created":1,"model":"qwen3.6-35b-a3b","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":2,"total_tokens":12}}\n\n',
  'data: [DONE]\n\n',
].join('');

const context = { messages: [{ role: 'user', content: [{ type: 'text', text: 'Say ok.' }] }], tools: [] };

async function capturedRequest(model: Model<Api>): Promise<Record<string, unknown>> {
  const fetch = vi.fn(async (_url: unknown, _init?: RequestInit) =>
    new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } }));
  const events = streamSimple(model, context as never, { apiKey: 'test-key', fetch: fetch as never } as never);
  for await (const event of events) {
    if (event.type === 'error') throw new Error(event.error.errorMessage ?? 'provider error');
  }
  expect(fetch).toHaveBeenCalledTimes(1);
  const body = fetch.mock.calls[0]![1]?.body;
  return JSON.parse(typeof body === 'string' ? body : new TextDecoder().decode(body as Uint8Array));
}

/** The owner's own case: one custom OpenAI-compatible endpoint serving one model. */
const qwen = async (contextWindow?: number, maxTokens?: number): Promise<Model<Api>> => {
  const cfg: BrainRuntimeConfig = {
    providers: [{
      id: 'custom', label: 'Custom', type: 'openai',
      baseUrl: 'https://relay.example.test/v1', models: ['qwen3.6-35b-a3b'], apiKey: 'cs-x',
    }],
    ...(contextWindow ? { contextWindows: { 'custom/qwen3.6-35b-a3b': contextWindow } } : {}),
    ...(maxTokens ? { maxOutputTokens: { 'custom/qwen3.6-35b-a3b': maxTokens } } : {}),
  };
  const model = buildBrainRegistry(cfg, await inMemoryModelRuntime()).find('elowen-custom', 'qwen3.6-35b-a3b');
  expect(model).toBeDefined();
  return model!;
};

describe('per-model max output tokens on the wire', () => {
  it('sends the instance default when the operator pinned nothing', async () => {
    const payload = await capturedRequest(await qwen());
    // A custom Chat Completions endpoint uses the compatibility baseline, which names this field.
    expect(payload.max_completion_tokens).toBe(8_192);
    expect(payload.max_tokens).toBeUndefined();
  });

  it('sends the operator-pinned cap for the pinned window', async () => {
    const payload = await capturedRequest(await qwen(262_144, 65_536));
    expect(payload.max_completion_tokens).toBe(65_536);
  });

  it('sends a cap the window can honour rather than the raw pin', async () => {
    // 32k window, 32k pin: the descriptor already clamps to window − input headroom, so what reaches the
    // endpoint is a budget it can actually serve.
    const payload = await capturedRequest(await qwen(32_000, 32_000));
    expect(payload.max_completion_tokens).toBe(32_000 - 8_192);
  });
});
