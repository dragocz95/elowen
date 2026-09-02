import { describe, expect, it } from 'vitest';
import {
  HOSTED_TOOL_SEARCH_PROTOCOL,
  hostedToolSearchFingerprint,
  isHostedToolSearchCapableProvider,
  passesHostedToolSearchModelGate,
  resolveHostedToolSearchRoute,
  type HostedToolSearchCapabilities,
} from '../../../src/brain/session/hostedToolSearch.js';

const runtime = (hostedToolSearch: HostedToolSearchCapabilities = {}, enabled = true) => ({
  toolDeferralEnabled: enabled,
  hostedToolSearch,
});
const entry = (overrides: Record<string, unknown>) => ({
  id: 'provider', label: 'Provider', type: 'openai', baseUrl: '', models: ['model'], apiKey: 'secret',
  ...overrides,
});
const model = (overrides: Record<string, unknown>) => ({
  id: 'gpt-5.6-luna', provider: 'elowen-provider', api: 'openai-responses',
  ...overrides,
});

describe('resolveHostedToolSearchRoute', () => {
  it('keeps the verified OAuth routes', () => {
    expect(resolveHostedToolSearchRoute(
      entry({ id: 'codex', type: 'oauth-openai-codex' }) as never,
      model({ provider: 'openai-codex', api: 'openai-codex-responses' }) as never,
      runtime(),
    )).toEqual({ provider: 'openai', source: 'oauth', modelId: 'gpt-5.6-luna' });
    expect(resolveHostedToolSearchRoute(
      entry({ id: 'anthropic', type: 'oauth-anthropic' }) as never,
      model({ id: 'claude-fable-5-1', provider: 'anthropic', api: 'anthropic-messages' }) as never,
      runtime(),
    )).toEqual({ provider: 'anthropic', source: 'oauth', modelId: 'claude-fable-5-1' });
  });

  it('enables only exact official API-key endpoints', () => {
    expect(resolveHostedToolSearchRoute(
      entry({ type: 'openai', api: 'openai-responses', baseUrl: 'https://api.openai.com/v1/' }) as never,
      model({}) as never,
      runtime(),
    )).toEqual({ provider: 'openai', source: 'official', modelId: 'gpt-5.6-luna' });
    expect(resolveHostedToolSearchRoute(
      entry({ type: 'openai', api: 'openai-responses', baseUrl: '' }) as never,
      model({}) as never,
      runtime(),
    )).toEqual({ provider: 'openai', source: 'official', modelId: 'gpt-5.6-luna' });
    expect(resolveHostedToolSearchRoute(
      entry({ type: 'anthropic', baseUrl: 'https://api.anthropic.com/' }) as never,
      model({ id: 'claude-fable-5', api: 'anthropic-messages' }) as never,
      runtime(),
    )).toEqual({ provider: 'anthropic', source: 'official', modelId: 'claude-fable-5' });

    for (const baseUrl of [
      'https://api.openai.com.evil/v1',
      'https://api.openai.com/proxy/v1',
      'https://openrouter.ai/api/v1',
      'https://api.anthropic.com.evil',
      'https://api.anthropic.com/proxy',
      'not-a-url',
    ]) {
      expect(resolveHostedToolSearchRoute(
        entry({ type: baseUrl.includes('anthropic') ? 'anthropic' : 'openai', api: 'openai-responses', baseUrl }) as never,
        model({ api: baseUrl.includes('anthropic') ? 'anthropic-messages' : 'openai-responses' }) as never,
        runtime(),
      )).toBeUndefined();
    }
  });

  it('requires a matching positive Azure probe, independent of deployment naming', () => {
    const azure = entry({
      id: 'azure-openai', type: 'openai', api: 'openai-responses',
      baseUrl: 'https://chetty-agent-openai.openai.azure.com/openai/v1/', models: ['production-luna'],
    });
    const deployed = model({ id: 'production-luna', api: 'openai-responses' });
    expect(resolveHostedToolSearchRoute(azure as never, deployed as never, runtime())).toBeUndefined();

    const fingerprint = hostedToolSearchFingerprint(azure as never, 'production-luna');
    const supported: HostedToolSearchCapabilities = {
      'azure-openai': {
        'production-luna': {
          status: 'supported', fingerprint, checkedAt: 1_700_000_000_000,
          protocol: HOSTED_TOOL_SEARCH_PROTOCOL,
        },
      },
    };
    expect(resolveHostedToolSearchRoute(azure as never, deployed as never, runtime(supported))).toEqual({
      provider: 'openai', source: 'azure-probe', modelId: 'production-luna',
    });

    const stale = structuredClone(supported);
    stale['azure-openai']!['production-luna']!.fingerprint = 'stale';
    expect(resolveHostedToolSearchRoute(azure as never, deployed as never, runtime(stale))).toBeUndefined();
    supported['azure-openai']!['production-luna']!.status = 'unsupported';
    expect(resolveHostedToolSearchRoute(azure as never, deployed as never, runtime(supported))).toBeUndefined();
  });

  it('requires Responses API, supported model families and the global deferral switch', () => {
    const official = entry({ type: 'openai', api: 'openai-responses', baseUrl: 'https://api.openai.com/v1' });
    expect(resolveHostedToolSearchRoute(official as never, model({ id: 'gpt-5.3-codex' }) as never, runtime())).toBeUndefined();
    expect(resolveHostedToolSearchRoute(official as never, model({ api: 'openai-completions' }) as never, runtime())).toBeUndefined();
    expect(resolveHostedToolSearchRoute(official as never, model({}) as never, runtime({}, false))).toBeUndefined();
  });

  describe('the operator’s per-provider switch', () => {
    const codex = { id: 'codex', type: 'oauth-openai-codex' };
    const codexModel = { provider: 'openai-codex', api: 'openai-codex-responses' };
    const claude = { id: 'anthropic', type: 'oauth-anthropic' };
    const claudeModel = { id: 'claude-fable-5-1', provider: 'anthropic', api: 'anthropic-messages' };
    const official = { type: 'openai', api: 'openai-responses', baseUrl: 'https://api.openai.com/v1' };

    it('withholds the route from every source when the provider is switched off', () => {
      for (const [overrides, wire] of [[codex, codexModel], [claude, claudeModel], [official, {}]] as const) {
        expect(resolveHostedToolSearchRoute(
          entry({ ...overrides, hostedToolSearchEnabled: false }) as never, model(wire) as never, runtime(),
        )).toBeUndefined();
      }

      const azure = {
        id: 'azure-openai', type: 'openai', api: 'openai-responses',
        baseUrl: 'https://chetty-agent-openai.openai.azure.com/openai/v1', models: ['production-luna'],
      };
      const deployed = model({ id: 'production-luna', api: 'openai-responses' });
      const verified: HostedToolSearchCapabilities = {
        'azure-openai': {
          'production-luna': {
            status: 'supported', fingerprint: hostedToolSearchFingerprint(entry(azure) as never, 'production-luna'),
            checkedAt: 1_700_000_000_000, protocol: HOSTED_TOOL_SEARCH_PROTOCOL,
          },
        },
      };
      expect(resolveHostedToolSearchRoute(entry(azure) as never, deployed as never, runtime(verified)))
        .toEqual({ provider: 'openai', source: 'azure-probe', modelId: 'production-luna' });
      expect(resolveHostedToolSearchRoute(
        entry({ ...azure, hostedToolSearchEnabled: false }) as never, deployed as never, runtime(verified),
      )).toBeUndefined();
    });

    it('leaves today’s behaviour for an unset switch', () => {
      for (const [overrides, wire, expected] of [
        [codex, codexModel, { provider: 'openai', source: 'oauth', modelId: 'gpt-5.6-luna' }],
        [claude, claudeModel, { provider: 'anthropic', source: 'oauth', modelId: 'claude-fable-5-1' }],
        [official, {}, { provider: 'openai', source: 'official', modelId: 'gpt-5.6-luna' }],
      ] as const) {
        expect(resolveHostedToolSearchRoute(entry(overrides) as never, model(wire) as never, runtime())).toEqual(expected);
      }
    });

    it('cannot GRANT a route — an unprobed Azure deployment stays off with the switch on', () => {
      // The switch is subtractive by construction: the config has no value meaning "enabled", so a forged
      // patch reaches at most the default, and the Azure branch still has to find its own positive probe.
      const azure = entry({
        id: 'azure-openai', type: 'openai', api: 'openai-responses',
        baseUrl: 'https://chetty-agent-openai.openai.azure.com/openai/v1', models: ['production-luna'],
      });
      const deployed = model({ id: 'production-luna', api: 'openai-responses' });
      for (const forged of [true, 'true', 1]) {
        expect(resolveHostedToolSearchRoute(
          { ...azure, hostedToolSearchEnabled: forged } as never, deployed as never, runtime(),
        )).toBeUndefined();
      }
    });

    it('reads the literal off switch, not the mere presence of the field', () => {
      // The store drops everything but `false`, so nothing else should ever arrive here — but a check
      // written as "is the field set?" would turn a stray value into a silent kill switch on a provider
      // that works, which is the opposite failure and just as invisible.
      for (const forged of [true, 'false', 0, 1, null]) {
        expect(resolveHostedToolSearchRoute(
          entry({ ...codex, hostedToolSearchEnabled: forged }) as never, model(codexModel) as never, runtime(),
        )).toEqual({ provider: 'openai', source: 'oauth', modelId: 'gpt-5.6-luna' });
      }
    });

    it('never outranks the global deferral switch', () => {
      expect(resolveHostedToolSearchRoute(
        entry({ ...official, hostedToolSearchEnabled: false }) as never, model({}) as never, runtime({}, false),
      )).toBeUndefined();
    });
  });
});

describe('isHostedToolSearchCapableProvider', () => {
  it('answers for exactly the providers the resolver has a positive branch for', () => {
    for (const overrides of [
      { type: 'oauth-openai-codex' },
      { type: 'oauth-anthropic' },
      { type: 'openai', api: 'openai-responses', baseUrl: 'https://api.openai.com/v1' },
      { type: 'openai', api: 'openai-responses', baseUrl: '' },
      { type: 'anthropic', baseUrl: 'https://api.anthropic.com' },
      { type: 'openai', api: 'openai-responses', baseUrl: 'https://chetty-agent-openai.openai.azure.com/openai/v1' },
    ]) {
      expect(isHostedToolSearchCapableProvider(entry(overrides) as never)).toBe(true);
    }

    for (const overrides of [
      { type: 'oauth-github-copilot' },
      { type: 'oauth-kimi' },
      { type: 'openai', api: 'openai-completions', baseUrl: 'https://api.openai.com/v1' },
      { type: 'openai', api: 'openai-responses', baseUrl: 'https://openrouter.ai/api/v1' },
      { type: 'anthropic', baseUrl: 'https://relay.example/anthropic' },
      { type: 'openai', api: 'openai-responses', baseUrl: 'https://openai.azure.com/openai/v1' },
    ]) {
      expect(isHostedToolSearchCapableProvider(entry(overrides) as never)).toBe(false);
    }
  });

  // Capability is about the PROVIDER, so it answers before any model is picked — the operator switch and
  // the model gate narrow it afterwards, and neither may make the settings affordance disappear.
  it('ignores the operator switch', () => {
    expect(isHostedToolSearchCapableProvider(
      entry({ type: 'oauth-anthropic', hostedToolSearchEnabled: false }) as never,
    )).toBe(true);
  });
});

describe('passesHostedToolSearchModelGate', () => {
  it('reports the family arithmetic each capable provider applies', () => {
    const codex = entry({ type: 'oauth-openai-codex' }) as never;
    expect(passesHostedToolSearchModelGate(codex, 'gpt-5.4')).toBe(true);
    expect(passesHostedToolSearchModelGate(codex, 'gpt-5.3-codex')).toBe(false);

    const claude = entry({ type: 'oauth-anthropic' }) as never;
    expect(passesHostedToolSearchModelGate(claude, 'claude-opus-5')).toBe(true);
    expect(passesHostedToolSearchModelGate(claude, 'claude-opus-4-1')).toBe(false);
  });

  it('leaves an Azure deployment to its probe rather than guessing from the name', () => {
    // A deployment name carries no model family — that is exactly why the resolver reads a stored probe.
    const azure = entry({
      type: 'openai', api: 'openai-responses',
      baseUrl: 'https://chetty-agent-openai.openai.azure.com/openai/v1',
    }) as never;
    expect(passesHostedToolSearchModelGate(azure, 'production-luna')).toBe(true);
  });
});
