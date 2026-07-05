import { describe, it, expect } from 'vitest';
import { buildBrainRegistry, resolveBrainModel } from '../../src/brain/providers.js';
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
