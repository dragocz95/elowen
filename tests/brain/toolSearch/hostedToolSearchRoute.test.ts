import { describe, expect, it } from 'vitest';
import {
  HOSTED_TOOL_SEARCH_PROTOCOL,
  hostedToolSearchFingerprint,
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
});
