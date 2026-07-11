import { describe, expect, it, vi } from 'vitest';
import { ConversationLifecycle } from '../../src/brain/service/lifecycle.js';
import { ClientAttachments } from '../../src/brain/service/attachments.js';
import { LiveSessionRegistry } from '../../src/brain/session/liveRegistry.js';
import type { LiveBrain, SpawnOpts } from '../../src/brain/session/liveBrain.js';

function live(spec: { provider?: string; model: string; thinkingLevel?: string; fast?: boolean }): LiveBrain {
  return {
    session: { dispose: vi.fn(), isStreaming: false } as never,
    sessionId: 'brain-1',
    providerId: spec.provider,
    model: spec.model,
    thinkingLevel: spec.thinkingLevel,
    requestProfile: { fast: spec.fast === true },
    fastAvailable: spec.provider === 'codex',
    thinkingLabels: {},
    policy: { allowedProjectIds: 'all', allowedPaths: () => [] },
    listeners: new Set(),
    replay: { publish: vi.fn() } as never,
    turnContext: () => '',
    pluginToolNames: new Set(),
  };
}

describe('ConversationLifecycle vision fallback', () => {
  it('temporarily clears Fast, then restores the exact provider/model/reasoning/Fast profile', async () => {
    const sessions = new LiveSessionRegistry<LiveBrain>();
    const original = live({ provider: 'codex', model: 'gpt-main', thinkingLevel: 'max', fast: true });
    const listener = vi.fn();
    original.listeners.add(listener);
    sessions.set('brain-1', original);

    const spawn = vi.fn(async (opts: SpawnOpts) => {
      const next = live({
        provider: opts.selection.provider,
        model: opts.selection.model ?? 'default',
        thinkingLevel: opts.thinkingLevel,
        fast: opts.fast,
      });
      return next;
    });
    const lifecycle = new ConversationLifecycle({
      store: { getSession: () => ({ id: 'brain-1', user_id: 1, work_dir: '' }) },
      sessions,
      attachments: new ClientAttachments(),
      elicitation: { cancelForSession: vi.fn() },
      goals: { cancelGoalContinuation: vi.fn() },
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
      selection: { provider: 'vision-relay', model: 'vision-model' }, fast: false,
    });
    expect(fallback).toMatchObject({
      providerId: 'vision-relay', model: 'vision-model', visionFallback: true,
      visionFallbackReturn: { provider: 'codex', model: 'gpt-main', thinkingLevel: 'max', fast: true },
    });
    expect(fallback.listeners.has(listener)).toBe(true);

    const restored = await lifecycle.maybeVisionHop(1, fallback, false);
    expect(spawn.mock.calls[1]![0]).toMatchObject({
      selection: { provider: 'codex', model: 'gpt-main' }, thinkingLevel: 'max', fast: true,
    });
    expect(restored).toMatchObject({ providerId: 'codex', model: 'gpt-main', thinkingLevel: 'max' });
    expect(restored.requestProfile.fast).toBe(true);
    expect(restored.listeners.has(listener)).toBe(true);
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
      goals: { cancelGoalContinuation: vi.fn() },
      spawn: async () => live({ provider: 'wrong-provider', model: 'shared-id' }),
      policy: () => ({ allowedProjectIds: 'all', allowedPaths: () => [] }),
      userSettings: () => ({ visionModelProvider: 'vision-provider', visionModel: 'shared-id' }),
      selectionAllowed: () => true,
    } as never);

    const result = await lifecycle.maybeVisionHop(1, original, true);
    expect(result.visionFallback).toBe(false);
    expect(result.visionFallbackReturn).toBeUndefined();
  });
});
