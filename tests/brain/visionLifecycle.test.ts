import { describe, expect, it, vi } from 'vitest';
import { ConversationLifecycle } from '../../src/brain/service/lifecycle.js';
import { ClientAttachments } from '../../src/brain/service/attachments.js';
import { LiveSessionRegistry } from '../../src/brain/session/liveRegistry.js';
import type { LiveBrain, SpawnOpts } from '../../src/brain/session/liveBrain.js';

/** `provider` is the CONFIG entry id (`LiveBrain.providerId`); `registryProvider` is PI's name for it
 *  (`LiveBrain.provider`). They default to the same string because these fixtures are OAuth-style
 *  entries, where the operator's id IS the pi provider — the vision-hop test below sets them apart
 *  deliberately, which is the only shape that can catch the two being confused. */
function live(spec: { provider?: string; registryProvider?: string; model: string; thinkingLevel?: string }): LiveBrain {
  return {
    session: { dispose: vi.fn(), isStreaming: false } as never,
    sessionId: 'brain-1',
    providerId: spec.provider,
    provider: spec.registryProvider ?? spec.provider ?? '',
    model: spec.model,
    thinkingLevel: spec.thinkingLevel,
    requestProfile: {},
    fastAvailable: spec.provider === 'codex',
    thinkingLabels: {},
    policy: { allowedProjectIds: 'all', allowedPaths: () => [] },
    listeners: new Set(),
    replay: { publish: vi.fn() } as never,
    turnContext: () => ({ beforeUser: '', afterUser: '' }),
    pluginToolNames: new Set(),
  };
}

describe('ConversationLifecycle vision fallback', () => {
  it('lets each vision route decide Fast without copying a session-local flag', async () => {
    const sessions = new LiveSessionRegistry<LiveBrain>();
    const attachments = new ClientAttachments();
    const original = live({ provider: 'codex', model: 'gpt-main', thinkingLevel: 'max' });
    sessions.set('brain-1', original);
    const listener = vi.fn();
    // Listener ownership lives in ClientAttachments (attach()), not on the transient LiveBrain — this is
    // what subscribe()/tapSession() do.
    attachments.attach(1, 'brain-1', listener, vi.fn());

    const spawn = vi.fn(async (opts: SpawnOpts) => {
      const next = live({
        provider: opts.selection.provider,
        model: opts.selection.model ?? 'default',
        thinkingLevel: opts.thinkingLevel,
      });
      // Mirrors LiveSessionSpawner: every respawn restores whatever ClientAttachments still has attached
      // to this session id — the hop keeps the same id, so the listener stays registered throughout.
      for (const l of attachments.sessionTaps.get(opts.sessionId) ?? []) next.listeners.add(l);
      return next;
    });
    const lifecycle = new ConversationLifecycle({
      store: { getSession: () => ({ id: 'brain-1', user_id: 1, work_dir: '' }) },
      sessions,
      attachments,
      elicitation: { cancelForSession: vi.fn() },
      goals: { cancelGoalContinuation: vi.fn(), resumeAfterRespawn: vi.fn(), pauseForRespawnFailure: vi.fn() },
      spawn,
      policy: () => ({ allowedProjectIds: 'all', allowedPaths: () => [] }),
      userSettings: () => ({
        visionModelProvider: 'vision-relay', visionModel: 'vision-model', thinkingLevel: 'low',
        autoCompact: false, autoCompactAt: 80,
      }),
      selectionAllowed: () => true,
    } as never);

    const fallback = await lifecycle.maybeVisionHop(1, original, true);
    expect(spawn.mock.calls[0]![0]).toMatchObject({
      selection: { provider: 'vision-relay', model: 'vision-model' },
    });
    expect(spawn.mock.calls[0]![0]).not.toHaveProperty('fast');
    expect(fallback).toMatchObject({
      providerId: 'vision-relay', model: 'vision-model', visionFallback: true,
      visionFallbackReturn: { provider: 'codex', model: 'gpt-main', thinkingLevel: 'max' },
    });
    expect(fallback.listeners.has(listener)).toBe(true);

    const restored = await lifecycle.maybeVisionHop(1, fallback, false);
    expect(spawn.mock.calls[1]![0]).toMatchObject({
      selection: { provider: 'codex', model: 'gpt-main' }, thinkingLevel: 'max',
    });
    expect(spawn.mock.calls[1]![0]).not.toHaveProperty('fast');
    expect(restored).toMatchObject({ providerId: 'codex', model: 'gpt-main', thinkingLevel: 'max' });
    expect(restored.listeners.has(listener)).toBe(true);
  });

  // Real report: a photo sent while the conversation ran on claude-opus-5 was answered by the configured
  // qwen fallback. The catalog knows opus reads images, so there was nothing to fall back FROM — the turn
  // was handed to a weaker model, and the respawn dropped the conversation's warm cache with it.
  it('leaves a vision-capable model alone instead of handing its image turn to the fallback', async () => {
    const sessions = new LiveSessionRegistry<LiveBrain>();
    const original = live({ provider: 'anthropic', model: 'claude-opus-5' });
    sessions.set('brain-1', original);
    const spawn = vi.fn(async () => live({ provider: 'alibaba', model: 'qwen3.8-max' }));
    const lifecycle = new ConversationLifecycle({
      store: { getSession: () => ({ id: 'brain-1', user_id: 1, work_dir: '' }) },
      sessions,
      attachments: new ClientAttachments(),
      elicitation: { cancelForSession: vi.fn() },
      goals: { cancelGoalContinuation: vi.fn(), resumeAfterRespawn: vi.fn(), pauseForRespawnFailure: vi.fn() },
      spawn,
      policy: () => ({ allowedProjectIds: 'all', allowedPaths: () => [] }),
      userSettings: () => ({ visionModelProvider: 'alibaba', visionModel: 'qwen3.8-max' }),
      selectionAllowed: () => true,
    } as never);

    const result = await lifecycle.maybeVisionHop(1, original, true);
    expect(spawn).not.toHaveBeenCalled();
    expect(result).toBe(original);
  });

  it('does not mark fallback active when provider resolution lands on another provider with the same model id', async () => {
    const sessions = new LiveSessionRegistry<LiveBrain>();
    const original = live({ provider: 'main', model: 'text' });
    sessions.set('brain-1', original);
    const lifecycle = new ConversationLifecycle({
      store: { getSession: () => ({ id: 'brain-1', user_id: 1, work_dir: '' }) },
      sessions,
      attachments: new ClientAttachments(),
      elicitation: { cancelForSession: vi.fn() },
      goals: { cancelGoalContinuation: vi.fn(), resumeAfterRespawn: vi.fn(), pauseForRespawnFailure: vi.fn() },
      spawn: async () => live({ provider: 'wrong-provider', model: 'shared-id' }),
      policy: () => ({ allowedProjectIds: 'all', allowedPaths: () => [] }),
      userSettings: () => ({ visionModelProvider: 'vision-provider', visionModel: 'shared-id' }),
      selectionAllowed: () => true,
    } as never);

    const result = await lifecycle.maybeVisionHop(1, original, true);
    expect(result.visionFallback).toBe(false);
    expect(result.visionFallbackReturn).toBeUndefined();
  });

  // configStore only rejects `/` in a provider id, so an operator may name a custom endpoint
  // `elowen-openrouter`. PI then registers it as `elowen-elowen-openrouter`, and the catalog helpers
  // strip exactly one namespace. Asking them with the CONFIG id strips it to `openrouter` and answers
  // out of OpenRouter's own rows: `perplexity/sonar` reads images THERE, so the hop was skipped and a
  // text-only endpoint got the photo. Asked with the REGISTRY id the name stays the operator's own,
  // which no catalog knows, and the model resolves through its upstream namespace to text-only.
  // Mutation: pass `b.providerId` into catalogModelVision again and this stops hopping.
  it('resolves vision from the registry id, so an `elowen-`-prefixed config id cannot borrow another vendor', async () => {
    const sessions = new LiveSessionRegistry<LiveBrain>();
    const original = live({
      provider: 'elowen-openrouter', registryProvider: 'elowen-elowen-openrouter', model: 'perplexity/sonar',
    });
    sessions.set('brain-1', original);
    const spawn = vi.fn(async () => live({ provider: 'alibaba', model: 'qwen3.8-max' }));
    const lifecycle = new ConversationLifecycle({
      store: { getSession: () => ({ id: 'brain-1', user_id: 1, work_dir: '' }) },
      sessions,
      attachments: new ClientAttachments(),
      elicitation: { cancelForSession: vi.fn() },
      goals: { cancelGoalContinuation: vi.fn(), resumeAfterRespawn: vi.fn(), pauseForRespawnFailure: vi.fn() },
      spawn,
      policy: () => ({ allowedProjectIds: 'all', allowedPaths: () => [] }),
      userSettings: () => ({ visionModelProvider: 'alibaba', visionModel: 'qwen3.8-max' }),
      selectionAllowed: () => true,
    } as never);

    await lifecycle.maybeVisionHop(1, original, true);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn.mock.calls[0]![0]).toMatchObject({ selection: { provider: 'alibaba', model: 'qwen3.8-max' } });
  });
});
