import { describe, it, expect, beforeEach, vi } from 'vitest';
import { listBrainModels, clearModelsCache } from '../../src/brain/models.js';
import type { BrainRuntimeConfig } from '../../src/brain/providers.js';

const openaiProvider = (models: string[] = []) => ({
  id: 'relay', label: 'Relay', type: 'openai' as const, baseUrl: 'https://ai.example/v1', models, apiKey: 'k',
});

describe('listBrainModels', () => {
  beforeEach(clearModelsCache);

  it('keeps the manual model list for WHICH models appear, enriching context from /models', async () => {
    // The manual list decides which models exist; the /models fetch only enriches with context windows.
    const f = vi.fn(async () => new Response(JSON.stringify({ data: [{ id: 'a', context_length: 32000 }] }), { status: 200 })) as unknown as typeof fetch;
    const cfg: BrainRuntimeConfig = { providers: [openaiProvider(['a', 'b'])] };
    const models = await listBrainModels(cfg, f);
    expect(models.map((m) => m.model)).toEqual(['a', 'b']); // manual list wins on which models appear
    expect(models.find((m) => m.model === 'a')!.contextWindow).toBe(32000); // provider-reported enrichment
    expect(models.find((m) => m.model === 'a')!.contextWindowSet).toBe(false); // reported ≠ operator override
    expect(models.find((m) => m.model === 'b')!.contextWindow).toBe(200000); // default when not reported
  });

  it('an operator override wins over the provider-reported context window', async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ data: [{ id: 'a', context_length: 32000 }] }), { status: 200 })) as unknown as typeof fetch;
    const cfg: BrainRuntimeConfig = { providers: [openaiProvider(['a'])], contextWindows: { 'relay/a': 8000 } };
    const models = await listBrainModels(cfg, f);
    expect(models[0]!.contextWindow).toBe(8000);
    expect(models[0]!.contextWindowSet).toBe(true);
  });

  it('auto-fetches /models for an openai provider with no manual list', async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ data: [{ id: 'z' }, { id: 'a' }] }), { status: 200 })) as unknown as typeof fetch;
    const cfg: BrainRuntimeConfig = { providers: [openaiProvider()] };
    const models = await listBrainModels(cfg, f);
    expect(models.map((m) => m.model)).toEqual(['a', 'z']); // sorted
    expect(f).toHaveBeenCalledWith('https://ai.example/v1/models', expect.objectContaining({
      headers: expect.objectContaining({ authorization: 'Bearer k', 'x-title': 'Orca' }),
    }));
  });

  it('surfaces OpenRouter :free variants as a FREE section even with a manual paid list', async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ data: [{ id: 'paid-model' }, { id: 'x/y:free', context_length: 64000 }, { id: 'a/b:free' }] }), { status: 200 })) as unknown as typeof fetch;
    const cfg: BrainRuntimeConfig = { providers: [{ id: 'or', label: 'OpenRouter', type: 'openai', baseUrl: 'https://openrouter.ai/api/v1', models: ['paid-model'], apiKey: 'k' }] };
    const models = await listBrainModels(cfg, f);
    expect(models.map((m) => m.model)).toEqual(['paid-model', 'a/b:free', 'x/y:free']);
    expect(models.filter((m) => m.free).map((m) => m.model)).toEqual(['a/b:free', 'x/y:free']);
    expect(models.find((m) => m.model === 'x/y:free')!.contextWindow).toBe(64000);
    // Non-OpenRouter endpoints never grow a FREE section, even if a model id happens to end in :free.
    const f2 = vi.fn(async () => new Response(JSON.stringify({ data: [{ id: 'a/b:free' }] }), { status: 200 })) as unknown as typeof fetch;
    const other = await listBrainModels({ providers: [openaiProvider(['m'])] }, f2);
    expect(other.some((m) => m.free)).toBe(false);
  });

  it('caches the fetch briefly', async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ data: [{ id: 'a' }] }), { status: 200 })) as unknown as typeof fetch;
    const cfg: BrainRuntimeConfig = { providers: [openaiProvider()] };
    await listBrainModels(cfg, f);
    await listBrainModels(cfg, f);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('degrades to empty on upstream failure', async () => {
    const f = vi.fn(async () => new Response('nope', { status: 500 })) as unknown as typeof fetch;
    const cfg: BrainRuntimeConfig = { providers: [openaiProvider()] };
    expect(await listBrainModels(cfg, f)).toEqual([]);
  });

  it('lists the built-in catalog for an oauth provider', async () => {
    const f = vi.fn() as unknown as typeof fetch;
    const cfg: BrainRuntimeConfig = {
      providers: [{ id: 'claude', label: 'Claude účet', type: 'oauth-anthropic', baseUrl: '', models: [], apiKey: null }],
    };
    const models = await listBrainModels(cfg, f);
    expect(models.length).toBeGreaterThan(0);
    expect(models.every((m) => m.provider === 'claude')).toBe(true);
  });

  it('propagates the provider origin as the model source', async () => {
    const f = vi.fn() as unknown as typeof fetch;
    const cfg: BrainRuntimeConfig = { providers: [
      { ...openaiProvider(['m']), origin: 'oauth' as const },
      { ...openaiProvider(['n']), id: 'r2', origin: 'relay' as const },
    ] };
    expect((await listBrainModels(cfg, f)).map((m) => m.source)).toEqual(['oauth', 'relay']);
  });
});
