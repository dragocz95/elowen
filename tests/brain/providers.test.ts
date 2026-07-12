import { describe, it, expect } from 'vitest';
import { buildBrainRegistry, resolveBrainModel, resolveBrainModelRoute, openAiApiFor } from '../../src/brain/providers.js';
import { applyProviderRequestProfile, modelCapabilities } from '../../src/brain/modelCapabilities.js';
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
    expect(m.provider).toBe('elowen-relay');
  });

  it('resolves an explicit provider + model selection', () => {
    const reg = buildBrainRegistry(cfg);
    expect(resolveBrainModel(reg, cfg, { provider: 'ant', model: 'claude-x' }).id).toBe('claude-x');
    expect(resolveBrainModel(reg, cfg, { provider: 'relay', model: 'kimi' }).id).toBe('kimi');
  });

  it('resolves a distinct configured OAuth default only for compaction recovery', () => {
    const oauth: BrainRuntimeConfig = { providers: [{
      id: 'codex', label: 'ChatGPT', type: 'oauth-openai-codex', baseUrl: '',
      models: ['gpt-5.5', 'gpt-5.6-luna', 'gpt-5.6-sol'], apiKey: null,
    }] };
    const registry = buildBrainRegistry(oauth);

    const luna = resolveBrainModelRoute(registry, oauth, { provider: 'codex', model: 'gpt-5.6-luna' });
    expect(luna.providerId).toBe('codex');
    expect(luna.model.id).toBe('gpt-5.6-luna');
    expect(luna.compactionFallback?.id).toBe('gpt-5.5');

    const resumedOnDefault = resolveBrainModelRoute(registry, oauth, { provider: 'codex', model: 'gpt-5.5' });
    expect(resumedOnDefault.model.id).toBe('gpt-5.5');
    expect(resumedOnDefault.compactionFallback).toBeUndefined();

    const switched = resolveBrainModelRoute(registry, oauth, { provider: 'codex', model: 'gpt-5.6-sol' });
    expect(switched.model.id).toBe('gpt-5.6-sol');
    expect(switched.compactionFallback?.id).toBe('gpt-5.5');
  });

  it('keeps a valid selected OAuth chat model when the configured default is unavailable', () => {
    const oauth: BrainRuntimeConfig = { providers: [{
      id: 'codex', label: 'ChatGPT', type: 'oauth-openai-codex', baseUrl: '',
      models: ['removed-default-model'], apiKey: null,
    }] };
    const route = resolveBrainModelRoute(buildBrainRegistry(oauth), oauth, {
      provider: 'codex', model: 'gpt-5.6-luna',
    });
    expect(route.model.id).toBe('gpt-5.6-luna');
    expect(route.compactionFallback).toBeUndefined();
  });

  it('does not apply the Codex compaction route to a custom OpenAI-compatible proxy', () => {
    const proxy: BrainRuntimeConfig = { providers: [{
      id: 'proxy', label: 'Proxy', type: 'openai', baseUrl: 'https://proxy.example/v1',
      models: ['stable-summary-model', 'preview-chat-model'], apiKey: 'k',
    }] };
    const route = resolveBrainModelRoute(buildBrainRegistry(proxy), proxy, {
      provider: 'proxy', model: 'preview-chat-model',
    });
    expect(route.model.id).toBe('preview-chat-model');
    expect(route.compactionFallback).toBeUndefined();
  });

  it('does not advertise speculative reasoning controls for an unknown custom model', () => {
    const reg = buildBrainRegistry(cfg);
    const m = resolveBrainModel(reg, cfg, { provider: 'relay', model: 'kimi' });
    expect(m.reasoning).toBe(false);
    expect(m.thinkingLevelMap).toBeUndefined();
  });

  it('declares known OpenAI reasoning levels centrally and labels xhigh as ultra', () => {
    const known: BrainRuntimeConfig = {
      providers: [{ id: 'oa', label: 'OpenAI', type: 'openai', baseUrl: 'https://api.openai.com/v1', models: ['gpt-5.4'], apiKey: 'k' }],
    };
    const m = resolveBrainModel(buildBrainRegistry(known), known);
    expect(m.thinkingLevelMap).toMatchObject({ minimal: 'low', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh' });
    expect(modelCapabilities(m).labels.xhigh).toBe('ultra');
  });

  it('keeps provider-native ultra and max as distinct top reasoning modes', () => {
    const profiled: BrainRuntimeConfig = { providers: [
      { id: 'oa', label: 'OpenAI', type: 'openai', baseUrl: 'https://api.openai.com/v1', models: ['gpt-5.6-sol'], apiKey: 'k' },
      { id: 'ant', label: 'Anthropic', type: 'anthropic', baseUrl: 'https://api.anthropic.com', models: ['claude-sonnet-5'], apiKey: 'k' },
    ] };
    const registry = buildBrainRegistry(profiled);
    const openai = modelCapabilities(resolveBrainModel(registry, profiled, { provider: 'oa' }));
    const claude = modelCapabilities(resolveBrainModel(registry, profiled, { provider: 'ant' }));
    expect(openai.levels).toEqual(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
    expect(openai.labels).toEqual({ xhigh: 'ultra' });
    expect(claude.levels).toEqual(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
    expect(claude.labels).toEqual({});
  });

  it('matches Claude 4.6 max support without inventing xhigh', () => {
    const profiled: BrainRuntimeConfig = { providers: [{
      id: 'ant', label: 'Anthropic', type: 'anthropic', baseUrl: 'https://api.anthropic.com',
      models: ['claude-sonnet-4-6'], apiKey: 'k',
    }] };
    expect(modelCapabilities(resolveBrainModel(buildBrainRegistry(profiled), profiled)).levels)
      .toEqual(['minimal', 'low', 'medium', 'high', 'max']);
  });

  it('recognizes dotted Claude generation ids and their upper reasoning levels', () => {
    const profiled: BrainRuntimeConfig = { providers: [{
      id: 'ant', label: 'Anthropic', type: 'anthropic', baseUrl: 'https://api.anthropic.com',
      models: ['claude-opus-4.8'], apiKey: 'k',
    }] };
    expect(modelCapabilities(resolveBrainModel(buildBrainRegistry(profiled), profiled)).levels)
      .toEqual(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
  });

  it('recognizes namespaced reasoning ids from OpenRouter-style catalogs', () => {
    const namespaced: BrainRuntimeConfig = { providers: [{
      id: 'router', label: 'Router', type: 'openai', baseUrl: 'https://openrouter.ai/api/v1',
      models: ['openai/gpt-5.6-sol', 'anthropic/claude-sonnet-5'], apiKey: 'k',
    }] };
    const registry = buildBrainRegistry(namespaced);
    expect(modelCapabilities(resolveBrainModel(registry, namespaced, { model: 'openai/gpt-5.6-sol' })).levels).toContain('max');
    expect(modelCapabilities(resolveBrainModel(registry, namespaced, { model: 'anthropic/claude-sonnet-5' })).reasoning).toBe(true);
  });

  it('marks Fast available only on OpenAI Codex OAuth response models', () => {
    const oauth: BrainRuntimeConfig = {
      providers: [{ id: 'codex', label: 'ChatGPT', type: 'oauth-openai-codex', baseUrl: '', models: ['gpt-5.5'], apiKey: null }],
    };
    const m = resolveBrainModel(buildBrainRegistry(oauth), oauth);
    expect(modelCapabilities(m).fast).toBe(true);
    const regular = resolveBrainModel(buildBrainRegistry(cfg), cfg);
    expect(modelCapabilities(regular).fast).toBe(false);
  });

  it('projects Fast onto the official priority service tier without mutating normal payloads', () => {
    const payload = { model: 'gpt-5.5', input: [] };
    expect(applyProviderRequestProfile(payload, { fast: true })).toEqual({ ...payload, service_tier: 'priority' });
    expect(applyProviderRequestProfile(payload, { fast: false })).toBe(payload);
  });

  it('registers a hand-typed model id on the fly for a custom endpoint', () => {
    const reg = buildBrainRegistry(cfg);
    const m = resolveBrainModel(reg, cfg, { provider: 'relay', model: 'brand/new-model' });
    expect(m.id).toBe('brand/new-model');
    expect(m.provider).toBe('elowen-relay');
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
    expect(reg.find('elowen-oa', 'gpt-x')?.api).toBe('openai-responses');
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
