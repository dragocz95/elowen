import { describe, it, expect } from 'vitest';
import { buildBrainRegistry, resolveBrainModel } from '../../src/brain/providers.js';

const cfg = {
  openai: { baseUrl: 'https://coresynth.io/v1', apiKey: 'cs-x', model: 'gpt-x' },
  anthropic: { apiKey: 'sk-ant', model: 'claude-x' },
  default: 'openai' as const,
};

describe('brain providers', () => {
  it('resolves the default (openai) provider model', () => {
    const reg = buildBrainRegistry(cfg);
    expect(resolveBrainModel(reg, cfg).id).toBe('gpt-x');
  });

  it('resolves the anthropic provider model when asked', () => {
    const reg = buildBrainRegistry(cfg);
    expect(resolveBrainModel(reg, cfg, 'anthropic').id).toBe('claude-x');
  });

  it('normalizes a trailing /v1 on the openai base url', () => {
    const reg = buildBrainRegistry(cfg);
    const m = resolveBrainModel(reg, cfg, 'openai');
    expect(m.baseUrl.endsWith('/v1/v1')).toBe(false);
  });
});
