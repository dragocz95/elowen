import { describe, it, expect } from 'vitest';
import { AuthStorage } from '@earendil-works/pi-coding-agent';
import { buildBrainRegistry, resolveBrainModel, resolveBrainModelRoute, openAiApiFor } from '../../src/brain/providers.js';
import { applyProviderRequestProfile, modelCapabilities } from '../../src/brain/modelCapabilities.js';
import { KIMI_CLI_VERSION } from '../../src/brain/kimiOAuth.js';
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

  // pi-ai swaps the `system` role for OpenAI's `developer` on any REASONING model whose endpoint its
  // compat detection doesn't recognise — and a relay, fronting DeepSeek/Anthropic/… under its own URL, is
  // exactly what it cannot recognise. A relay that implements only the classic roles then 400s
  // ("unknown variant `developer`") on a healthy request, and ONLY for reasoning models — which is what
  // made it look random in production. Chat-Completions entries therefore pin the role off.
  it('never sends the developer role to a relay, not even for a reasoning model', () => {
    const relay: BrainRuntimeConfig = { providers: [{
      id: 'relay', label: 'Relay', type: 'openai', baseUrl: 'https://relay.example.test/v1',
      models: ['oe-deepseek-v4-flash', 'plain-chat-model'], apiKey: 'k',
    }] };
    const reg = buildBrainRegistry(relay);
    const reasoner = resolveBrainModel(reg, relay, { provider: 'relay', model: 'oe-deepseek-v4-flash' });
    expect(reasoner.reasoning).toBe(true); // the trigger: only reasoning models take the developer path
    expect(reasoner.compat?.supportsDeveloperRole).toBe(false);
    // Pinned for every model on the entry, so enabling reasoning on one later can't resurrect the 400.
    const chat = resolveBrainModel(reg, relay, { provider: 'relay', model: 'plain-chat-model' });
    expect(chat.compat?.supportsDeveloperRole).toBe(false);
  });

  it('leaves the official OpenAI endpoint on its native developer-role semantics', () => {
    const openai: BrainRuntimeConfig = { providers: [{
      id: 'oai', label: 'OpenAI', type: 'openai', baseUrl: 'https://api.openai.com/v1',
      models: ['gpt-5.5'], apiKey: 'k',
    }] };
    // It registers as openai-responses, where the developer role is correct — the pin must not reach it.
    expect(openAiApiFor(openai.providers[0]!)).toBe('openai-responses');
    const m = resolveBrainModel(buildBrainRegistry(openai), openai, { provider: 'oai', model: 'gpt-5.5' });
    expect(m.compat?.supportsDeveloperRole).toBeUndefined();
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

  describe('temperature projection', () => {
    const payload = { model: 'k3', messages: [] };

    it('sends nothing when no temperature is configured', () => {
      // Identity, not a copy: the hook uses that to skip patching the request entirely, so a provider
      // without a temperature must reach the wire exactly as PI built it. Models like Kimi K3 reject any
      // value but their default, so "absent" is the only safe default and `undefined` would not do — it
      // would still serialize the key.
      expect(applyProviderRequestProfile(payload, { fast: false })).toBe(payload);
      expect('temperature' in applyProviderRequestProfile(payload, { fast: false })).toBe(false);
    });

    it('passes a configured temperature through, including 0', () => {
      expect(applyProviderRequestProfile(payload, { fast: false, temperature: 0.7 })).toEqual({ ...payload, temperature: 0.7 });
      // 0 is a real setting, not "unset" — a falsy check here would silently drop it.
      expect(applyProviderRequestProfile(payload, { fast: false, temperature: 0 })).toEqual({ ...payload, temperature: 0 });
    });

    it('composes with Fast rather than replacing it', () => {
      expect(applyProviderRequestProfile(payload, { fast: true, temperature: 1.5 }))
        .toEqual({ ...payload, service_tier: 'priority', temperature: 1.5 });
    });
  });

  describe('Kimi Code (kimi-coding)', () => {
    const empty: BrainRuntimeConfig = { providers: [] };

    it('registers the OAuth provider where AuthStorage will look for it', async () => {
      // The trap this guards: npm installs two physical copies of pi-ai, each with its own OAuth registry,
      // and only the one nested under pi-coding-agent is the registry AuthStorage reads. Registering via
      // registerProvider({ oauth }) is what lands in the right one; importing registerOAuthProvider
      // directly would silently register into the copy nobody reads and login would 404.
      const auth = AuthStorage.inMemory();
      buildBrainRegistry(empty, auth);
      expect(auth.getOAuthProviders().map((p) => p.id)).toContain('kimi-coding');
    });


    it("keeps PI's built-in models and adds the ones the account can reach", () => {
      // registerProvider replaces a provider's model list wholesale, so the builtins are only still here
      // because we copy them forward.
      const ids = buildBrainRegistry(empty).getAll().filter((m) => m.provider === 'kimi-coding').map((m) => m.id);
      expect(ids).toEqual(expect.arrayContaining(['k2p7', 'kimi-for-coding', 'kimi-k2-thinking']));
      expect(ids).toContain('k3');
    });

    it("keeps Kimi's per-model User-Agent on the wire, for copied and added models alike", async () => {
      // Asserted on the resolved request headers, NOT on `model.headers`: registerProvider moves them into
      // a side store and nulls the descriptor field, so a test reading the descriptor would pass while the
      // header silently vanished from every request.
      //
      // Both a copied builtin AND an added model are checked because they take their headers from
      // different places (the builtin's own descriptor vs the template's). Testing only one leaves the
      // other free to lose its User-Agent green.
      const reg = buildBrainRegistry(empty);
      const wireAgent = async (id: string) => {
        const model = reg.getAll().find((m) => m.provider === 'kimi-coding' && m.id === id);
        const resolved = await (reg as unknown as {
          getApiKeyAndHeaders(m: unknown): Promise<{ headers?: Record<string, string> }>;
        }).getApiKeyAndHeaders(model);
        return resolved.headers?.['User-Agent'];
      };
      expect(await wireAgent('k2p7')).toBe(`KimiCLI/${KIMI_CLI_VERSION}`); // copied from PI
      expect(await wireAgent('k3')).toBe(`KimiCLI/${KIMI_CLI_VERSION}`); // added by us
    });

    it('knows k3 reasons and offers only the efforts Kimi documents', () => {
      // K3 always thinks; the catalog grades it low/high/max (not medium/xhigh). Regression guard: with
      // kimi-for-coding missing from the capability catalog, k3 read as a non-reasoning model.
      const model = buildBrainRegistry(empty).getAll().find((m) => m.provider === 'kimi-coding' && m.id === 'k3');
      expect(model?.reasoning).toBe(true);
      expect(model?.thinkingLevelMap?.low).toBe('low');
      expect(model?.thinkingLevelMap?.high).toBe('high');
      expect(model?.thinkingLevelMap?.max).toBe('max');
      expect(model?.thinkingLevelMap?.medium).toBeNull();
      expect(model?.thinkingLevelMap?.xhigh).toBeNull();
    });
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
