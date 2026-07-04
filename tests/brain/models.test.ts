import { describe, it, expect, beforeEach, vi } from 'vitest';
import { listBrainModels, clearModelsCache } from '../../src/brain/models.js';
import type { BrainRuntimeConfig } from '../../src/brain/providers.js';

const openaiProvider = (models: string[] = []) => ({
  id: 'relay', label: 'Relay', type: 'openai' as const, baseUrl: 'https://ai.example/v1', models, apiKey: 'k',
});

describe('listBrainModels', () => {
  beforeEach(clearModelsCache);

  it('uses the manual model list when set (no fetch)', async () => {
    const f = vi.fn() as unknown as typeof fetch;
    const cfg: BrainRuntimeConfig = { providers: [openaiProvider(['a', 'b'])] };
    expect(await listBrainModels(cfg, f)).toEqual([
      { provider: 'relay', providerLabel: 'Relay', model: 'a', source: 'api-key' },
      { provider: 'relay', providerLabel: 'Relay', model: 'b', source: 'api-key' },
    ]);
    expect(f).not.toHaveBeenCalled();
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
