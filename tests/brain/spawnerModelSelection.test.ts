import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { AgentSession, ModelRuntime } from '@earendil-works/pi-coding-agent';
import { LiveSessionSpawner } from '../../src/brain/service/spawner.js';
import { inMemoryModelRuntime } from '../../src/brain/providers.js';
import type { Policy } from '../../src/plugins/policy.js';
import { openDb } from '../../src/store/db.js';
import { BrainStore } from '../../src/store/brainStore.js';
import { DEFAULT_AUTO_COMPACT_PCT, type SpawnOpts } from '../../src/brain/session/liveBrain.js';
import { personalityText } from '../../src/brain/personality.js';

/** The spawner's chat-model selection fallback (spawner.ts): with an EMPTY `opts.selection` the session
 *  must land on the owner's per-user model choice (Account → Model), NOT on cfg.providers[0].models[0] —
 *  config list order — which once dropped a session on gpt-image-2, an image-only model that cannot hold
 *  a conversation. The explicit-selection path must stay untouched. */
let sharedRuntime: ModelRuntime;
beforeAll(async () => { sharedRuntime = await inMemoryModelRuntime(); });

const policy: Policy = { allowedProjectIds: 'all', allowedPaths: () => [] };

// The first provider's first model is the image-only one — the exact shape of the original bug. A user
// override pointing at the SECOND provider's model only wins when the fallback actually consults settings.
type Settings = {
  model?: string; modelProvider?: string;
  compactModel?: string; compactModelProvider?: string;
  autoCompactAt?: number; autoCompactAtByModel?: Record<string, number>;
  advisorStyle?: string;
};

function makeSpawner(settings: Settings | ((userId: number) => Settings | undefined)) {
  const settingsFor = typeof settings === 'function' ? settings : () => settings;
  const settingsReads: number[] = [];
  /** The ids the two OTHER personal-preference lookups in the system prompt were made under: the account's
   *  own instructions block, and the per-user prompt override the persona is rendered through. */
  const instructionReads: number[] = [];
  const renderIds: (number | undefined)[] = [];
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
    // The advisor style reaches the model only through the rendered persona, so render it verbatim. The
    // third argument is the account whose per-user prompt OVERRIDE this render may use.
    prompts: {
      render: (_name: string, vars: Record<string, string>, userId?: number) => {
        renderIds.push(userId);
        return `PERSONA ${vars.personality ?? ''}`.trim();
      },
    },
    url: 'http://x',
    userSettings: (userId: number) => { settingsReads.push(userId); return settingsFor(userId); },
    activeUserInstructions: (userId: number) => { instructionReads.push(userId); return `INSTRUCTIONS OF ${userId}`; },
    plugins: async () => undefined,
    factory: { create },
    sessionTaps: () => [],
  });
  const spawn = (selection: SpawnOpts['selection'], settingsUserId?: number) => spawner.spawn({
    sessionId: 'sess-1', ownerUserId: 1, selection, policy,
    autoCompact: false, ...(settingsUserId === undefined ? {} : { settingsUserId }),
  });
  const spec = () => create.mock.calls.at(-1)![0] as unknown as {
    model: { id: string }; providerId: string; autoCompactAtPct: number;
    systemPrompt: string; appendSystemPrompt: string[]; compactionFallbackModel?: { id: string };
  };
  return { spawn, create, spec, settingsReads, instructionReads, renderIds };
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

// ---------------------------------------------------------------------------------------------------
// Whose settings compose the session.
//
// A platform room belongs to whoever OPENED it, which is bookkeeping and grants nothing. Reading the
// session's personal settings off that account meant one colleague's default model — and therefore whose
// bill and whose capabilities every room turn ran on — plus their compaction model, thresholds and
// advisor style answered for everybody else in the room. `settingsUserId` names the verified writer; an
// omitted argument (owner chat, an unlinked sender, a cron turn) leaves the owner standing.
// ---------------------------------------------------------------------------------------------------

/** Owner 1 and writer 2 disagree about every setting the spawner composes, so a lookup under the wrong
 *  id is visible in the result rather than merely plausible. */
const OWNER_1_WRITER_2 = (userId: number): Settings | undefined => (userId === 1
  ? {
    model: 'gpt-image-2', modelProvider: 'img',
    compactModel: 'gpt-5', compactModelProvider: 'relay',
    autoCompactAt: 50, advisorStyle: 'detailed',
  }
  : {
    model: 'gpt-5.5', modelProvider: 'relay',
    compactModel: 'gpt-image-2', compactModelProvider: 'img',
    autoCompactAt: 35, advisorStyle: 'friendly',
  });

describe('LiveSessionSpawner — the settings a session is composed from', () => {
  it('runs the room on the WRITER’S model, not the opener’s', async () => {
    const { spawn, spec, settingsReads } = makeSpawner(OWNER_1_WRITER_2);

    const live = await spawn({}, 2);

    expect(live.model).toBe('gpt-5.5');
    expect(live.providerId).toBe('relay');
    expect(spec().model.id).toBe('gpt-5.5');
    // Not "also reads the writer": the opener's row must not be consulted at all.
    expect([...new Set(settingsReads)]).toEqual([2]);
  });

  it('takes the writer’s compaction model, threshold and advisor style too', async () => {
    const { spawn, spec } = makeSpawner(OWNER_1_WRITER_2);

    await spawn({}, 2);

    // Writer 2 compacts on the OTHER provider's model — owner 1's pick is the session model itself here,
    // which would resolve to no fallback at all.
    expect(spec().compactionFallbackModel?.id).toBe('gpt-image-2');
    expect(spec().autoCompactAtPct).toBe(35);
    expect(spec().systemPrompt).toContain(personalityText('friendly'));
    expect(spec().systemPrompt).not.toContain(personalityText('detailed'));
  });

  it('lets the writer’s per-model override win over their own global percentage', async () => {
    const { spawn, spec } = makeSpawner((userId) => (userId === 2
      ? { model: 'gpt-5.5', modelProvider: 'relay', autoCompactAt: 35, autoCompactAtByModel: { 'relay/gpt-5.5': 42 } }
      : { autoCompactAt: 50, autoCompactAtByModel: { 'relay/gpt-5.5': 60 } }));

    await spawn({}, 2);

    expect(spec().autoCompactAtPct).toBe(42);
  });

  it('falls back to the owner when no writer is named (owner chat, cron, an unlinked sender)', async () => {
    const { spawn, spec, settingsReads } = makeSpawner(OWNER_1_WRITER_2);

    const live = await spawn({});

    expect(live.model).toBe('gpt-image-2');
    expect(spec().autoCompactAtPct).toBe(50);
    expect(spec().systemPrompt).toContain(personalityText('detailed'));
    expect([...new Set(settingsReads)]).toEqual([1]);
  });

  it('appends the WRITER’S account instructions, not the opener’s', async () => {
    const { spawn, spec, instructionReads } = makeSpawner(OWNER_1_WRITER_2);

    await spawn({}, 2);

    // Account → user instructions are a stronger statement of how somebody wants to be answered than the
    // advisor style landing in the very same prompt, so the two must never come from different accounts.
    expect(spec().appendSystemPrompt.join('\n')).toContain('INSTRUCTIONS OF 2');
    expect(spec().appendSystemPrompt.join('\n')).not.toContain('INSTRUCTIONS OF 1');
    expect(spec().systemPrompt).toContain(personalityText('friendly'));
    expect(instructionReads).toEqual([2]);
  });

  it('renders the persona through the WRITER’S prompt override', async () => {
    const { spawn, renderIds } = makeSpawner(OWNER_1_WRITER_2);

    await spawn({}, 2);

    // A per-user prompt override is a personal preference like the style rendered into it.
    expect([...new Set(renderIds)]).toEqual([2]);
  });

  it('leaves both on the owner when no writer is named', async () => {
    const { spawn, spec, instructionReads, renderIds } = makeSpawner(OWNER_1_WRITER_2);

    await spawn({});

    expect(spec().appendSystemPrompt.join('\n')).toContain('INSTRUCTIONS OF 1');
    expect(instructionReads).toEqual([1]);
    expect([...new Set(renderIds)]).toEqual([1]);
  });

  it('uses the built-in default threshold when the resolved account has no settings row', async () => {
    const { spawn, spec } = makeSpawner((userId) => (userId === 2 ? undefined : { autoCompactAt: 50 }));

    await spawn({}, 2);

    expect(spec().autoCompactAtPct).toBe(DEFAULT_AUTO_COMPACT_PCT);
  });
});
