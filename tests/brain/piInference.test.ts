import { describe, it, expect } from 'vitest';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { piInferenceClient } from '../../src/brain/piInference.js';
import { inMemoryModelRuntime, type BrainRuntimeConfig } from '../../src/brain/providers.js';

/** The background one-shot adapter over the brain's own provider stack — the piece that lets the
 *  dashboard digest run on OAuth accounts. Resolution is tested against a REAL credential-less
 *  ModelRuntime (fakes of the registry surface would drift); only the network call is stubbed. */

const CFG: BrainRuntimeConfig = {
  providers: [{
    id: 'relay', label: 'Relay', type: 'openai', baseUrl: 'https://relay.example/v1',
    models: ['test-model'], apiKey: 'sk-test',
  }],
};

const message = (over: Partial<AssistantMessage>): AssistantMessage => ({
  role: 'assistant', content: [], api: 'openai-completions', provider: 'p', model: 'm',
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  stopReason: 'stop', timestamp: 0, ...over,
});

async function client(over: { route?: { providerId: string; model: string } | null; reply?: AssistantMessage }) {
  const runtime = await inMemoryModelRuntime();
  if (over.reply) {
    (runtime as unknown as { completeSimple: () => Promise<AssistantMessage> }).completeSimple =
      () => Promise.resolve(over.reply!);
  }
  return piInferenceClient({
    runtime,
    config: () => CFG,
    route: () => (over.route === undefined ? { providerId: 'relay', model: 'test-model' } : over.route),
  });
}

describe('piInferenceClient resolution', () => {
  it('returns null without a route, and for a provider the config does not carry', async () => {
    expect(await client({ route: null })).toBeNull();
    expect(await client({ route: { providerId: 'ghost', model: 'x' } })).toBeNull();
  });

  it('resolves a configured custom endpoint to a working client', async () => {
    const c = await client({});
    expect(c).not.toBeNull();
    expect(c!.model).toBe('relay/test-model');
  });
});

describe('piInferenceClient.decide', () => {
  it('returns only the text blocks — thinking is dropped', async () => {
    const c = await client({
      reply: message({
        content: [
          { type: 'thinking', thinking: 'pondering…', thinkingSignature: '' },
          { type: 'text', text: '{"greeting":"Čau"}' },
        ],
      }),
    });
    expect((await c!.decide('prompt')).text).toBe('{"greeting":"Čau"}');
  });

  it.each(['error', 'aborted'] as const)('throws on a %s stop so the generator records failed', async (stopReason) => {
    const c = await client({ reply: message({ stopReason, errorMessage: 'boom' }) });
    await expect(c!.decide('prompt')).rejects.toThrow('boom');
  });
});
