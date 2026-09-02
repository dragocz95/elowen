import { afterEach, describe, expect, it, vi } from 'vitest';
import { InlineArtifactRegistry } from '../../src/brain/inlineArtifacts.js';
import { CardRegistry } from '../../src/brain/cards.js';
import type { BrainEvent, PluginChatArtifact } from '../../src/brain/events.js';
import type { PluginChatArtifactRef } from '../../src/plugins/api.js';
import { PluginRegistry, type PluginHostWiring } from '../../src/plugins/registry.js';
import { runWithPolicy } from '../../src/plugins/policyContext.js';
import { openDb } from '../../src/store/db.js';
import { BrainStore } from '../../src/store/brainStore.js';
import { BrainStatusService } from '../../src/brain/service/statusService.js';
import { ConversationLifecycle } from '../../src/brain/service/lifecycle.js';
import { LiveSessionRegistry } from '../../src/brain/session/liveRegistry.js';
import { ClientAttachments } from '../../src/brain/service/attachments.js';
import { ElicitationRegistry } from '../../src/brain/elicitation.js';
import { PermissionApprovalService } from '../../src/brain/service/permissionApproval.js';
import type { LiveBrain } from '../../src/brain/session/liveBrain.js';

const POLICY = { allowedProjectIds: 'all' as const, allowedPaths: () => [] };
const LOG = { info() {}, warn() {}, error() {} };
const registries: InlineArtifactRegistry[] = [];

afterEach(() => {
  for (const registry of registries.splice(0)) registry.dispose();
  vi.useRealTimers();
});

function artifact(overrides: Partial<PluginChatArtifact> = {}): PluginChatArtifact {
  return {
    id: 'session-view',
    view: 'live-session',
    fallback: 'Live session is active.',
    data: { status: 'ready', count: 1 },
    media: { transport: 'sse', path: '/plugins/demo/api/sessions/one/stream' },
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    ...overrides,
  };
}

function setup(now: () => number = Date.now) {
  const store = new BrainStore(openDb(':memory:'));
  store.createSession({ id: 'brain-1', userId: 1, model: 'm' });
  store.createSession({ id: 'brain-2', userId: 1, model: 'm' });
  const events: BrainEvent[] = [];
  const registry = new InlineArtifactRegistry(
    () => store,
    (_sessionId, value) => events.push({ type: 'inline_artifact', artifact: value }),
    now,
  );
  registries.push(registry);
  return { store, registry, events };
}

function contextWithArtifacts(plugin: string, lifecycle: InlineArtifactRegistry) {
  const host: PluginHostWiring = {
    chatArtifacts: {
      open: (name, sessionId, toolCallId, value) => lifecycle.open(name, sessionId, toolCallId, value),
      update: (name, ref, update) => lifecycle.update(name, ref, update),
      close: (name, ref) => lifecycle.close(name, ref),
    },
  };
  const plugins = new PluginRegistry();
  const args = [plugin, {}, LOG] as unknown as Parameters<PluginRegistry['contextFor']>;
  args[25] = host;
  return { plugins, context: plugins.contextFor(...args) };
}

describe('inline plugin artifact normalization and persistence', () => {
  it('keeps BrainCard storage behavior independent from artifact lifecycle', () => {
    const { store, registry } = setup();
    const cards = new CardRegistry(() => store);
    cards.set('brain-1', { id: 'todos', pinned: true, items: [{ text: 'Ship it', status: 'in_progress' }] });

    const ref = registry.open('demo', 'brain-1', 'call-1', artifact());
    registry.close('demo', ref);

    expect(cards.forSession('brain-1')).toEqual([
      { id: 'todos', title: undefined, pinned: true, items: [{ text: 'Ship it', status: 'in_progress' }], body: undefined },
    ]);
    expect(registry.forSession('brain-1')).toEqual([]);
  });

  it('round-trips through SQLite and preserves the durable tool-call anchor', () => {
    const { store, registry } = setup();
    const ref = registry.open('demo', 'brain-1', 'call-42', artifact());
    const restarted = new InlineArtifactRegistry(() => store);
    registries.push(restarted);

    expect(JSON.parse(JSON.stringify(ref))).toEqual(ref);
    expect(restarted.forSession('brain-1')).toEqual([
      expect.objectContaining({
        id: 'session-view', plugin: 'demo', sessionId: 'brain-1', toolCallId: 'call-42',
        view: 'live-session', status: 'open', data: { status: 'ready', count: 1 },
      }),
    ]);

    // Core may re-key a conversation while the plugin keeps this ref in its own durable metadata. The
    // immutable ref scope still authorizes the row, while hydration follows the transcript's new id.
    store.reassignSession('brain-1', 'brain-archived');
    registry.update('demo', ref, { data: { status: 'moved' } });
    expect(restarted.forSession('brain-archived')).toEqual([
      expect.objectContaining({ sessionId: 'brain-archived', data: { status: 'moved' } }),
    ]);
  });

  it('rejects oversized, deep, non-JSON and cross-plugin media payloads', () => {
    const { registry } = setup();
    let deep: unknown = 'leaf';
    for (let i = 0; i < 10; i += 1) deep = { child: deep };

    expect(() => registry.open('demo', 'brain-1', 'call-deep', artifact({ id: 'deep', data: deep as never })))
      .toThrow('depth');
    expect(() => registry.open('demo', 'brain-1', 'call-large', artifact({ id: 'large', data: 'x'.repeat(40_000) })))
      .toThrow('string exceeds');
    expect(() => registry.open('demo', 'brain-1', 'call-number', artifact({ id: 'number', data: Number.NaN })))
      .toThrow('non-finite');
    expect(() => registry.open('demo', 'brain-1', 'call-object', artifact({ id: 'object', data: new Date() as never })))
      .toThrow('non-plain');
    expect(() => registry.open('demo', 'brain-1', 'call-media', artifact({
      id: 'media', media: { transport: 'sse', path: '/plugins/other/api/stream' },
    }))).toThrow('/plugins/demo/api/');
  });
});

describe('PluginContext chatArtifacts authority', () => {
  it('host-stamps the plugin and uses the execute toolCallId explicitly', async () => {
    const { registry } = setup();
    const { plugins, context } = contextWithArtifacts('demo', registry);
    let ref: PluginChatArtifactRef | undefined;
    context.registerTool({
      name: 'ArtifactOpen',
      label: 'ArtifactOpen',
      description: 'Open an artifact',
      parameters: { type: 'object', properties: {} },
      execute: async (toolCallId: string) => {
        ref = context.chatArtifacts.open(toolCallId, artifact());
        return { content: [{ type: 'text' as const, text: 'opened' }], details: {} };
      },
    } as never);

    await runWithPolicy(POLICY, () => plugins.tools[0]!.execute('call-from-execute', {} as never), {
      sessionId: 'brain-1',
    });

    expect(ref).toBeDefined();
    expect(registry.forSession('brain-1')).toEqual([
      expect.objectContaining({
        id: 'session-view', plugin: 'demo', toolCallId: 'call-from-execute', sessionId: 'brain-1',
      }),
    ]);
  });

  it('rejects opens outside a turn and isolates token, plugin and session on update/close', () => {
    const { registry, events } = setup();
    const demo = contextWithArtifacts('demo', registry).context;
    const other = contextWithArtifacts('other', registry).context;

    expect(() => demo.chatArtifacts.open('call-1', artifact())).toThrow('conversation tool call');
    const ref = runWithPolicy(POLICY, () => demo.chatArtifacts.open('call-1', artifact()), { sessionId: 'brain-1' });

    expect(() => other.chatArtifacts.update(ref, { data: { status: 'stolen' } })).toThrow('invalid inline artifact reference');
    expect(() => demo.chatArtifacts.update({ ...ref, token: `${ref.token}x` }, { data: { status: 'stolen' } }))
      .toThrow('invalid inline artifact reference');
    expect(() => demo.chatArtifacts.close({ ...ref, sessionId: 'brain-2' }))
      .toThrow('invalid inline artifact reference');

    const updated = demo.chatArtifacts.update(ref, { data: { status: 'running' }, fallback: 'Session is running.' });
    expect(updated).toMatchObject({ plugin: 'demo', toolCallId: 'call-1', data: { status: 'running' } });
    demo.chatArtifacts.close(ref);

    expect(registry.forSession('brain-1')).toEqual([]);
    expect(events.map((event) => event.type === 'inline_artifact' ? event.artifact.status : '')).toEqual([
      'open', 'open', 'closed',
    ]);
  });
});

describe('expiry, live events and status hydration', () => {
  it('core expiry deletes durable state and publishes a live tombstone without plugin participation', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_000));
    const { registry, events } = setup();
    registry.open('demo', 'brain-1', 'call-expiring', artifact({
      expiresAt: new Date(1_500).toISOString(),
    }));
    expect(registry.forSession('brain-1')).toHaveLength(1);

    vi.advanceTimersByTime(500);
    expect(registry.forSession('brain-1')).toEqual([]);
    expect(events.at(-1)).toEqual({
      type: 'inline_artifact',
      artifact: {
        id: 'session-view', plugin: 'demo', sessionId: 'brain-1', toolCallId: 'call-expiring',
        status: 'closed', reason: 'expired',
      },
    });
  });

  it('hydrates open artifacts in status separately from BrainCards', () => {
    const { store, registry } = setup();
    registry.open('demo', 'brain-1', 'call-status', artifact());
    const sessions = new LiveSessionRegistry<LiveBrain>();
    const elicitation = new ElicitationRegistry();
    const lifecycle = new ConversationLifecycle({
      store,
      sessions,
      attachments: new ClientAttachments(),
      elicitation,
      goals: { cancelGoalContinuation() {} } as never,
      spawn: () => Promise.reject(new Error('not used')),
      selectionAllowed: () => true,
    });
    const status = new BrainStatusService({
      store,
      sessions,
      attachments: new ClientAttachments(),
      elicitation,
      cards: new CardRegistry(() => store),
      artifacts: registry,
      lifecycle,
      permissions: new PermissionApprovalService({ elicitation }),
      config: undefined,
      runtime: undefined as never,
    });

    expect(status.status(1, 'brain-1').artifacts).toEqual([
      expect.objectContaining({ id: 'session-view', plugin: 'demo', toolCallId: 'call-status' }),
    ]);
    expect(status.status(1, 'brain-1').cards).toEqual([]);
  });
});
