import { describe, it, expect, beforeEach, vi } from 'vitest';
import { listBrainModels, clearModelsCache } from '../../src/brain/models.js';
import type { BrainRuntimeConfig } from '../../src/brain/providers.js';
import { OPENAI_CODEX_IMAGE_MODELS } from '../../src/brain/imageService.js';

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
    expect(models.find((m) => m.model === 'a')!.default).toBe(true);
    expect(models.find((m) => m.model === 'b')!.default).toBeUndefined();
  });

  // The vision fallback picker filters on this flag, and it filters TRI-STATE: an ABSENT field means "the
  // catalog has no row", which must stay selectable. Publishing `false` for an uncatalogued model would
  // hide every model the catalog simply does not describe from a picker that can use it perfectly well.
  it('publishes the catalog vision verdict, and omits the field entirely when there is no row', async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ data: [
      { id: 'gpt-4o' }, { id: 'gpt-3.5-turbo' }, { id: 'totally-unknown-model' },
    ] }), { status: 200 })) as unknown as typeof fetch;
    const cfg: BrainRuntimeConfig = { providers: [{ id: 'openai', label: 'OpenAI', type: 'openai', baseUrl: 'https://api.openai.com/v1', models: [], apiKey: 'k' }] };
    const models = await listBrainModels(cfg, f);
    expect(models.find((m) => m.model === 'gpt-4o')!.vision).toBe(true);
    expect(models.find((m) => m.model === 'gpt-3.5-turbo')!.vision).toBe(false);
    expect(models.find((m) => m.model === 'totally-unknown-model')).not.toHaveProperty('vision');
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
      headers: expect.objectContaining({ authorization: 'Bearer k', 'x-title': 'Elowen' }),
    }));
  });

  it('enriches dynamically discovered known families with reasoning modes and labels', async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ data: [
      { id: 'openai/gpt-5.6-sol' }, { id: 'plain/chat-model' },
    ] }), { status: 200 })) as unknown as typeof fetch;
    const cfg: BrainRuntimeConfig = { providers: [openaiProvider()] };
    const models = await listBrainModels(cfg, f);
    expect(models.find((m) => m.model === 'openai/gpt-5.6-sol')).toMatchObject({
      reasoningLevels: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
      reasoningLabels: { minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', xhigh: 'ultra', max: 'max' },
    });
    expect(models.find((m) => m.model === 'plain/chat-model')?.reasoningLevels).toBeUndefined();
  });

  it('drops OpenRouter :free variants from the auto-discovered catalog', async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ data: [{ id: 'paid-model' }, { id: 'x/y:free', context_length: 64000 }, { id: 'a/b:free' }] }), { status: 200 })) as unknown as typeof fetch;
    // Empty manual list → the endpoint's catalog is auto-discovered; the zero-cost :free variants are excluded.
    const cfg: BrainRuntimeConfig = { providers: [{ id: 'or', label: 'OpenRouter', type: 'openai', baseUrl: 'https://openrouter.ai/api/v1', models: [], apiKey: 'k' }] };
    const models = await listBrainModels(cfg, f);
    expect(models.map((m) => m.model)).toEqual(['paid-model']);
    expect(models.some((m) => m.model.endsWith(':free'))).toBe(false);
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
    expect(models.filter((m) => m.default).map((m) => m.model)).toEqual(['claude-opus-5']);
  });

  // Opus 5 and Fable 5.1 are native PI catalog models since 0.85.1; Elowen used to clone them from the
  // previous tier. They are the Claude account's working models, so the list must keep offering both with a
  // real reasoning ladder and the catalog's own context window, alongside the rest of the native catalog.
  it('offers Opus 5 and Fable 5.1 on the Claude account with their catalog reasoning ladders', async () => {
    const f = vi.fn() as unknown as typeof fetch;
    const cfg: BrainRuntimeConfig = {
      providers: [{ id: 'claude', label: 'Claude account', type: 'oauth-anthropic', baseUrl: '', models: [], apiKey: null }],
    };
    const models = await listBrainModels(cfg, f);
    const opus5 = models.find((m) => m.model === 'claude-opus-5');
    const fable51 = models.find((m) => m.model === 'claude-fable-5-1');
    expect(opus5).toBeDefined();
    expect(fable51).toBeDefined();
    for (const model of [opus5!, fable51!]) {
      expect(model.reasoningLevels).toEqual(expect.arrayContaining(['high', 'max']));
      expect(model.contextWindow).toBe(1_000_000);
    }
    expect(models.map((m) => m.model)).toEqual(expect.arrayContaining([
      'claude-opus-4-8', 'claude-sonnet-5', 'claude-fable-5', 'claude-fable-5-1', 'claude-haiku-4-5',
    ]));
  });

  it('offers the complete OAuth account catalog when nothing is selected', async () => {
    const f = vi.fn() as unknown as typeof fetch;
    const cfg: BrainRuntimeConfig = {
      providers: [{ id: 'openai', label: 'OpenAI account', type: 'oauth-openai-codex', baseUrl: '', models: [], apiKey: null }],
    };
    const ids = (await listBrainModels(cfg, f)).map((model) => model.model);
    expect(ids).toEqual(expect.arrayContaining([
      'gpt-5.3-codex-spark', 'gpt-5.5', 'gpt-5.6-luna',
      'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-6-astra',
    ]));
  });

  // The account's image models answer on `codex/images/*`, not on the Responses API. They are still
  // models of the account and enable through the same allowlist, so they belong in this list — marked
  // `kind: 'image'`, which is what keeps every chat picker and model role from offering them.
  it('lists the account image models as image models, apart from the chat ones', async () => {
    const f = vi.fn() as unknown as typeof fetch;
    const cfg: BrainRuntimeConfig = {
      providers: [{ id: 'openai', label: 'OpenAI account', type: 'oauth-openai-codex', baseUrl: '', models: [], apiKey: null }],
    };
    const models = await listBrainModels(cfg, f);
    for (const image of OPENAI_CODEX_IMAGE_MODELS) {
      expect(models.find((m) => m.model === image)?.kind).toBe('image');
    }
    expect(models.find((m) => m.model === 'gpt-5.5')?.kind).toBeUndefined();
  });

  // The allowlist is ONE list: a ticked image model reaches the image plugins, an unticked one reaches
  // nothing — the same mechanism, and the same file, as for a chat model.
  it('honours the account selection for image models too', async () => {
    const f = vi.fn() as unknown as typeof fetch;
    const cfg: BrainRuntimeConfig = {
      providers: [{ id: 'openai', label: 'OpenAI account', type: 'oauth-openai-codex', baseUrl: '', models: ['gpt-5.5', 'gpt-image-2'], apiKey: null }],
    };
    const models = await listBrainModels(cfg, f);
    expect(models.map((m) => m.model)).toEqual(['gpt-5.5', 'gpt-image-2']);
    expect(models.find((m) => m.model === 'gpt-image-2')?.kind).toBe('image');
    expect(models.find((m) => m.model === 'gpt-5.5')?.kind).toBeUndefined();
  });

  // An API-key OpenAI endpoint gets no catalog of its own: its own /models answer already names the
  // image models, and they carry the same mark so the same picker can offer them.
  it('marks an API-key provider image model from its own catalog', async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ data: [{ id: 'gpt-image-1' }, { id: 'gpt-5.5' }] }), { status: 200 })) as unknown as typeof fetch;
    const cfg: BrainRuntimeConfig = {
      providers: [{ id: 'official', label: 'OpenAI', type: 'openai', baseUrl: 'https://api.openai.com/v1', models: [], apiKey: 'secret' }],
    };
    const models = await listBrainModels(cfg, f);
    expect(models.find((m) => m.model === 'gpt-image-1')?.kind).toBe('image');
    expect(models.find((m) => m.model === 'gpt-5.5')?.kind).toBeUndefined();
  });

  // An OAuth account's stored list is the operator's ALLOWLIST — the settings picker says so in as many
  // words ("pick which of this account's models Elowen offers"). It used to be appended to the full
  // catalog instead of replacing it, so every unticked model stayed on offer and the picker meant nothing.
  it('offers only the selected models when the account has a selection', async () => {
    const f = vi.fn() as unknown as typeof fetch;
    const cfg: BrainRuntimeConfig = {
      providers: [{ id: 'claude', label: 'Claude account', type: 'oauth-anthropic', baseUrl: '', models: ['claude-opus-5', 'claude-haiku-4-5'], apiKey: null }],
    };
    const ids = (await listBrainModels(cfg, f)).map((model) => model.model);
    expect(ids).toEqual(['claude-opus-5', 'claude-haiku-4-5']);
    expect(ids).not.toContain('claude-fable-5'); // in the account's catalog, but not ticked
  });

  // The selection narrows what is OFFERED, never what the account can resolve: a picked model still
  // carries the built-in descriptor's capabilities rather than degrading to the unknown-model fallback.
  it('keeps a selected model its native capabilities', async () => {
    const f = vi.fn() as unknown as typeof fetch;
    const cfg: BrainRuntimeConfig = {
      providers: [{ id: 'claude', label: 'Claude account', type: 'oauth-anthropic', baseUrl: '', models: ['claude-opus-5'], apiKey: null }],
    };
    const [only] = await listBrainModels(cfg, f);
    expect(only.model).toBe('claude-opus-5');
    expect(only.reasoningLevels?.length).toBeGreaterThan(0);
    expect(only.default).toBe(true);
  });

  it('propagates the provider origin as the model source', async () => {
    const f = vi.fn() as unknown as typeof fetch;
    const cfg: BrainRuntimeConfig = { providers: [
      { ...openaiProvider(['m']), origin: 'oauth' as const },
      { ...openaiProvider(['n']), id: 'r2', origin: 'relay' as const },
    ] };
    expect((await listBrainModels(cfg, f)).map((m) => m.source)).toEqual(['oauth', 'relay']);
  });

  it('publishes Fast availability from route capability without exposing credentials', async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 })) as unknown as typeof fetch;
    const cfg: BrainRuntimeConfig = { providers: [
      { id: 'official', label: 'OpenAI', type: 'openai', api: 'openai-responses', baseUrl: 'https://api.openai.com/v1', models: ['gpt-5.6-sol', 'gpt-5.5'], apiKey: 'secret' },
      { id: 'relay', label: 'Relay', type: 'openai', api: 'openai-responses', baseUrl: 'https://relay.example/v1', models: ['gpt-5.6-sol'], apiKey: 'other-secret' },
    ] };
    const models = await listBrainModels(cfg, f);
    expect(models.map(({ provider, model, fastAvailable }) => ({ provider, model, fastAvailable }))).toEqual([
      { provider: 'official', model: 'gpt-5.6-sol', fastAvailable: true },
      { provider: 'official', model: 'gpt-5.5', fastAvailable: undefined },
      { provider: 'relay', model: 'gpt-5.6-sol', fastAvailable: undefined },
    ]);
    expect(JSON.stringify(models)).not.toContain('secret');
  });
});
