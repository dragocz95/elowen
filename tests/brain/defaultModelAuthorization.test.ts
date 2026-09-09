import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { AgentSession, ModelRuntime } from '@earendil-works/pi-coding-agent';
import { LiveSessionSpawner } from '../../src/brain/service/spawner.js';
import { inMemoryModelRuntime } from '../../src/brain/providers.js';
import type { Policy } from '../../src/plugins/policy.js';
import { openDb } from '../../src/store/db.js';
import { BrainStore } from '../../src/store/brainStore.js';
import type { SpawnOpts } from '../../src/brain/session/liveBrain.js';

/** The audit case: a non-admin account whose allow-list carries exactly one cheap model was spawned onto
 *  the instance default and billed for it, while the explicit /model path refused the very same pair.
 *  The hole is structural — `selectionAllowed` judges only a NAMED pair, so an empty selection passes the
 *  gate and the provider layer then resolves it to the admin default nobody checked.
 *
 *  Driven through the REAL spawner rather than one caller, because the first version of this guard lived
 *  in `ConversationLifecycle.ensureLive` and two spawn paths simply did not go through it: a platform
 *  channel spawn passes `opts.model ?? {}`, and the `/clear` respawn repeats the disposed session's own
 *  provider and model. Both reach `LiveSessionSpawner.spawn`, which is where the check now lives. What is
 *  asserted is the pair the session is actually CREATED with. */
let sharedRuntime: ModelRuntime;
beforeAll(async () => { sharedRuntime = await inMemoryModelRuntime(); });

const policy: Policy = { allowedProjectIds: 'all', allowedPaths: () => [] };

/** `expensive/claude-sonnet-5` is the instance default — the first model of the first provider, which is
 *  what an empty or half-filled selection resolves to. `cheap/glm-5.3-flash` is the pair a restricted
 *  account may actually run. */
function makeSpawner(opts: {
  allowed: string[];
  fallback?: { provider: string; model: string } | null;
  settings?: (userId: number) => { model?: string; modelProvider?: string } | undefined;
  wired?: boolean;
}) {
  // The parameter is declared so the spec accessor below can read the spawn spec the factory was handed.
  const create = vi.fn(async (_spec: unknown) => ({
    session: { sessionId: 'sess-1', subscribe: () => () => {} } as unknown as AgentSession,
    applyCompaction: vi.fn(),
  }));
  const store = new BrainStore(openDb(':memory:'));
  store.createSession({ id: 'sess-1', userId: 15, title: 'T', model: 'm' });
  const judged: number[] = [];
  const authorization = opts.wired === false ? {} : {
    selectionAllowed: (userId: number, sel?: { provider?: string; model?: string }) => {
      judged.push(userId);
      // The real predicate's contract: a partial selection names no pair, so it is allowed by definition.
      if (!sel?.provider || !sel.model) return true;
      return opts.allowed.includes(`${sel.provider}/${sel.model}`);
    },
    allowedFallbackSelection: (userId: number) => {
      judged.push(userId);
      return opts.fallback === undefined ? null : opts.fallback;
    },
  };
  const spawner = new LiveSessionSpawner({
    config: { providers: [
      { id: 'expensive', label: 'Expensive', type: 'openai' as const, baseUrl: 'http://a.example/v1', models: ['claude-sonnet-5'], apiKey: 'k' },
      { id: 'cheap', label: 'Cheap', type: 'openai' as const, baseUrl: 'http://b.example/v1', models: ['glm-5.3-flash'], apiKey: 'k' },
    ] },
    store,
    runtime: sharedRuntime,
    users: { ensureAdvisorToken: () => 'token', get: () => ({ name: 'Filip', username: 'filip' }) },
    toolAuthorityFor: () => undefined,
    prompts: { render: () => 'PERSONA' },
    url: 'http://x',
    userSettings: opts.settings ?? (() => undefined),
    ...authorization,
    plugins: async () => undefined,
    factory: { create },
    sessionTaps: () => [],
  } as never);
  const spawn = (selection: SpawnOpts['selection'], extra?: Partial<SpawnOpts>) => spawner.spawn({
    sessionId: 'sess-1', ownerUserId: 15, selection, policy, autoCompact: false, ...extra,
  } as SpawnOpts);
  const spec = () => create.mock.calls.at(-1)![0] as unknown as { model: { id: string }; providerId: string };
  return { spawn, create, spec, judged };
}

describe('spawn-time default model authorization', () => {
  it('refuses the instance default for an empty selection and runs the pair the account may use', async () => {
    const { spawn, spec } = makeSpawner({
      allowed: ['cheap/glm-5.3-flash'],
      fallback: { provider: 'cheap', model: 'glm-5.3-flash' },
    });

    const live = await spawn({});

    expect(spec().providerId).toBe('cheap');
    expect(spec().model.id).toBe('glm-5.3-flash');
    expect(live.model).toBe('glm-5.3-flash');
  });

  /** channels.ts spawns a platform conversation with `selection: opts.model ?? {}` — empty whenever the
   *  room has no `/model` pin, which is the ordinary case. */
  it('authorizes a direct platform channel spawn, which passes an empty selection', async () => {
    const { spawn, spec, judged } = makeSpawner({
      allowed: ['cheap/glm-5.3-flash'],
      fallback: { provider: 'cheap', model: 'glm-5.3-flash' },
    });

    await spawn({}, { channel: true, direct: true, settingsUserId: 15 });

    expect(spec().providerId).toBe('cheap');
    expect(spec().model.id).toBe('glm-5.3-flash');
    expect(judged).toContain(15);
  });

  /** The room's model choice and its bill belong to the account whose settings composed the session, so
   *  that is the allow-list the pair is judged against — not the opener's, when a writer is named. */
  it('judges a room against the account whose settings and bill it runs on', async () => {
    const { spawn, spec, judged } = makeSpawner({
      allowed: ['cheap/glm-5.3-flash'],
      fallback: { provider: 'cheap', model: 'glm-5.3-flash' },
      settings: (userId) => (userId === 42 ? { modelProvider: 'expensive', model: 'claude-sonnet-5' } : undefined),
    });

    await spawn({}, { channel: true, settingsUserId: 42 });

    expect(judged).toContain(42);
    expect(judged).not.toContain(15);
    expect(spec().providerId).toBe('cheap');
  });

  /** lifecycle.ts `/clear` respawns with `{ provider: previous.providerId, model: previous.model }`,
   *  repeating whatever the disposed session was running. An allow-list narrowed while that session was
   *  live must apply to the new one. */
  it('re-authorizes the prior model a /clear respawn repeats, so a revoked one does not survive the clear', async () => {
    const { spawn, spec } = makeSpawner({
      allowed: ['cheap/glm-5.3-flash'],
      fallback: { provider: 'cheap', model: 'glm-5.3-flash' },
    });

    await spawn({ provider: 'expensive', model: 'claude-sonnet-5' });

    expect(spec().providerId).toBe('cheap');
    expect(spec().model.id).toBe('glm-5.3-flash');
  });

  it('leaves an allowed complete selection exactly as named', async () => {
    const { spawn, spec } = makeSpawner({
      allowed: ['expensive/claude-sonnet-5'],
      fallback: { provider: 'cheap', model: 'glm-5.3-flash' },
    });

    await spawn({ provider: 'expensive', model: 'claude-sonnet-5' });

    expect(spec().providerId).toBe('expensive');
    expect(spec().model.id).toBe('claude-sonnet-5');
  });

  it('never lets a half-filled selection reach the provider layer unjudged', async () => {
    const { spawn, spec } = makeSpawner({
      allowed: ['cheap/glm-5.3-flash'],
      fallback: { provider: 'cheap', model: 'glm-5.3-flash' },
    });

    await spawn({ provider: 'expensive' });

    expect(spec().providerId).toBe('cheap');
    expect(spec().model.id).toBe('glm-5.3-flash');
  });

  it('fails session start before any provider call when the account has no runnable configured pair', async () => {
    const { spawn, create } = makeSpawner({ allowed: [], fallback: null });

    await expect(spawn({})).rejects.toThrow(/no configured model is allowed for this account/);
    expect(create).not.toHaveBeenCalled();
  });

  it('leaves selection untouched where no authorization is wired at all', async () => {
    const { spawn, spec } = makeSpawner({ allowed: [], wired: false });

    await spawn({});

    expect(spec().providerId).toBe('expensive');
    expect(spec().model.id).toBe('claude-sonnet-5');
  });
});
