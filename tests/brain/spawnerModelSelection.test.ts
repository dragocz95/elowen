import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { AgentSession, ModelRuntime } from '@earendil-works/pi-coding-agent';
import { LiveSessionSpawner } from '../../src/brain/service/spawner.js';
import { inMemoryModelRuntime } from '../../src/brain/providers.js';
import type { Policy } from '../../src/plugins/policy.js';
import { openDb } from '../../src/store/db.js';
import { BrainStore } from '../../src/store/brainStore.js';
import type { SpawnOpts } from '../../src/brain/session/liveBrain.js';

/** The spawner's chat-model selection fallback (spawner.ts): with an EMPTY `opts.selection` the session
 *  must land on the owner's per-user model choice (Account → Model), NOT on cfg.providers[0].models[0] —
 *  config list order — which once dropped a session on gpt-image-2, an image-only model that cannot hold
 *  a conversation. The explicit-selection path must stay untouched. */
let sharedRuntime: ModelRuntime;
beforeAll(async () => { sharedRuntime = await inMemoryModelRuntime(); });

const policy: Policy = { allowedProjectIds: 'all', allowedPaths: () => [] };

// The first provider's first model is the image-only one — the exact shape of the original bug. A user
// override pointing at the SECOND provider's model only wins when the fallback actually consults settings.
function makeSpawner(settings: { model?: string; modelProvider?: string }) {
  const listeners: ((e: unknown) => void)[] = [];
  const fakeSession = {
    sessionId: 'sess-1',
    subscribe: (l: (e: unknown) => void) => { listeners.push(l); return () => {}; },
  };
  const create = vi.fn(async () => ({
    session: fakeSession as unknown as AgentSession,
    applyCompaction: vi.fn(),
  }));
  const spawner = new LiveSessionSpawner({
    config: { providers: [
      { id: 'img', label: 'Images', type: 'openai' as const, baseUrl: 'http://img.example/v1', models: ['gpt-image-2'], apiKey: 'k' },
      { id: 'relay', label: 'Relay', type: 'openai' as const, baseUrl: 'http://relay.example/v1', models: ['gpt-5', 'gpt-5.5'], apiKey: 'k' },
    ] },
    store: new BrainStore(openDb(':memory:')),
    runtime: sharedRuntime,
    users: { ensureAdvisorToken: () => 'token', get: () => ({ name: 'Filip', username: 'filip' }) },
    prompts: { render: () => 'PERSONA' },
    url: 'http://x',
    userSettings: () => settings,
    plugins: async () => undefined,
    factory: { create },
    sessionTaps: () => [],
  });
  const spawn = (selection: SpawnOpts['selection']) => spawner.spawn({
    sessionId: 'sess-1', ownerUserId: 1, selection, policy,
    autoCompact: false, autoCompactAtPct: 80,
  });
  return { spawn, create };
}

describe('LiveSessionSpawner — chat-model selection fallback', () => {
  it('uses the owner\'s configured default model when the selection is empty', async () => {
    const { spawn, create } = makeSpawner({ model: 'gpt-5.5', modelProvider: 'relay' });

    const live = await spawn({});

    expect(live.model).toBe('gpt-5.5');
    expect(live.providerId).toBe('relay');
    const spec = create.mock.calls[0]?.[0] as { model: { id: string }; providerId: string };
    expect(spec.model.id).toBe('gpt-5.5');
    expect(spec.providerId).toBe('relay');
  });

  it('lets an explicit selection win over the saved default — even a partial one', async () => {
    const { spawn } = makeSpawner({ model: 'gpt-5.5', modelProvider: 'relay' });

    const full = await spawn({ provider: 'img', model: 'gpt-image-2' });
    expect(full.model).toBe('gpt-image-2');
    expect(full.providerId).toBe('img');

    // Any content at all in the selection beats the settings: a bare provider resolves to ITS first
    // model, not to the user's saved pick.
    const partial = await spawn({ provider: 'relay' });
    expect(partial.model).toBe('gpt-5');
    expect(partial.providerId).toBe('relay');
  });

  // A stored preference pointing at a deleted provider must not lock the account out of its own
  // conversation: the session opens on the instance default and says so in the log. The stored row is left
  // alone on purpose — re-adding the provider restores the choice, and rewriting it here would spend the
  // user's configuration on what may be a temporary state. An EXPLICIT selection gets the opposite
  // treatment (providers.test.ts): naming a dead provider throws rather than silently running elsewhere.
  it('starts on the default when the saved preference names a provider that is gone', async () => {
    const { spawn, create } = makeSpawner({ model: 'qwen3.8-max-preview', modelProvider: 'alibaba' });

    const live = await spawn({});

    expect(live.providerId).toBe('img');
    expect(live.model).toBe('gpt-image-2');
    // Crucially NOT the dead provider's model id smuggled onto another provider's credentials.
    const spec = create.mock.calls[0]?.[0] as { model: { id: string }; providerId: string };
    expect(spec.model.id).toBe('gpt-image-2');
    expect(spec.providerId).toBe('img');
  });

  // Same rule for the model half: the provider is still there, but the operator removed THIS model from
  // its list in Settings. A custom endpoint would otherwise register the stale id ad hoc and run a model
  // the installation no longer offers — the account's picker shows one set, its session runs outside it.
  it('starts on the default when the saved preference names a model the provider no longer lists', async () => {
    const { spawn, create } = makeSpawner({ model: 'gpt-4o-mini', modelProvider: 'relay' });

    const live = await spawn({});

    expect(live.providerId).toBe('img');
    expect(live.model).toBe('gpt-image-2');
    const spec = create.mock.calls[0]?.[0] as { model: { id: string }; providerId: string };
    expect(spec.model.id).toBe('gpt-image-2');
  });

  it('keeps a saved preference the provider still lists', async () => {
    const { spawn } = makeSpawner({ model: 'gpt-5.5', modelProvider: 'relay' });
    expect((await spawn({})).model).toBe('gpt-5.5');
  });

  it('falls back to the config default when neither selection nor settings are set', async () => {
    const { spawn } = makeSpawner({ model: '', modelProvider: '' });

    const live = await spawn({});

    expect(live.model).toBe('gpt-image-2');
    expect(live.providerId).toBe('img');
  });

  it('ignores a model without its provider (empty provider = unset)', async () => {
    const { spawn } = makeSpawner({ model: 'gpt-5.5', modelProvider: '' });

    const live = await spawn({});

    expect(live.model).toBe('gpt-image-2');
    expect(live.providerId).toBe('img');
  });
});
