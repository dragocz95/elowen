import { beforeEach, describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { buildBrainRegistry, resolveBrainModel, resolveBrainModelRoute, openAiApiFor, inMemoryModelRuntime, OAUTH_BUILTIN } from '../../src/brain/providers.js';
import { applyProviderRequestProfile, modelCapabilities, qwenThinkingWire } from '../../src/brain/modelCapabilities.js';
import { applyFastModePayload, fastModeCostModel, fastModeHeaders, fastModeRequestOptions, resolveFastModeRoute } from '../../src/brain/fastMode.js';
import type { BrainRuntimeConfig } from '../../src/brain/providers.js';

// A fresh runtime per test: buildBrainRegistry re-registers the openai-codex provider, and that copy-forward
// reads the provider's live descriptors — running it twice over one runtime would copy the already-consumed
// (header-nulled) descriptors, so each test needs its own credential-less runtime, as the old per-test
// in-memory registries gave.
let runtime: ModelRuntime;
beforeEach(async () => { runtime = await inMemoryModelRuntime(); });

const cfg: BrainRuntimeConfig = {
  providers: [
    { id: 'relay', label: 'Relay', type: 'openai', baseUrl: 'https://relay.example.test/v1', models: ['gpt-x', 'kimi'], apiKey: 'cs-x' },
    { id: 'ant', label: 'Anthropic', type: 'anthropic', baseUrl: '', models: ['claude-x'], apiKey: 'sk-ant' },
  ],
};

describe('brain providers', () => {
  it('resolves the first provider + first model by default', () => {
    const reg = buildBrainRegistry(cfg, runtime);
    const m = resolveBrainModel(reg, cfg);
    expect(m.id).toBe('gpt-x');
    expect(m.provider).toBe('elowen-relay');
  });

  it('resolves an explicit provider + model selection', () => {
    const reg = buildBrainRegistry(cfg, runtime);
    expect(resolveBrainModel(reg, cfg, { provider: 'ant', model: 'claude-x' }).id).toBe('claude-x');
    expect(resolveBrainModel(reg, cfg, { provider: 'relay', model: 'kimi' }).id).toBe('kimi');
  });

  // A selection naming a provider this installation no longer has (deleted in Settings, or restored from a
  // backup that predates it) used to fall through `?? cfg.providers[0]` and run on the FIRST provider in
  // list order — under that provider's credentials and billing, carrying the dead provider's model id. A
  // cron pinned to `alibaba/qwen3.8-max-preview` therefore kept firing, silently, against another account.
  // Naming a provider is an explicit instruction: when it cannot be honoured the only safe answer is to
  // say so. An EMPTY selection is a different fact — "no preference" — and still defaults (test below).
  it('refuses to substitute another provider when the named one is gone', () => {
    const reg = buildBrainRegistry(cfg, runtime);
    expect(() => resolveBrainModelRoute(reg, cfg, { provider: 'alibaba', model: 'qwen3.8-max-preview' }))
      .toThrow(/alibaba/);
    expect(() => resolveBrainModelRoute(reg, cfg, { provider: 'alibaba', model: 'qwen3.8-max-preview' }))
      .toThrow(/not configured/);
  });

  it('still defaults to the first provider when the selection names none', () => {
    const reg = buildBrainRegistry(cfg, runtime);
    expect(resolveBrainModelRoute(reg, cfg, { model: 'kimi' }).providerId).toBe('relay');
    expect(resolveBrainModelRoute(reg, cfg, {}).providerId).toBe('relay');
  });

  it('resolves a distinct configured OAuth default only for compaction recovery', () => {
    const oauth: BrainRuntimeConfig = { providers: [{
      id: 'codex', label: 'ChatGPT', type: 'oauth-openai-codex', baseUrl: '',
      models: ['gpt-5.5', 'gpt-5.6-luna', 'gpt-5.6-sol'], apiKey: null,
    }] };
    const registry = buildBrainRegistry(oauth, runtime);

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
    const route = resolveBrainModelRoute(buildBrainRegistry(oauth, runtime), oauth, {
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
    const route = resolveBrainModelRoute(buildBrainRegistry(proxy, runtime), proxy, {
      provider: 'proxy', model: 'preview-chat-model',
    });
    expect(route.model.id).toBe('preview-chat-model');
    expect(route.compactionFallback).toBeUndefined();
  });

  describe("user-chosen compaction model (Account → Auto-compact)", () => {
    const oauth: BrainRuntimeConfig = { providers: [
      { id: 'codex', label: 'ChatGPT', type: 'oauth-openai-codex', baseUrl: '', models: ['gpt-5.5', 'gpt-5.6-luna'], apiKey: null },
      { id: 'ant', label: 'Anthropic', type: 'anthropic', baseUrl: 'https://api.anthropic.com', models: ['claude-x'], apiKey: 'k' },
    ] };

    it('routes compaction to a user pick on a DIFFERENT provider', () => {
      const registry = buildBrainRegistry(cfg, runtime);
      const route = resolveBrainModelRoute(registry, cfg, { provider: 'relay', model: 'gpt-x' }, { provider: 'ant', model: 'claude-x' });
      expect(route.model.provider).toBe('elowen-relay');
      expect(route.compactionFallback?.id).toBe('claude-x');
      expect(route.compactionFallback?.provider).toBe('elowen-ant');
    });

    it('lets the user pick win over the ChatGPT OAuth compaction default', () => {
      const registry = buildBrainRegistry(oauth, runtime);
      // Without a pick this luna session would compact on gpt-5.5 (the codex default).
      const route = resolveBrainModelRoute(registry, oauth, { provider: 'codex', model: 'gpt-5.6-luna' }, { provider: 'ant', model: 'claude-x' });
      expect(route.model.id).toBe('gpt-5.6-luna');
      expect(route.compactionFallback?.id).toBe('claude-x');
    });

    it('routes nothing when the explicit pick equals the chat model — suppressing the codex default', () => {
      const registry = buildBrainRegistry(oauth, runtime);
      const route = resolveBrainModelRoute(registry, oauth, { provider: 'codex', model: 'gpt-5.6-luna' }, { provider: 'codex', model: 'gpt-5.6-luna' });
      expect(route.model.id).toBe('gpt-5.6-luna');
      expect(route.compactionFallback).toBeUndefined();
    });

    it('falls through to the provider default when the pick is stale (removed provider)', () => {
      const registry = buildBrainRegistry(oauth, runtime);
      const route = resolveBrainModelRoute(registry, oauth, { provider: 'codex', model: 'gpt-5.6-luna' }, { provider: 'gone', model: 'whatever' });
      expect(route.compactionFallback?.id).toBe('gpt-5.5');
    });

    it('registers a hand-typed compaction model id on the fly for a custom endpoint', () => {
      const registry = buildBrainRegistry(cfg, runtime);
      const route = resolveBrainModelRoute(registry, cfg, { provider: 'relay', model: 'gpt-x' }, { provider: 'relay', model: 'typed-summary-model' });
      expect(route.compactionFallback?.id).toBe('typed-summary-model');
      expect(route.compactionFallback?.provider).toBe('elowen-relay');
    });
  });

  it('does not advertise speculative reasoning controls for an unknown custom model', () => {
    const reg = buildBrainRegistry(cfg, runtime);
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
    const reg = buildBrainRegistry(relay, runtime);
    const reasoner = resolveBrainModel(reg, relay, { provider: 'relay', model: 'oe-deepseek-v4-flash' });
    expect(reasoner.reasoning).toBe(true); // the trigger: only reasoning models take the developer path
    expect(reasoner.compat).toMatchObject({
      supportsDeveloperRole: false,
      supportsLongCacheRetention: false,
      supportsUsageInStreaming: true,
      supportsStrictMode: false,
      supportsStore: false,
      supportsReasoningEffort: false,
      maxTokensField: 'max_completion_tokens',
    });
    // Pinned for every model on the entry, so enabling reasoning on one later can't resurrect the 400.
    const chat = resolveBrainModel(reg, relay, { provider: 'relay', model: 'plain-chat-model' });
    expect(chat.compat?.supportsDeveloperRole).toBe(false);
  });

  it('honours explicit compatibility capabilities for an endpoint that implements OpenAI extensions', () => {
    const provider: BrainRuntimeConfig = { providers: [{
      id: 'extended', label: 'Extended', type: 'openai', baseUrl: 'https://extended.example.test/v1',
      models: ['model'], apiKey: 'k', compatibility: {
        supportsDeveloperRole: true,
        supportsLongCacheRetention: true,
        supportsUsageInStreaming: false,
        supportsStrictMode: true,
        supportsStore: true,
        supportsReasoningEffort: true,
        maxTokensField: 'max_tokens',
      },
    }] };
    const model = resolveBrainModel(buildBrainRegistry(provider, runtime), provider, { provider: 'extended', model: 'model' });
    expect(model.compat).toMatchObject(provider.providers[0]!.compatibility!);
  });

  it('leaves the official OpenAI endpoint on its native developer-role semantics', () => {
    const openai: BrainRuntimeConfig = { providers: [{
      id: 'oai', label: 'OpenAI', type: 'openai', baseUrl: 'https://api.openai.com/v1',
      models: ['gpt-5.5'], apiKey: 'k',
    }] };
    // It registers as openai-responses, where the developer role is correct — the pin must not reach it.
    expect(openAiApiFor(openai.providers[0]!)).toBe('openai-responses');
    const m = resolveBrainModel(buildBrainRegistry(openai, runtime), openai, { provider: 'oai', model: 'gpt-5.5' });
    expect(m.compat?.supportsDeveloperRole).toBeUndefined();
  });

  // Claude's OAuth / claude-code endpoint buffers a tool call's `input_json_delta`s into one burst at the
  // END of the call unless the fine-grained-tool-streaming beta is on — and pi-ai only sends that beta
  // when eager tool-input streaming is marked UNSUPPORTED on the model's compat. Without this pin the
  // model-authored `reason` and the streamed file path reach the authoring spinner only after the tool
  // already ran. These tests guard the pin itself; the delta→tool_authoring mapping is covered in
  // events.test.ts and the reason-over-label precedence in cli/chat/composeLabels.test.ts.
  describe('incremental tool-input streaming (live authoring spinner)', () => {
    const eagerOf = (m: { compat?: unknown }): boolean | undefined =>
      (m.compat as { supportsEagerToolInputStreaming?: boolean } | undefined)?.supportsEagerToolInputStreaming;

    it('forces eager tool-input streaming OFF for a configured anthropic endpoint', () => {
      const reg = buildBrainRegistry(cfg, runtime);
      const route = resolveBrainModelRoute(reg, cfg, { provider: 'ant', model: 'claude-x' });
      expect(route.model.api).toBe('anthropic-messages');
      expect(eagerOf(route.model)).toBe(false);
    });

    it('applies the pin to the built-in Claude OAuth catalog without mutating the shared registry', () => {
      const oauth: BrainRuntimeConfig = { providers: [{
        id: 'claude', label: 'Claude', type: 'oauth-anthropic', baseUrl: '', models: ['claude-opus-4-8'], apiKey: null,
      }] };
      const reg = buildBrainRegistry(oauth, runtime);
      const route = resolveBrainModelRoute(reg, oauth, { provider: 'claude', model: 'claude-opus-4-8' });
      expect(route.model.api).toBe('anthropic-messages');
      expect(eagerOf(route.model)).toBe(false);
      // The route carries a CLONE: the registry copy other consumers resolve stays unpinned.
      const shared = reg.find('anthropic', 'claude-opus-4-8');
      expect(shared).toBeDefined();
      expect(eagerOf(shared!)).toBeUndefined();
    });

    it('leaves non-anthropic APIs untouched', () => {
      const reg = buildBrainRegistry(cfg, runtime);
      const route = resolveBrainModelRoute(reg, cfg, { provider: 'relay', model: 'gpt-x' });
      expect(route.model.api).toBe('openai-completions');
      expect(eagerOf(route.model)).toBeUndefined();
    });
  });

  it('adds Fable 5.1 only to Claude OAuth by inheriting the Fable 5 descriptor', () => {
    const fable51 = 'claude-fable-5-1';
    const providers: BrainRuntimeConfig = {
      providers: [
        { id: 'claude', label: 'Claude', type: 'oauth-anthropic', baseUrl: '', models: [fable51], apiKey: null },
        { id: 'api', label: 'Anthropic API', type: 'anthropic', baseUrl: 'https://api.anthropic.com', models: [fable51], apiKey: 'k' },
      ],
      // Applying any OAuth pin re-registers the whole built-in provider, so the Fable-specific request
      // header must survive that copy-forward path too.
      contextWindows: { 'claude/claude-opus-5': 900_000 },
    };
    const registry = buildBrainRegistry(providers, runtime);
    const inherited = registry.find('anthropic', 'claude-fable-5');
    const added = registry.find('anthropic', fable51);
    expect(inherited).toBeDefined();
    expect(added).toBeDefined();
    expect(added).toMatchObject({
      api: inherited!.api,
      provider: inherited!.provider,
      baseUrl: inherited!.baseUrl,
      reasoning: inherited!.reasoning,
      thinkingLevelMap: inherited!.thinkingLevelMap,
      input: inherited!.input,
      cost: inherited!.cost,
      contextWindow: inherited!.contextWindow,
      maxTokens: inherited!.maxTokens,
      samplingParams: inherited!.samplingParams,
      compat: inherited!.compat,
    });
    expect(modelCapabilities(added!).levels).toEqual(modelCapabilities(inherited!).levels);
    expect(added!.input).toEqual(['text', 'image']);
    const registered = registry.getRegisteredProviderConfig('anthropic')?.models?.find((model) => model.id === fable51);
    expect(registered?.headers).toEqual({ 'user-agent': 'claude-cli/2.1.251' });

    const oauthRoute = resolveBrainModelRoute(registry, providers, { provider: 'claude', model: fable51 });
    expect(oauthRoute.providerId).toBe('claude');
    expect(oauthRoute.model).toMatchObject({ id: fable51, provider: 'anthropic', api: 'anthropic-messages' });

    // The overlay is the verified Claude-account catalog only. A manually configured API model keeps its
    // own provider namespace and receives none of the OAuth client-identity workaround.
    const apiRoute = resolveBrainModelRoute(registry, providers, { provider: 'api', model: fable51 });
    expect(apiRoute.model.provider).toBe('elowen-api');
    expect(apiRoute.model.headers).toBeUndefined();
    expect(registry.find('github-copilot', fable51)).toBeUndefined();
    expect(registry.find('openai-codex', fable51)).toBeUndefined();
  });

  it('declares known OpenAI reasoning levels centrally and labels xhigh as ultra', () => {
    const known: BrainRuntimeConfig = {
      providers: [{ id: 'oa', label: 'OpenAI', type: 'openai', baseUrl: 'https://api.openai.com/v1', models: ['gpt-5.4'], apiKey: 'k' }],
    };
    const m = resolveBrainModel(buildBrainRegistry(known, runtime), known);
    expect(m.thinkingLevelMap).toMatchObject({ minimal: 'low', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh' });
    expect(modelCapabilities(m).labels.xhigh).toBe('ultra');
  });

  it('keeps provider-native ultra and max as distinct top reasoning modes', () => {
    const profiled: BrainRuntimeConfig = { providers: [
      { id: 'oa', label: 'OpenAI', type: 'openai', baseUrl: 'https://api.openai.com/v1', models: ['gpt-5.6-sol'], apiKey: 'k' },
      { id: 'ant', label: 'Anthropic', type: 'anthropic', baseUrl: 'https://api.anthropic.com', models: ['claude-sonnet-5'], apiKey: 'k' },
    ] };
    const registry = buildBrainRegistry(profiled, runtime);
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
    expect(modelCapabilities(resolveBrainModel(buildBrainRegistry(profiled, runtime), profiled)).levels)
      .toEqual(['minimal', 'low', 'medium', 'high', 'max']);
  });

  it('recognizes dotted Claude generation ids and their upper reasoning levels', () => {
    const profiled: BrainRuntimeConfig = { providers: [{
      id: 'ant', label: 'Anthropic', type: 'anthropic', baseUrl: 'https://api.anthropic.com',
      models: ['claude-opus-4.8'], apiKey: 'k',
    }] };
    expect(modelCapabilities(resolveBrainModel(buildBrainRegistry(profiled, runtime), profiled)).levels)
      .toEqual(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
  });

  it('recognizes namespaced reasoning ids from OpenRouter-style catalogs', () => {
    const namespaced: BrainRuntimeConfig = { providers: [{
      id: 'router', label: 'Router', type: 'openai', baseUrl: 'https://openrouter.ai/api/v1',
      models: ['openai/gpt-5.6-sol', 'anthropic/claude-sonnet-5'], apiKey: 'k',
    }] };
    const registry = buildBrainRegistry(namespaced, runtime);
    expect(modelCapabilities(resolveBrainModel(registry, namespaced, { model: 'openai/gpt-5.6-sol' })).levels).toContain('max');
    expect(modelCapabilities(resolveBrainModel(registry, namespaced, { model: 'anthropic/claude-sonnet-5' })).reasoning).toBe(true);
  });

  it('offers the effort ladder for a Qwen MAX model on a DashScope compatible-mode endpoint', () => {
    // The user-visible regression: Qwen 3.6–3.8 MAX sessions had no low/medium/high control at all —
    // the catalog marks Qwen "reasons, effort not settable" and the 3.8 preview id was unknown entirely.
    const dashscope: BrainRuntimeConfig = { providers: [{
      id: 'alibaba', label: 'Alibaba', type: 'openai',
      baseUrl: 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1',
      models: ['qwen3.8-max-preview', 'qwen3.7-max'], apiKey: 'k',
    }] };
    const registry = buildBrainRegistry(dashscope, runtime);
    const preview = resolveBrainModel(registry, dashscope, { model: 'qwen3.8-max-preview' });
    expect(preview.reasoning).toBe(true);
    expect(modelCapabilities(preview).levels).toEqual(['low', 'medium', 'high']);
    expect(modelCapabilities(resolveBrainModel(registry, dashscope, { model: 'qwen3.7-max' })).levels)
      .toEqual(['low', 'medium', 'high']);
  });

  it('models Fast from the actual provider route, not from credential provenance alone', () => {
    const cases: { entry: BrainRuntimeConfig['providers'][number]; supported: string[]; unsupported: string[]; source: string }[] = [
      {
        entry: { id: 'codex', label: 'ChatGPT', type: 'oauth-openai-codex', baseUrl: '', models: ['gpt-5.5', 'gpt-5.3-codex-spark'], apiKey: null },
        supported: ['gpt-5.5'], unsupported: ['gpt-5.3-codex-spark'], source: 'openai-codex-oauth',
      },
      {
        entry: { id: 'openai', label: 'OpenAI', type: 'openai', api: 'openai-responses', baseUrl: 'https://api.openai.com/v1', models: ['gpt-5.6-sol', 'gpt-5.5'], apiKey: 'sk' },
        supported: ['gpt-5.6-sol'], unsupported: ['gpt-5.5'], source: 'openai-api',
      },
      {
        entry: { id: 'azure', label: 'Azure', type: 'openai', api: 'openai-responses', baseUrl: 'https://example.openai.azure.com/openai/v1', models: ['gpt-5.5', 'gpt-4o'], apiKey: 'azure-key' },
        supported: ['gpt-5.5'], unsupported: ['gpt-4o'], source: 'azure-openai',
      },
      {
        entry: { id: 'anthropic', label: 'Anthropic', type: 'anthropic', baseUrl: 'https://api.anthropic.com', models: ['claude-opus-5', 'claude-sonnet-5'], apiKey: 'ant' },
        supported: ['claude-opus-5'], unsupported: ['claude-sonnet-5'], source: 'anthropic-api',
      },
    ];

    for (const testCase of cases) {
      const local: BrainRuntimeConfig = { providers: [testCase.entry] };
      const registry = buildBrainRegistry(local, runtime);
      for (const modelId of testCase.supported) {
        const model = resolveBrainModel(registry, local, { provider: testCase.entry.id, model: modelId });
        expect(resolveFastModeRoute(testCase.entry, model)?.source, `${testCase.entry.id}/${modelId}`).toBe(testCase.source);
      }
      for (const modelId of testCase.unsupported) {
        const model = resolveBrainModel(registry, local, { provider: testCase.entry.id, model: modelId });
        expect(resolveFastModeRoute(testCase.entry, model), `${testCase.entry.id}/${modelId}`).toBeUndefined();
      }
    }

    const relay: BrainRuntimeConfig = { providers: [{
      id: 'relay', label: 'Relay', type: 'openai', api: 'openai-responses',
      baseUrl: 'https://relay.example.test/v1', models: ['gpt-5.6-sol'], apiKey: 'relay-key',
    }] };
    const relayModel = resolveBrainModel(buildBrainRegistry(relay, runtime), relay);
    expect(resolveFastModeRoute(relay.providers[0]!, relayModel)).toBeUndefined();

    for (const entry of [
      { id: 'openai-port', label: 'OpenAI port', type: 'openai' as const, api: 'openai-responses' as const, baseUrl: 'https://api.openai.com:8443/v1', models: ['gpt-5.6-sol'], apiKey: 'k' },
      { id: 'anthropic-port', label: 'Anthropic port', type: 'anthropic' as const, baseUrl: 'https://api.anthropic.com:8443', models: ['claude-opus-5'], apiKey: 'k' },
    ]) {
      const config: BrainRuntimeConfig = { providers: [entry] };
      const model = resolveBrainModel(buildBrainRegistry(config, runtime), config);
      expect(resolveFastModeRoute(entry, model), entry.id).toBeUndefined();
    }
  });

  it('projects the exact Fast wire only for a supported route', () => {
    const openAiPayload = { model: 'gpt-5.6-sol', input: [] };
    const openAiRoute = { provider: 'openai', source: 'openai-api', serviceTier: 'priority' } as const;
    expect(applyFastModePayload(openAiPayload, openAiRoute)).toEqual({ ...openAiPayload, service_tier: 'priority' });
    expect(fastModeHeaders(openAiRoute)).toEqual({});

    const anthropicPayload = { model: 'claude-opus-5', messages: [] };
    const anthropicRoute = { provider: 'anthropic', source: 'anthropic-api', speed: 'fast', beta: 'fast-mode-2026-02-01' } as const;
    expect(applyFastModePayload(anthropicPayload, anthropicRoute)).toEqual({ ...anthropicPayload, speed: 'fast' });
    expect(fastModeHeaders(anthropicRoute)).toEqual({ 'anthropic-beta': 'fast-mode-2026-02-01' });
    const priced = fastModeCostModel({ cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 } } as never, anthropicRoute);
    expect(priced.cost).toEqual({ input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 });
  });

  it('samples the account preference and actual request model for every provider call', async () => {
    const official: BrainRuntimeConfig = { providers: [{
      id: 'openai', label: 'OpenAI', type: 'openai', api: 'openai-responses', baseUrl: 'https://api.openai.com/v1',
      models: ['gpt-5.6-sol', 'gpt-5.5'], apiKey: 'sk',
    }] };
    const registry = buildBrainRegistry(official, runtime);
    const supported = resolveBrainModel(registry, official, { model: 'gpt-5.6-sol' });
    const fallback = resolveBrainModel(registry, official, { model: 'gpt-5.5' });
    let enabled = false;
    const options = { onPayload: (payload: unknown) => ({ ...(payload as object), original: true }) };
    const routeFor = (model: typeof supported) => resolveFastModeRoute(official.providers[0]!, model);

    const off = fastModeRequestOptions(options, supported, () => enabled, routeFor);
    expect(await off.onPayload?.({ model: supported.id }, supported)).toEqual({ model: supported.id, original: true });

    enabled = true;
    const on = fastModeRequestOptions(options, supported, () => enabled, routeFor);
    expect(await on.onPayload?.({ model: supported.id }, supported)).toEqual({ model: supported.id, original: true, service_tier: 'priority' });

    const unsupported = fastModeRequestOptions(options, fallback, () => enabled, routeFor);
    expect(await unsupported.onPayload?.({ model: fallback.id }, fallback)).toEqual({ model: fallback.id, original: true });
    expect(unsupported.headers).toBeUndefined();

    const anthropicConfig: BrainRuntimeConfig = { providers: [{
      id: 'anthropic', label: 'Anthropic', type: 'anthropic', baseUrl: 'https://api.anthropic.com',
      models: ['claude-opus-5'], apiKey: 'sk-ant',
    }] };
    const anthropicModel = resolveBrainModel(buildBrainRegistry(anthropicConfig, runtime), anthropicConfig);
    const fetchImpl = vi.fn(async (_input: unknown, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('anthropic-beta'))
        .toBe('fine-grained-tool-streaming-2025-05-14,fast-mode-2026-02-01');
      return new Response('{}', { status: 200 });
    });
    const anthropic = fastModeRequestOptions(
      { fetch: fetchImpl as never }, anthropicModel, () => true,
      (model) => resolveFastModeRoute(anthropicConfig.providers[0]!, model),
    );
    expect(anthropic.headers).toBeUndefined();
    await anthropic.fetch?.('https://api.anthropic.com/v1/messages', {
      headers: { 'anthropic-beta': 'fine-grained-tool-streaming-2025-05-14' },
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  describe('temperature projection', () => {
    const payload = { model: 'k3', messages: [] };

    it('sends nothing when no temperature is configured', () => {
      // Identity, not a copy: the hook uses that to skip patching the request entirely, so a provider
      // without a temperature must reach the wire exactly as PI built it. Models like Kimi K3 reject any
      // value but their default, so "absent" is the only safe default and `undefined` would not do — it
      // would still serialize the key.
      expect(applyProviderRequestProfile(payload, {})).toBe(payload);
      expect('temperature' in applyProviderRequestProfile(payload, {})).toBe(false);
    });

    it('passes a configured temperature through, including 0', () => {
      expect(applyProviderRequestProfile(payload, { temperature: 0.7 })).toEqual({ ...payload, temperature: 0.7 });
      // 0 is a real setting, not "unset" — a falsy check here would silently drop it.
      expect(applyProviderRequestProfile(payload, { temperature: 0 })).toEqual({ ...payload, temperature: 0 });
    });

    it('keeps temperature independent from route-owned Fast mode', () => {
      expect(applyProviderRequestProfile(payload, { temperature: 1.5 }))
        .toEqual({ ...payload, temperature: 1.5 });
    });
  });

  describe('Qwen thinking projection — DashScope honors thinking_budget, not reasoning_effort', () => {
    const payload = { model: 'qwen3.7-max', messages: [], reasoning_effort: 'medium' };

    it('rewrites the selected effort into enable_thinking + thinking_budget and lifts the cap above it', () => {
      // DashScope 400s unless the completion cap is STRICTLY greater than thinking_budget, so the
      // projection lifts pi-ai's answer-sized cap by the budget (base 8192 + budget).
      expect(applyProviderRequestProfile({ ...payload, max_completion_tokens: 8192 }, { qwenThinking: true }))
        .toEqual({ model: 'qwen3.7-max', messages: [], enable_thinking: true, thinking_budget: 8192, max_completion_tokens: 16384 });
    });

    it('high effort — the budget exceeds the default cap, the lifted cap still clears it', () => {
      // The exact production 400: budget 16384 vs pi's cap 8192. Lifted to 8192 + 16384.
      const high = applyProviderRequestProfile(
        { model: 'qwen3.7-max', messages: [], reasoning_effort: 'high', max_completion_tokens: 8192 },
        { qwenThinking: true },
      );
      expect(high).toEqual({ model: 'qwen3.7-max', messages: [], enable_thinking: true, thinking_budget: 16384, max_completion_tokens: 24576 });
      expect(high.max_completion_tokens as number).toBeGreaterThan(high.thinking_budget as number);
    });

    it('low effort lifts the cap by the small budget', () => {
      expect(applyProviderRequestProfile(
        { model: 'qwen3.7-max', messages: [], reasoning_effort: 'low', max_completion_tokens: 8192 },
        { qwenThinking: true },
      )).toEqual({ model: 'qwen3.7-max', messages: [], enable_thinking: true, thinking_budget: 2048, max_completion_tokens: 10240 });
    });

    it('lifts whichever cap field pi-ai chose, adding max_completion_tokens only when neither exists', () => {
      // compat.maxTokensField made it max_tokens → that field is raised, no stray twin appears.
      expect(applyProviderRequestProfile(
        { model: 'qwen3.7-max', messages: [], reasoning_effort: 'medium', max_tokens: 4096 },
        { qwenThinking: true },
      )).toEqual({ model: 'qwen3.7-max', messages: [], enable_thinking: true, thinking_budget: 8192, max_tokens: 12288 });
      // No cap on the wire at all → default answer allowance + budget.
      expect(applyProviderRequestProfile(payload, { qwenThinking: true }))
        .toEqual({ model: 'qwen3.7-max', messages: [], enable_thinking: true, thinking_budget: 8192, max_completion_tokens: 16384 });
    });

    it('adds nothing when no effort is selected — the endpoint default stays', () => {
      // Identity, not a copy: an explicit `enable_thinking: false` would 400 on thinking-only models.
      const noEffort = { model: 'qwen3.7-max', messages: [] };
      expect(applyProviderRequestProfile(noEffort, { qwenThinking: true })).toBe(noEffort);
    });

    it('keeps the OpenAI reasoning_effort shape for profiles without the Qwen flag (regression)', () => {
      expect(applyProviderRequestProfile(payload, {})).toBe(payload);
      // The cap lift is qwenThinking-only: an OpenAI-style payload keeps its cap byte-for-byte.
      const openai = { model: 'gpt-5.5', messages: [], reasoning_effort: 'high', max_completion_tokens: 8192 };
      expect(applyProviderRequestProfile(openai, {})).toBe(openai);
      expect(applyProviderRequestProfile(openai, { temperature: 0.5 }))
        .toEqual({ ...openai, temperature: 0.5 });
    });

    it('composes with a configured temperature', () => {
      expect(applyProviderRequestProfile(payload, { temperature: 0.7, qwenThinking: true }))
        .toEqual({ model: 'qwen3.7-max', messages: [], temperature: 0.7, enable_thinking: true, thinking_budget: 8192, max_completion_tokens: 16384 });
    });

    it('applies only to Qwen models on DashScope-style endpoints', () => {
      const dashscope = 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1';
      expect(qwenThinkingWire(dashscope, 'qwen3.8-max-preview')).toBe(true);
      expect(qwenThinkingWire('https://dashscope-intl.aliyuncs.com/compatible-mode/v1', 'qwen3.7-plus')).toBe(true);
      // The same endpoint's non-Qwen models keep the standard shape…
      expect(qwenThinkingWire(dashscope, 'glm-5.2')).toBe(false);
      // …and Qwen through OpenRouter keeps pi-ai's `reasoning` object, which OpenRouter maps itself.
      expect(qwenThinkingWire('https://openrouter.ai/api/v1', 'qwen/qwen3.7-max')).toBe(false);
    });
  });

  describe('Kimi Code (kimi-coding)', () => {
    const empty: BrainRuntimeConfig = { providers: [] };

    // Elowen owns no Kimi code since PI 0.82.0: PI ships the provider's OAuth, catalog, baseUrl and
    // per-model User-Agent, and `OAUTH_BUILTIN` simply points `oauth-kimi` at it. These assert what that
    // mapping DEPENDS on, so a PI release that drops any of it fails here instead of at a user's sign-in.

    it('is loginable straight off a bare runtime — no registration of ours in between', async () => {
      // `/brain/oauth/:type/start` drives `runtime.login` directly and nothing builds a registry first, so
      // on a fresh install the provider must already carry OAuth or the first sign-in dies with
      // "Unknown OAuth provider: kimi-coding". Elowen used to attach that itself; PI now ships it.
      const freshRuntime = await inMemoryModelRuntime();
      expect(freshRuntime.getProvider('kimi-coding')?.auth.oauth).toBeDefined();
      expect(OAUTH_BUILTIN['oauth-kimi']).toBe('kimi-coding');
    });

    it('serves a catalog on the coding endpoint, k3 included', () => {
      // The subscription endpoint, NOT the generic Moonshot API: a wrong baseUrl 404s every request.
      const models = buildBrainRegistry(empty, runtime).getAll().filter((m) => m.provider === 'kimi-coding');
      expect(models.map((m) => m.id)).toContain('k3');
      for (const model of models) expect(model.baseUrl).toBe('https://api.kimi.com/coding');
    });

    it("leaves Kimi's User-Agent to PI, which stamps its own", async () => {
      // Kimi's endpoint rejects requests without a User-Agent, and the header used to be a per-model
      // `KimiCLI/x` that registration moved into a side store. PI 0.84.2 made the Anthropic transport
      // stamp its own runtime agent for Kimi specifically, so a per-model header here became dead weight
      // that read as if it still mattered.
      //
      // 0.84.3 widened that: the agent is now the BASE for every Anthropic request rather than a
      // Kimi-only override, and caller headers win over it instead of being discarded. Nothing we send
      // changes — we set no agent anywhere — but the assertion has to describe the mechanism that is
      // actually there, or the next upgrade fails on a claim nobody can check.
      //
      // Pinned on both halves, because either one alone passes for the wrong reason: the resolved headers
      // must carry no agent of ours, and the transport Kimi actually rides must still set one.
      const reg = buildBrainRegistry(empty, runtime);
      const models = reg.getAll().filter((m) => m.provider === 'kimi-coding');
      expect(models.length).toBeGreaterThan(0);
      for (const model of models) {
        const resolved = await (reg as unknown as {
          getApiKeyAndHeaders(m: unknown): Promise<{ headers?: Record<string, string> }>;
        }).getApiKeyAndHeaders(model);
        expect(resolved.headers?.['User-Agent']).toBeUndefined();
        expect(model.api).toBe('anthropic-messages');
      }
      const transport = readFileSync(
        fileURLToPath(new URL('../../node_modules/@earendil-works/pi-ai/dist/api/anthropic-messages.js', import.meta.url)),
        'utf8',
      );
      expect(transport).toContain('mergeHeaders({ "User-Agent": getPiUserAgent() }');
    });

    it('reads k3 as a reasoning model', () => {
      // K3 always thinks. Elowen no longer grades its efforts (PI 0.80.10 documented `max` alone, 0.82.0
      // widened it to low/high/max), so only the property the model picker depends on is asserted: k3 must
      // not silently degrade into a non-reasoning model offering no thinking level at all.
      const model = buildBrainRegistry(empty, runtime).getAll().find((m) => m.provider === 'kimi-coding' && m.id === 'k3');
      expect(model?.reasoning).toBe(true);
      expect(model?.thinkingLevelMap?.max).toBe('max');
    });
  });

  it('registers a hand-typed model id on the fly for a custom endpoint', () => {
    const reg = buildBrainRegistry(cfg, runtime);
    const m = resolveBrainModel(reg, cfg, { provider: 'relay', model: 'brand/new-model' });
    expect(m.id).toBe('brand/new-model');
    expect(m.provider).toBe('elowen-relay');
  });

  it('keeps the /v1 segment in the openai base url (client appends /chat/completions)', () => {
    const reg = buildBrainRegistry(cfg, runtime);
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
    const reg = buildBrainRegistry({ providers: [{ id: 'oa', label: 'OpenAI', type: 'openai', baseUrl: 'https://api.openai.com/v1', models: ['gpt-x'], apiKey: 'k' }] }, runtime);
    expect(reg.find('elowen-oa', 'gpt-x')?.api).toBe('openai-responses');
  });

  it('throws a clear error with no providers configured', () => {
    const empty: BrainRuntimeConfig = { providers: [] };
    const reg = buildBrainRegistry(empty, runtime);
    expect(() => resolveBrainModel(reg, empty)).toThrow(/no brain provider/);
  });

  it('applies a per-model context-window override (keyed providerId/model), else the default', () => {
    const withWindows: BrainRuntimeConfig = { ...cfg, contextWindows: { 'relay/kimi': 32000 } };
    const reg = buildBrainRegistry(withWindows, runtime);
    expect(resolveBrainModel(reg, withWindows, { provider: 'relay', model: 'kimi' }).contextWindow).toBe(32000);
    expect(resolveBrainModel(reg, withWindows, { provider: 'relay', model: 'gpt-x' }).contextWindow).toBe(200000);
  });

  it('applies the override to an ad-hoc (hand-typed) model registered on the fly', () => {
    const withWindows: BrainRuntimeConfig = { ...cfg, contextWindows: { 'relay/typed-x': 16000 } };
    const reg = buildBrainRegistry(withWindows, runtime);
    expect(resolveBrainModel(reg, withWindows, { provider: 'relay', model: 'typed-x' }).contextWindow).toBe(16000);
  });

});

describe('pinned context windows', () => {
  const oauthCfg = (contextWindows?: Record<string, number>): BrainRuntimeConfig => ({
    providers: [{
      id: 'openai-codex', label: 'ChatGPT', type: 'oauth-openai-codex', baseUrl: '',
      models: ['gpt-5.5', 'gpt-5.6-sol'], apiKey: null,
    }],
    ...(contextWindows ? { contextWindows } : {}),
  });

  // An OAuth entry registers no provider of its own — PI owns the catalog — so the operator's pin used to
  // reach the settings picker (which applies it while rendering) but never the runtime. The window shown
  // in Settings and the one every session actually ran on silently disagreed.
  it('reaches the runtime descriptor of an OAuth built-in model, not just the picker', () => {
    const registry = buildBrainRegistry(oauthCfg({ 'openai-codex/gpt-5.6-sol': 372_000 }), runtime);
    expect(registry.find('openai-codex', 'gpt-5.6-sol')?.contextWindow).toBe(372_000);
  });

  it('leaves an unpinned model of the same provider on the catalog window', async () => {
    // A separate runtime for the baseline: building twice over one runtime copies descriptors this file's
    // header warns are already consumed, which would compare a pinned build against a degraded reading.
    const baseline = buildBrainRegistry(oauthCfg(), await inMemoryModelRuntime());
    const catalogWindow = baseline.find('openai-codex', 'gpt-5.5')?.contextWindow;
    expect(catalogWindow).toBeGreaterThan(0);

    const registry = buildBrainRegistry(oauthCfg({ 'openai-codex/gpt-5.6-sol': 372_000 }), runtime);

    // Re-registering replaces the provider's whole model list, so the models NOT pinned have to survive
    // the round trip intact — otherwise one pin would quietly flatten the rest of the catalog.
    expect(registry.find('openai-codex', 'gpt-5.5')?.contextWindow).toBe(catalogWindow);
    expect(registry.find('openai-codex', 'gpt-5.5')?.api).toBe(registry.find('openai-codex', 'gpt-5.6-sol')?.api);
  });
});
