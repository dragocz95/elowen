import { describe, it, expect } from 'vitest';
import { buildBrainRegistry, resolveBrainModel, openAiApiFor } from '../../src/brain/providers.js';
import type { BrainRuntimeConfig } from '../../src/brain/providers.js';

const cfg: BrainRuntimeConfig = {
  providers: [
    { id: 'relay', label: 'Relay', type: 'openai', baseUrl: 'https://relay.example.test/v1', models: ['gpt-x', 'kimi'], apiKey: 'cs-x' },
    { id: 'ant', label: 'Anthropic', type: 'anthropic', baseUrl: '', models: ['claude-x'], apiKey: 'sk-ant' },
  ],
};

describe('brain providers', () => {
  it('resolves the first provider + first model by default', () => {
    const reg = buildBrainRegistry(cfg);
    const m = resolveBrainModel(reg, cfg);
    expect(m.id).toBe('gpt-x');
    expect(m.provider).toBe('orca-relay');
  });

  it('resolves an explicit provider + model selection', () => {
    const reg = buildBrainRegistry(cfg);
    expect(resolveBrainModel(reg, cfg, { provider: 'ant', model: 'claude-x' }).id).toBe('claude-x');
    expect(resolveBrainModel(reg, cfg, { provider: 'relay', model: 'kimi' }).id).toBe('kimi');
  });

  it('maps the thinking levels ollama-style backends reject (minimal→low, xhigh→high)', () => {
    // PI's session default is "minimal"; unmapped it goes out as reasoning_effort:"minimal" and e.g.
    // ollama 400s ("valid levels: low, medium, high") → the whole turn fails with an empty reply.
    const reg = buildBrainRegistry(cfg);
    const m = resolveBrainModel(reg, cfg, { provider: 'relay', model: 'kimi' }) as { thinkingLevelMap?: Record<string, string> };
    expect(m.thinkingLevelMap).toEqual({ minimal: 'low', xhigh: 'high' });
  });

  it('registers a hand-typed model id on the fly for a custom endpoint', () => {
    const reg = buildBrainRegistry(cfg);
    const m = resolveBrainModel(reg, cfg, { provider: 'relay', model: 'brand/new-model' });
    expect(m.id).toBe('brand/new-model');
    expect(m.provider).toBe('orca-relay');
  });

  it('keeps the /v1 segment in the openai base url (client appends /chat/completions)', () => {
    const reg = buildBrainRegistry(cfg);
    const m = resolveBrainModel(reg, cfg);
    expect(m.baseUrl).toBe('https://relay.example.test/v1');
  });

  it('picks the wire API per endpoint: api.openai.com → Responses, compatibles → Completions, override wins', () => {
    expect(openAiApiFor({ baseUrl: 'https://api.openai.com/v1' })).toBe('openai-responses');
    expect(openAiApiFor({ baseUrl: '' })).toBe('openai-responses'); // empty base defaults to the official endpoint
    expect(openAiApiFor({ baseUrl: 'https://openrouter.ai/api/v1' })).toBe('openai-completions');
    expect(openAiApiFor({ baseUrl: 'https://ai.example/v1' })).toBe('openai-completions');
    expect(openAiApiFor({ baseUrl: 'https://api.openai.com/v1', api: 'openai-completions' })).toBe('openai-completions');
    expect(openAiApiFor({ baseUrl: 'https://ai.example/v1', api: 'openai-responses' })).toBe('openai-responses');
    // …and the registry actually registers the model under that API.
    const reg = buildBrainRegistry({ providers: [{ id: 'oa', label: 'OpenAI', type: 'openai', baseUrl: 'https://api.openai.com/v1', models: ['gpt-x'], apiKey: 'k' }] });
    expect(reg.find('orca-oa', 'gpt-x')?.api).toBe('openai-responses');
  });

  it('throws a clear error with no providers configured', () => {
    const empty: BrainRuntimeConfig = { providers: [] };
    const reg = buildBrainRegistry(empty);
    expect(() => resolveBrainModel(reg, empty)).toThrow(/no brain provider/);
  });

  it('applies a per-model context-window override (keyed providerId/model), else the default', () => {
    const withWindows: BrainRuntimeConfig = { ...cfg, contextWindows: { 'relay/kimi': 32000 } };
    const reg = buildBrainRegistry(withWindows);
    expect(resolveBrainModel(reg, withWindows, { provider: 'relay', model: 'kimi' }).contextWindow).toBe(32000);
    expect(resolveBrainModel(reg, withWindows, { provider: 'relay', model: 'gpt-x' }).contextWindow).toBe(200000);
  });

  it('applies the override to an ad-hoc (hand-typed) model registered on the fly', () => {
    const withWindows: BrainRuntimeConfig = { ...cfg, contextWindows: { 'relay/typed-x': 16000 } };
    const reg = buildBrainRegistry(withWindows);
    expect(resolveBrainModel(reg, withWindows, { provider: 'relay', model: 'typed-x' }).contextWindow).toBe(16000);
  });
});
