import { describe, it, expect } from 'vitest';
import { openDb } from '../../src/store/db.js';
import { BrainStore } from '../../src/store/brainStore.js';
import { BrainStatusService } from '../../src/brain/service/statusService.js';
import { ConversationLifecycle } from '../../src/brain/service/lifecycle.js';
import { LiveSessionRegistry } from '../../src/brain/session/liveRegistry.js';
import { ClientAttachments } from '../../src/brain/service/attachments.js';
import { ElicitationRegistry } from '../../src/brain/elicitation.js';
import { CardRegistry } from '../../src/brain/cards.js';
import { PermissionApprovalService } from '../../src/brain/service/permissionApproval.js';
import { registryProviderName, type BrainProviderEntry, type BrainRuntimeConfig } from '../../src/brain/providers.js';
import type { LiveBrain } from '../../src/brain/session/liveBrain.js';

/** Two providers of the two kinds whose identities differ: a custom endpoint, which PI registers under
 *  the internal `elowen-<id>` namespace, and an OAuth account, which resolves to a built-in pi provider. */
const OLLAMA: BrainProviderEntry = {
  id: 'ollama', label: 'Ollama', type: 'openai', baseUrl: 'http://127.0.0.1:11434/v1', models: ['kimi-k2.7-code'], apiKey: null,
};
const CLAUDE: BrainProviderEntry = {
  id: 'claude-account', label: 'Claude', type: 'oauth-anthropic', baseUrl: '', models: [], apiKey: null,
};
const CONFIG: BrainRuntimeConfig = { providers: [OLLAMA, CLAUDE] };

function harness(config: BrainRuntimeConfig | undefined = CONFIG) {
  const store = new BrainStore(openDb(':memory:'));
  const sessions = new LiveSessionRegistry<LiveBrain>();
  const elicitation = new ElicitationRegistry();
  const lifecycle = new ConversationLifecycle({
    store,
    sessions,
    attachments: new ClientAttachments(),
    elicitation,
    // status()/streamSnapshot() never reach spawning, goal continuation or model permissions.
    goals: { cancelGoalContinuation: () => {} } as unknown as ConstructorParameters<typeof ConversationLifecycle>[0]['goals'],
    spawn: () => Promise.reject(new Error('no spawn in this harness')),
    selectionAllowed: () => true,
  });
  const status = new BrainStatusService({
    store,
    sessions,
    attachments: new ClientAttachments(),
    elicitation,
    cards: new CardRegistry(),
    lifecycle,
    permissions: new PermissionApprovalService({ elicitation }),
    config,
    runtime: undefined as unknown as ConstructorParameters<typeof BrainStatusService>[0]['runtime'],
  });
  return { store, sessions, status };
}

/** A live session as the spawner builds it: `providerId` is the operator's config entry, `provider` is
 *  PI's registry name for it — exactly the pair whose confusion put `elowen-ollama` on the statusline. */
function live(sessions: LiveSessionRegistry<LiveBrain>, sessionId: string, entry: BrainProviderEntry, model: string): void {
  sessions.set(sessionId, {
    sessionId, model, providerId: entry.id, provider: registryProviderName(entry),
    requestProfile: { fast: false },
    replay: { transportSnapshot: () => ({ cursor: 0, events: [], run: 0, eventCursors: [] }) },
    session: {
      getContextUsage: () => undefined, messages: [],
      getSteeringMessages: () => [], getFollowUpMessages: () => [],
    },
  } as unknown as LiveBrain);
}

describe('status/snapshot provider identity', () => {
  // The reported symptom: a custom endpoint configured as `ollama` showed up as `elowen-ollama` in the
  // CLI statusline and the web chat header, because status reported PI's registry name.
  // Mutation: report `b.provider` as `provider` again and this reads `elowen-ollama` with no label.
  it('reports a custom provider by its config id and label, never the registry namespace', () => {
    const { store, sessions, status } = harness();
    store.createSession({ id: 'brain-1', userId: 1, model: 'kimi-k2.7-code', provider: 'ollama' });
    live(sessions, 'brain-1', OLLAMA, 'kimi-k2.7-code');

    const view = status.status(1, 'brain-1');
    expect(view.provider).toBe('ollama');
    expect(view.providerLabel).toBe('Ollama');
    // …while the internal name stays available under its own field, which is what the subscription-usage
    // map is keyed by. Collapsing the two is the whole bug.
    expect(view.usageProvider).toBe('elowen-ollama');
  });

  // An OAuth entry's config id and its pi provider are genuinely different names, and the rate-limit
  // route keys on the pi one. Nothing here may translate it into the config id.
  it('keeps the built-in pi provider as the usage key for an OAuth entry', () => {
    const { store, sessions, status } = harness();
    store.createSession({ id: 'brain-1', userId: 1, model: 'claude-opus-5', provider: 'claude-account' });
    live(sessions, 'brain-1', CLAUDE, 'claude-opus-5');

    const view = status.status(1, 'brain-1');
    expect(view.provider).toBe('claude-account');
    expect(view.providerLabel).toBe('Claude');
    expect(view.usageProvider).toBe('anthropic');
  });

  // A cold conversation has no live session, so the identity comes from the stored row — which records
  // the config id. It must still resolve its label instead of degrading to a bare id.
  it('labels a conversation that has no live session from its stored provider', () => {
    const { store, status } = harness();
    store.createSession({ id: 'brain-1', userId: 1, model: 'kimi-k2.7-code', provider: 'ollama' });

    expect(status.status(1, 'brain-1')).toMatchObject({
      running: false, provider: 'ollama', providerLabel: 'Ollama', usageProvider: '',
    });
  });

  // A provider deleted in Settings leaves stored rows behind. The id is what the row holds and stays
  // readable; only the label is unknown. Showing nothing at all would make the row unattributable.
  it('keeps the stored id and an empty label when the provider is gone from config', () => {
    const { store, status } = harness({ providers: [CLAUDE] });
    store.createSession({ id: 'brain-1', userId: 1, model: 'kimi-k2.7-code', provider: 'ollama' });

    expect(status.status(1, 'brain-1')).toMatchObject({ provider: 'ollama', providerLabel: '' });
  });

  // The drill-in snapshot is the other frame a client renders a model line from, so it carries the same
  // split. A sub-agent on a custom provider must not reintroduce the namespace through this path.
  it('applies the same split to the stream snapshot frame', () => {
    const { store, sessions, status } = harness();
    store.createSession({ id: 'brain-1', userId: 1, model: 'kimi-k2.7-code', provider: 'ollama' });
    live(sessions, 'brain-1', OLLAMA, 'kimi-k2.7-code');

    expect(status.streamSnapshot(1, 'brain-1').session).toEqual({
      model: 'kimi-k2.7-code', provider: 'ollama', providerLabel: 'Ollama', usageProvider: 'elowen-ollama',
    });
  });
});
