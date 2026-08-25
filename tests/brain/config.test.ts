import { describe, it, expect } from 'vitest';
import { openDb } from '../../src/store/db.js';
import { ConfigStore } from '../../src/store/configStore.js';
import { brainConfigFromElowen, configuredBrainProviders } from '../../src/brain/config.js';

describe('brainConfigFromElowen', () => {
  it('returns null when nothing is configured', () => {
    const config = new ConfigStore(openDb(':memory:'));
    expect(brainConfigFromElowen(config)).toBeNull();
  });

  it('surfaces a connected OAuth account as a synthetic provider', () => {
    const config = new ConfigStore(openDb(':memory:'));
    const auth = { get: (p: string) => (p === 'anthropic' ? { type: 'oauth' } : undefined) } as never;
    const cfg = brainConfigFromElowen(config, auth);
    expect(cfg?.providers).toEqual([
      { id: 'anthropic', label: 'Claude account', type: 'oauth-anthropic', baseUrl: '', models: [], apiKey: null, origin: 'oauth' },
    ]);
  });

  it('an explicit oauth entry wins over the synthetic one', () => {
    const config = new ConfigStore(openDb(':memory:'));
    config.update({ brain: { providers: [{ id: 'muj-claude', label: 'Můj Claude', type: 'oauth-anthropic', baseUrl: '', models: ['claude-opus-4-5'] }] } });
    const auth = { get: (p: string) => (p === 'anthropic' ? { type: 'oauth' } : undefined) } as never;
    expect(brainConfigFromElowen(config, auth)?.providers.map((p) => p.id)).toEqual(['muj-claude']);
  });

  // Disconnecting an account drops only its AuthStorage credential. The entry it leaves behind is a pure
  // model-selection carrier the settings grid hides on purpose, so a surviving one is an unreachable ghost
  // group offering models that can only 401.
  it('drops an oauth entry whose account is no longer connected', () => {
    const config = new ConfigStore(openDb(':memory:'));
    config.update({ brain: { providers: [
      { id: 'anthropic', label: 'Claude account', type: 'oauth-anthropic', baseUrl: '', models: ['claude-opus-4-5'] },
      { id: 'proxy', label: 'Proxy', type: 'openai', baseUrl: 'https://proxy.example.test/v1', models: ['claude-opus-4-5'], apiKey: 'k' },
    ] } });
    const noAccounts = { get: () => undefined } as never;
    // The proxy serving the same model id must survive — it is a different route with its own key.
    expect(brainConfigFromElowen(config, noAccounts)?.providers.map((p) => p.id)).toEqual(['proxy']);
  });

  // The entry is the carrier of the account's model selection, so it must NOT be pruned from storage —
  // reconnecting has to bring the same models back.
  it('restores the same oauth entry once the account reconnects', () => {
    const config = new ConfigStore(openDb(':memory:'));
    config.update({ brain: { providers: [
      { id: 'anthropic', label: 'Claude account', type: 'oauth-anthropic', baseUrl: '', models: ['claude-opus-4-5'] },
    ] } });
    expect(brainConfigFromElowen(config, { get: () => undefined } as never)).toBeNull(); // disconnected
    const reconnected = { get: (p: string) => (p === 'anthropic' ? { type: 'oauth' } : undefined) } as never;
    expect(brainConfigFromElowen(config, reconnected)?.providers.map((p) => p.models)).toEqual([['claude-opus-4-5']]);
  });

  it('uses dedicated brain providers', () => {
    const config = new ConfigStore(openDb(':memory:'));
    config.update({ brain: { providers: [{ id: 'own', label: 'Own', type: 'openai', baseUrl: 'https://x/v1', models: ['m'], apiKey: 'k' }] } });
    expect(brainConfigFromElowen(config)?.providers.map((p) => p.id)).toEqual(['own']);
  });
});

describe('configuredBrainProviders', () => {
  it('carries each provider\'s manual model list, not just its id', () => {
    const config = new ConfigStore(openDb(':memory:'));
    config.update({ brain: { providers: [
      { id: 'coresynth', label: 'Coresynth', type: 'openai', baseUrl: 'https://cs.example/v1', models: ['deepseek/deepseek-v4-flash-vision-exp', 'sarah-nano'], apiKey: 'k' },
      { id: 'catalogue', label: 'Catalogue', type: 'openai', baseUrl: 'https://cat.example/v1', models: [], apiKey: 'k' },
    ] } });
    expect(configuredBrainProviders(config)).toEqual([
      { id: 'coresynth', models: ['deepseek/deepseek-v4-flash-vision-exp', 'sarah-nano'] },
      { id: 'catalogue', models: [] },
    ]);
  });

  // The distinction the whole design rests on, now one level deeper: a provider whose CREDENTIAL is
  // missing has not been deleted, so it keeps both its id AND the model list that bounds it. Losing the
  // list here would silently widen the bound to "any model on that provider" for the duration of an
  // outage — the opposite of what the empty-list catalogue rule is protecting.
  it('keeps the model list of an explicit entry whose oauth account is disconnected', () => {
    const config = new ConfigStore(openDb(':memory:'));
    config.update({ brain: { providers: [
      { id: 'anthropic', label: 'Claude account', type: 'oauth-anthropic', baseUrl: '', models: ['claude-opus-5'] },
    ] } });
    expect(configuredBrainProviders(config, { get: () => undefined } as never))
      .toEqual([{ id: 'anthropic', models: ['claude-opus-5'] }]);
  });

  // A connected account with no entry of its own is served under a synthetic id whose list is empty —
  // i.e. the full account catalogue, exactly as brainConfigFromElowen serves it.
  it('adds a connected oauth account with no explicit entry as a catalogue provider', () => {
    const config = new ConfigStore(openDb(':memory:'));
    const auth = { get: (p: string) => (p === 'anthropic' ? { type: 'oauth' } : undefined) } as never;
    expect(configuredBrainProviders(config, auth)).toEqual([{ id: 'anthropic', models: [] }]);
  });
});
