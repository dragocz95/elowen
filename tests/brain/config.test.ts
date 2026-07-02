import { describe, it, expect } from 'vitest';
import { openDb } from '../../src/store/db.js';
import { ConfigStore } from '../../src/store/configStore.js';
import { brainConfigFromOrca } from '../../src/brain/config.js';

describe('brainConfigFromOrca', () => {
  it('returns null when nothing is configured', () => {
    const config = new ConfigStore(openDb(':memory:'));
    expect(brainConfigFromOrca(config)).toBeNull();
  });

  it('falls back to the relay endpoint as a synthetic provider', () => {
    const config = new ConfigStore(openDb(':memory:'));
    config.update({ autopilot: { apiUrl: 'https://relay.example.test/v1', model: 'gpt-x', apiKey: 'cs-key' } });
    const cfg = brainConfigFromOrca(config);
    expect(cfg?.providers).toEqual([
      { id: 'relay', label: 'Relay', type: 'openai', baseUrl: 'https://relay.example.test/v1', models: ['gpt-x'], apiKey: 'cs-key', origin: 'relay' },
    ]);
  });

  it('surfaces a connected OAuth account as a synthetic provider', () => {
    const config = new ConfigStore(openDb(':memory:'));
    const auth = { get: (p: string) => (p === 'anthropic' ? { type: 'oauth' } : undefined) } as never;
    const cfg = brainConfigFromOrca(config, auth);
    expect(cfg?.providers).toEqual([
      { id: 'anthropic', label: 'Claude account', type: 'oauth-anthropic', baseUrl: '', models: [], apiKey: null, origin: 'oauth' },
    ]);
  });

  it('an explicit oauth entry wins over the synthetic one', () => {
    const config = new ConfigStore(openDb(':memory:'));
    config.update({ brain: { providers: [{ id: 'muj-claude', label: 'Můj Claude', type: 'oauth-anthropic', baseUrl: '', models: ['claude-opus-4-5'] }] } });
    const auth = { get: (p: string) => (p === 'anthropic' ? { type: 'oauth' } : undefined) } as never;
    expect(brainConfigFromOrca(config, auth)?.providers.map((p) => p.id)).toEqual(['muj-claude']);
  });

  it('dedicated brain.providers win over the relay fallback', () => {
    const config = new ConfigStore(openDb(':memory:'));
    config.update({
      autopilot: { apiUrl: 'https://relay.example.test/v1', model: 'gpt-x', apiKey: 'cs-key' },
      brain: { providers: [{ id: 'own', label: 'Own', type: 'openai', baseUrl: 'https://x/v1', models: ['m'], apiKey: 'k' }] },
    });
    expect(brainConfigFromOrca(config)?.providers.map((p) => p.id)).toEqual(['own']);
  });
});
