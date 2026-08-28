import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BrainSessionFactory,
  compactionKeepRecentTokens,
  compactionReserveTokens,
  estimateFixedCostTokens,
  logicalPromptCwd,
  postCompactionCeiling,
  providerPathScrubber,
  resolveAutoCompactPct,
} from '../../src/brain/session/factory.js';
import { openDb } from '../../src/store/db.js';
import { BrainStore } from '../../src/store/brainStore.js';
import { StepDrainCoordinator } from '../../src/brain/stepDrain.js';
import { CLEAR_MIN_BYTES } from '../../src/brain/session/toolResultClearing.js';

let dirs: string[] = [];
afterEach(() => { for (const p of dirs) rmSync(p, { recursive: true, force: true }); dirs = []; });

describe('workspace logical prompt cwd', () => {
  it('rebuilds PI structured prompt options without the host workspace prefix', () => {
    const hostRoot = '/var/www/.config/elowen/plugins-data/sandbox/users/1/workspaces/ws_secret';
    let handler: ((event: any) => { systemPrompt?: string } | undefined) | undefined;
    logicalPromptCwd('.', hostRoot)({
      on: (name: string, fn: typeof handler) => { if (name === 'before_agent_start') handler = fn; },
    } as any);
    const result = handler?.({
      systemPromptOptions: {
        cwd: hostRoot,
        customPrompt: 'You are Elowen.',
        appendSystemPrompt: 'Scoped instructions.',
        contextFiles: [{ path: `${hostRoot}/AGENTS.md`, content: 'workspace rules' }],
        selectedTools: ['Read'],
      },
    });
    expect(result?.systemPrompt).toContain('<project_instructions path="AGENTS.md">');
    expect(result?.systemPrompt).toContain('Current working directory: .');
    expect(result?.systemPrompt).not.toContain(hostRoot);
  });

  it('scrubs host roots from history and tool results in the final provider payload', () => {
    const hostRoot = '/var/www/private/worktree';
    let handler: ((event: any) => unknown) | undefined;
    providerPathScrubber((text) => text.split(hostRoot).join('.'))({
      on: (name: string, fn: typeof handler) => { if (name === 'before_provider_request') handler = fn; },
    } as any);
    const payload = handler?.({
      payload: {
        instructions: `cwd ${hostRoot}`,
        input: [{ role: 'tool', content: [{ type: 'text', text: `read ${hostRoot}/src/a.ts` }] }],
      },
    });
    expect(JSON.stringify(payload)).not.toContain(hostRoot);
    expect(JSON.stringify(payload)).toContain('./src/a.ts');
  });
});

describe('per-model auto-compact threshold', () => {
  it('uses the per-model override when set, else the global default', () => {
    const byModel = { 'relay/gpt-x': 65, 'ant/claude-x': 90 };
    // Override present for this provider/model → wins over the global.
    expect(resolveAutoCompactPct(byModel, 'relay', 'gpt-x', 80)).toBe(65);
    expect(resolveAutoCompactPct(byModel, 'ant', 'claude-x', 80)).toBe(90);
    // No override for this model → the global default applies.
    expect(resolveAutoCompactPct(byModel, 'relay', 'other', 80)).toBe(80);
    // No map at all → the global default.
    expect(resolveAutoCompactPct(undefined, 'relay', 'gpt-x', 75)).toBe(75);
  });

  it('keys per-model overrides by providerId/model, matching the context-window convention', () => {
    // The key is the config providerId (not the elowen- registry name) joined with the model id.
    expect(resolveAutoCompactPct({ 'relay/gpt-x': 50 }, 'relay', 'gpt-x', 80)).toBe(50);
    // A registry-style provider name must NOT match the config-keyed map.
    expect(resolveAutoCompactPct({ 'relay/gpt-x': 50 }, 'elowen-relay', 'gpt-x', 80)).toBe(80);
  });
});

describe('BrainSessionFactory compaction budget', () => {
  it('keeps a positive emergency summary budget when proactive compaction is disabled', () => {
    const reserve = compactionReserveTokens(200_000, false, 80);
    expect(reserve).toBe(4_096);
    // PI 0.80.6 derives summary maxTokens as floor(0.8 * reserveTokens).
    expect(Math.floor(0.8 * reserve)).toBeGreaterThan(0);
    expect(compactionReserveTokens(8_000, false, 80)).toBe(400);
  });

  it('preserves the configured proactive threshold', () => {
    expect(compactionReserveTokens(200_000, true, 80)).toBe(40_000);
    expect(compactionReserveTokens(200_000, true, 95)).toBe(10_000);
  });

  it('estimates the fixed request cost with the same chars/4 heuristic PI uses', () => {
    // 4 system chars + 4 append chars + the tool JSON (58 chars) → 66 chars → 17 tokens.
    const tool = { name: 't', label: 'l', description: 'd', parameters: {} };
    expect(estimateFixedCostTokens('aaaa', ['bbbb'], [tool])).toBe(17);
    // An empty session still serializes the (empty) tools array as "[]".
    expect(estimateFixedCostTokens('', [], [])).toBe(1);
    // The measured E2E session: 32113-char persona + 78357 chars of tool JSON ≈ 27 617 tokens.
    expect(estimateFixedCostTokens('x'.repeat(32_113), [], [])).toBe(Math.ceil((32_113 + 2) / 4));
  });

  it('sizes the tail from the post-compaction ceiling, not from the room under the trigger', () => {
    // 1M at 50% (trigger 500k) with the measured ~27.6k fixed cost: the 100k ceiling leaves far more
    // room than PI's own default tail, so the cap wins.
    expect(compactionKeepRecentTokens(500_000, 27_619)).toBe(20_000); // cap = PI's own default
    // 200k trigger: ceiling 40_000 − 27_619 fixed − 8_000 summary allowance.
    expect(compactionKeepRecentTokens(200_000, 27_619)).toBe(4_381);
    // 150k trigger: the fixed cost and the summary already exceed the 30k ceiling on their own.
    expect(compactionKeepRecentTokens(150_000, 27_619)).toBe(2_000); // floor clamp
    // A tiny 8k window at 40%: the tail must not swallow the whole ceiling.
    expect(compactionKeepRecentTokens(3_200, 8_000)).toBe(2_000);    // floor clamp
  });

  it('keeps the projected post-compaction floor under the ceiling wherever the ceiling is reachable', () => {
    // The invariant the ceiling exists for. Sizing the tail from the trigger broke exactly this: a 200k
    // trigger took the full 20k default tail, putting the floor at 55.6k against a 40k ceiling — so the
    // compaction landed above the size it was supposed to bring the conversation down to.
    const fixedCostTokens = 27_619;
    for (const trigger of [200_000, 300_000, 500_000, 1_000_000]) {
      const floor = fixedCostTokens + 8_000 + compactionKeepRecentTokens(trigger, fixedCostTokens);
      expect(floor).toBeLessThanOrEqual(postCompactionCeiling(trigger));
    }
  });

});

describe('BrainSessionFactory compaction settings handed to PI', () => {
  async function captureCompactionSettings(
    contextWindow: number, autoCompact: boolean, autoCompactAtPct: number, fixedCostTokens = 8_000,
  ) {
    const session = {
      sessionId: 'sess-compaction-settings',
      agent: {} as Record<string, unknown>,
      subscribe: () => () => {},
      messages: [] as unknown[],
      setSteeringMode: vi.fn(),
    };
    const createSession = vi.fn(async () => ({ session }));
    const factory = new BrainSessionFactory({
      store: new BrainStore(openDb(':memory:')),
      createSession: createSession as never,
      resourceLoaderFactory: () => undefined,
    });
    // The fixed cost is derived from the spec's system prompt at chars/4, so a prompt of `fixedCostTokens
    // * 4 − 2` chars (the empty tools array serializes as "[]") yields exactly the requested estimate.
    const systemPrompt = 's'.repeat(fixedCostTokens * 4 - 2);
    const { applyCompaction } = await factory.create({
      sessionId: session.sessionId, ownerUserId: 1, runtime: undefined,
      model: { id: 'test-model', provider: 'kimi-coding', contextWindow },
      cwd: process.cwd(), systemPrompt, appendSystemPrompt: [], skills: [], tools: [],
      autoCompact, autoCompactAtPct,
    } as never);
    // createAgentSession receives the session's in-memory SettingsManager — the same object PI reads at
    // every compaction check, so what it holds IS what PI runs on.
    const options = (createSession.mock.calls[0] as unknown[])[0] as {
      settingsManager: { getCompactionSettings: () => { enabled: boolean; reserveTokens: number; keepRecentTokens: number } };
    };
    return { read: () => options.settingsManager.getCompactionSettings(), applyCompaction };
  }

  it('hands PI an explicit keepRecentTokens, not the constant default by omission', async () => {
    // 300k at 50%: trigger 150k, so the post-compaction ceiling is 30k; after the 8k fixed cost and the
    // 8k summary allowance, 14k remains, and that is a value only this derivation produces. PI's own
    // constant default (20k) would not survive the ceiling math, so asserting it proves the value is
    // explicit rather than defaulted by omission.
    const { read } = await captureCompactionSettings(300_000, true, 50);
    expect(read()).toEqual({ enabled: true, reserveTokens: 150_000, keepRecentTokens: 14_000 });
  });

  it('keeps the retained tail small relative to a small window', async () => {
    // Regression: keepRecentTokens was never set, so a 32k model kept PI's constant 20k — 62% of the
    // window — after every compaction. With a realistic fixed cost the trigger (12.8k) sits below the
    // fixed cost alone, so the tail shrinks to its 2k floor.
    const { read } = await captureCompactionSettings(32_000, true, 40, 27_619);
    expect(read()).toEqual({ enabled: true, reserveTokens: 19_200, keepRecentTokens: 2_000 });
  });

  it('re-derives keepRecentTokens from the live threshold on a threshold change', async () => {
    // The tail is a function of the ceiling the TRIGGER implies, so a live percentage change must
    // re-derive it: on a 200k window, 80% leaves a 32k ceiling and a 16k tail, while tightening to 40%
    // drops the ceiling to 16k, which the fixed cost and summary allowance consume entirely.
    const { read, applyCompaction } = await captureCompactionSettings(200_000, true, 80);
    expect(read()).toEqual({ enabled: true, reserveTokens: 40_000, keepRecentTokens: 16_000 });
    applyCompaction(true, 40);
    expect(read()).toEqual({ enabled: true, reserveTokens: 120_000, keepRecentTokens: 2_000 });
  });

  it('sizes the retained tail from the post-compaction ceiling, not the window', async () => {
    // 1M at 50% (trigger 500k) with the measured ~27.6k fixed cost: the 100k ceiling has room to spare,
    // so the tail sits at PI's own default. 400k at 50% (trigger 200k): the 40k ceiling leaves only
    // ~4.4k once the fixed cost and the summary allowance are paid for, and that is what the tail gets.
    // On the 400k capture the derived value differs from PI's 20k default, so deleting the wiring line
    // turns this test red.
    const roomy = await captureCompactionSettings(1_000_000, true, 50, 27_619);
    expect(roomy.read()).toEqual({ enabled: true, reserveTokens: 500_000, keepRecentTokens: 20_000 });
    const tight = await captureCompactionSettings(400_000, true, 50, 27_619);
    expect(tight.read()).toEqual({ enabled: true, reserveTokens: 200_000, keepRecentTokens: 4_381 });
  });
});

// The register sorts by "Updated", and a reader takes that to mean the conversation moved. Spawning is
// not the conversation moving: opening the web chat, a channel waking and an evicted conversation coming
// back all spawn against an existing row. Stamping it there put yesterday's untouched chat at the top of
// the list with the moment the page was opened.
describe('BrainSessionFactory session stamping', () => {
  it('records the model on respawn without moving the conversation up the register', async () => {
    const home = mkdtempSync(join(tmpdir(), 'elowen-home-'));
    dirs.push(home);
    vi.stubEnv('HOME', home);
    const db = openDb(':memory:');
    const store = new BrainStore(db);
    const sessionId = 'sess-stamp';
    store.createSession({ id: sessionId, userId: 1, model: 'old-model', provider: 'old-provider' });
    // Backdate it, so a same-second write cannot make this pass by accident.
    const idle = '2026-08-01 10:00:00';
    db.prepare('UPDATE brain_sessions SET updated_at = ? WHERE id = ?').run(idle, sessionId);

    const session = { sessionId, agent: {}, subscribe: () => () => {}, messages: [], setSteeringMode: vi.fn() };
    const factory = new BrainSessionFactory({
      store,
      createSession: vi.fn(async () => ({ session })) as never,
      resourceLoaderFactory: () => undefined,
    });
    await factory.create({
      sessionId, ownerUserId: 1, runtime: undefined, providerId: 'anthropic',
      model: { id: 'new-model', provider: 'anthropic', contextWindow: 200_000 },
      cwd: process.cwd(), systemPrompt: 'sp', appendSystemPrompt: [], skills: [], tools: [],
      autoCompact: false, autoCompactAtPct: 80,
    } as never);

    const row = store.getSession(sessionId)!;
    expect(row.updated_at).toBe(idle); // …the conversation did not move
    expect(row.model).toBe('new-model'); // …but the pair a respawn restores from is current
    expect(row.provider).toBe('anthropic');
  });
});

describe('BrainSessionFactory context-saving installers', () => {
  async function createWithProvider(
    provider: string,
    api?: string,
    modelId = 'test-model',
    hostedToolSearch?: 'openai' | 'anthropic',
    compactionFallbackModel?: { id: string; provider: string; api: string },
  ) {
    // Spills resolve through dataDir(HOME) — point HOME at a tmp dir so the test never touches the
    // real ~/.config/elowen.
    const home = mkdtempSync(join(tmpdir(), 'elowen-home-'));
    dirs.push(home);
    vi.stubEnv('HOME', home);
    const listeners: ((e: unknown) => void)[] = [];
    const nativeResult = { native: true };
    const nativeStream = vi.fn(() => nativeResult);
    const session = {
      sessionId: `sess-${provider}`,
      agent: { streamFunction: nativeStream } as { streamFunction: typeof nativeStream; transformContext?: (m: unknown[]) => Promise<unknown[]> },
      subscribe: (l: (e: unknown) => void) => { listeners.push(l); return () => {}; },
      messages: [] as unknown[],
      setSteeringMode: vi.fn(),
    };
    let cacheMonitor: unknown;
    let capturedHostedToolSearch: { provider: 'openai' | 'anthropic'; modelId: string } | undefined;
    let capturedAnthropicReplayExtension: unknown;
    let capturedCompactionRouteExtension: unknown;
    const factory = new BrainSessionFactory({
      store: new BrainStore(openDb(':memory:')),
      createSession: vi.fn(async () => ({ session })) as never,
      resourceLoaderFactory: (options) => {
        cacheMonitor = options.cacheMonitor;
        capturedHostedToolSearch = options.hostedToolSearch;
        capturedAnthropicReplayExtension = options.anthropicHostedReplayExtension;
        capturedCompactionRouteExtension = options.compactionModelRouteExtension;
        return undefined;
      },
    });
    await factory.create({
      sessionId: session.sessionId, ownerUserId: 1,
      runtime: undefined,
      model: { id: modelId, provider, contextWindow: 200_000, ...(api ? { api } : {}) },
      ...(compactionFallbackModel ? { compactionFallbackModel } : {}),
      cwd: process.cwd(), systemPrompt: 'sp', appendSystemPrompt: [], skills: [], tools: [], hostedToolSearch,
      autoCompact: false, autoCompactAtPct: 80,
    } as never);
    return {
      home, listeners, session, cacheMonitor, hostedToolSearch: capturedHostedToolSearch,
      anthropicReplayExtension: capturedAnthropicReplayExtension,
      compactionRouteExtension: capturedCompactionRouteExtension,
      streamWrapped: session.agent.streamFunction !== nativeStream,
      nativeStream, nativeResult,
    };
  }

  it('installs tool-result clearing (with spill under the data dir) and subscribes cacheWatch', async () => {
    // A 66-minute idle gap exceeds BOTH the short (6m) and long (61m) gate, so the test is robust
    // regardless of PI_CACHE_RETENTION in the environment.
    const { home, listeners, session, cacheMonitor } = await createWithProvider('anthropic');
    try {
      const transform = session.agent.transformContext;
      expect(typeof transform).toBe('function');

      const T0 = 1_700_000_000_000;
      const big = 'x'.repeat(CLEAR_MIN_BYTES * 2);
      const toolCall = (id: string, timestamp: number) => ({
        role: 'assistant', timestamp,
        content: [{ type: 'toolCall', id, name: 'Bash', arguments: {} }],
      });
      const toolResult = (id: string, timestamp: number) => ({
        role: 'toolResult', toolCallId: id, toolName: 'Bash', isError: false, timestamp,
        content: [{ type: 'text', text: big }],
      });
      const messages = [
        { role: 'user', content: 'first', timestamp: T0 },
        toolCall('old-big', T0 + 1),
        toolResult('old-big', T0 + 2),
        { role: 'user', content: 'second', timestamp: T0 + 3 },
        toolCall('mid', T0 + 4),
        toolResult('mid', T0 + 5),
        { role: 'user', content: 'third', timestamp: T0 + 4_000_000 },
        toolCall('new', T0 + 4_000_001),
        toolResult('new', T0 + 4_000_002),
      ];
      const out = await transform!(messages as never) as typeof messages;

      // Only the result before the 2nd-from-last user message is cleared; the two freshest turns stay.
      const clearedText = (out[2]?.content as { text: string }[])[0]?.text ?? '';
      expect(clearedText).toContain('Older tool result cleared');
      expect(out[5]).toBe(messages[5]);
      expect(out[8]).toBe(messages[8]);
      // The full text was spilled BEFORE the placeholder replaced it.
      // Located by its stable prefix: the rest of the name carries the descriptor a restarted session
      // needs to rebuild this exact placeholder.
      const spillDir = join(home, '.config/elowen/tool-results/sess-anthropic');
      const spillName = readdirSync(spillDir).find((n) => n.startsWith('old-big.v1-'));
      expect(spillName).toBeDefined();
      expect(readFileSync(join(spillDir, spillName!), 'utf8')).toBe(big);

      // cacheWatch + the persistence projector both subscribed at create time, and the exact provider
      // payload recorder was handed to the resource loader's before_provider_request extension path.
      expect(listeners.length).toBeGreaterThanOrEqual(2);
      expect(cacheMonitor).toBeDefined();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('installs cache diagnostics for the official OpenAI Responses wire too', async () => {
    const { listeners, cacheMonitor } = await createWithProvider('openai', 'openai-responses');
    try {
      expect(listeners.length).toBeGreaterThanOrEqual(3);
      expect(cacheMonitor).toBeDefined();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('installs only the explicit auth-bound hosted route and pins it to the session model', async () => {
    const supported = await createWithProvider('openai-codex', 'openai-codex-responses', 'gpt-5.6-luna', 'openai');
    const tooOld = await createWithProvider('openai-codex', 'openai-codex-responses', 'gpt-5.3-codex-spark');
    const apiKey = await createWithProvider('openai', 'openai-responses', 'gpt-5.6-luna');
    const azure = await createWithProvider('azure-openai', 'openai-responses', 'gpt-5.6-luna');
    const anthropic = await createWithProvider('anthropic', 'anthropic-messages', 'claude-opus-5', 'anthropic');
    const oldAnthropic = await createWithProvider('anthropic', 'anthropic-messages', 'claude-opus-4-1');
    try {
      expect(supported.hostedToolSearch).toEqual({ provider: 'openai', modelId: 'gpt-5.6-luna' });
      expect(tooOld.hostedToolSearch).toBeUndefined();
      expect(apiKey.hostedToolSearch).toBeUndefined();
      expect(azure.hostedToolSearch).toBeUndefined();
      expect(anthropic.hostedToolSearch).toEqual({ provider: 'anthropic', modelId: 'claude-opus-5' });
      expect(typeof anthropic.anthropicReplayExtension).toBe('function');
      expect(anthropic.streamWrapped).toBe(true);
      expect(supported.anthropicReplayExtension).toBeUndefined();
      expect(oldAnthropic.hostedToolSearch).toBeUndefined();
      expect(oldAnthropic.anthropicReplayExtension).toBeUndefined();
      expect(oldAnthropic.streamWrapped).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('routes cross-provider compaction outside the Anthropic replay wrapper', async () => {
    const fallback = { id: 'claude-opus-5', provider: 'elowen-anthropic-proxy', api: 'anthropic-messages' };
    const created = await createWithProvider('anthropic', 'anthropic-messages', 'claude-opus-5', 'anthropic', fallback);
    let beforeCompact: ((event: { signal: AbortSignal }) => void) | undefined;
    (created.compactionRouteExtension as (pi: { on(name: string, handler: (event: { signal: AbortSignal }) => void): void }) => void)({
      on(name, handler) { if (name === 'session_before_compact') beforeCompact = handler; },
    });
    const signal = new AbortController().signal;
    beforeCompact?.({ signal });
    const originalFetch = vi.fn();
    const result = created.session.agent.streamFunction(
      { id: 'claude-opus-5', provider: 'anthropic', api: 'anthropic-messages' },
      { messages: [], tools: [] },
      { signal, fetch: originalFetch },
    );

    expect(result).toBe(created.nativeResult);
    expect(created.nativeStream).toHaveBeenCalledWith(
      expect.objectContaining(fallback),
      expect.anything(),
      expect.objectContaining({ signal, fetch: originalFetch }),
    );
  });

  it('uses OpenAI maximum cache retention for destructive Responses transforms', async () => {
    vi.stubEnv('PI_CACHE_RETENTION', 'long');
    const { session } = await createWithProvider('openai', 'openai-responses');
    try {
      const transform = session.agent.transformContext;
      expect(typeof transform).toBe('function');
      const t0 = 1_700_000_000_000;
      const messagesAt = (thirdAt: number) => [
        { role: 'user', content: 'first', timestamp: t0 },
        { role: 'assistant', timestamp: t0 + 1, content: [{ type: 'toolCall', id: 'old', name: 'Bash', arguments: {} }] },
        { role: 'toolResult', toolCallId: 'old', toolName: 'Bash', isError: false, timestamp: t0 + 2,
          content: [{ type: 'text', text: 'x'.repeat(CLEAR_MIN_BYTES * 2) }] },
        { role: 'user', content: 'second', timestamp: t0 + 3 },
        { role: 'assistant', timestamp: t0 + 4, content: [{ type: 'text', text: 'ok' }] },
        { role: 'user', content: 'third', timestamp: thirdAt },
      ];

      const warm = messagesAt(t0 + 7 * 60_000);
      const warmOut = await transform!(warm as never) as typeof warm;
      expect(warmOut[2]).toBe(warm[2]);

      const cold = messagesAt(t0 + 62 * 60_000);
      const coldOut = await transform!(cold as never) as typeof cold;
      expect((coldOut[2]?.content as { text: string }[])[0]?.text).toContain('Older tool result cleared');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  // The seam a plugin needs to restore per-conversation state that lives in daemon memory while its
  // evidence lives in the transcript (the files plugin's read-before-write guard). It has to carry the
  // REHYDRATED history and be awaited, or the first turn could run before the state is in place.
  it('hands the rehydrated history to onSpawned before returning the session', async () => {
    const history = [{ role: 'toolResult', details: { ok: true, tool: 'Read', path: '/x', contentHash: 'h' } }];
    const session = {
      sessionId: 'sess-spawned',
      agent: {} as Record<string, unknown>,
      subscribe: () => () => {},
      messages: history as unknown[],
      setSteeringMode: vi.fn(),
    };
    const factory = new BrainSessionFactory({
      store: new BrainStore(openDb(':memory:')),
      createSession: vi.fn(async () => ({ session })) as never,
      resourceLoaderFactory: () => undefined,
    });
    let seen: { sessionId: string; messages: readonly unknown[] } | undefined;
    let settled = false;
    await factory.create({
      sessionId: session.sessionId, ownerUserId: 1, runtime: undefined,
      model: { id: 'test-model', provider: 'kimi-coding', contextWindow: 200_000 },
      cwd: process.cwd(), systemPrompt: 'sp', appendSystemPrompt: [], skills: [], tools: [],
      autoCompact: false, autoCompactAtPct: 80,
      onSpawned: async (e: { sessionId: string; messages: readonly unknown[] }) => {
        seen = e;
        await Promise.resolve();
        settled = true;
      },
    } as never);

    expect(seen).toEqual({ sessionId: 'sess-spawned', messages: history });
    expect(settled).toBe(true); // awaited, not fired and forgotten
  });

  it('skips cacheWatch for non-anthropic providers (their cache stats would make it cry wolf)', async () => {
    const { listeners, session, cacheMonitor } = await createWithProvider('kimi-coding');
    try {
      // The request recorder, compaction circuit breaker and persistence projector are unconditional;
      // cacheWatch did not subscribe. Clearing's transformContext is still installed.
      expect(listeners).toHaveLength(3);
      expect(typeof session.agent.transformContext).toBe('function');
      expect(cacheMonitor).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('BrainSessionFactory turn-boundary compaction toggle', () => {
  /** A PI session exposing the two seams the boundary check needs: the native `_checkCompaction` the
   *  coordinator wraps, and the `prepareNextTurnWithContext` hook the installer replaces. */
  function compactionSession() {
    // Held separately: the coordinator REPLACES `_checkCompaction` on the session with its own wrapper.
    const checkCompaction = vi.fn(async () => false);
    return {
      checkCompaction,
      sessionId: 'sess-compaction',
      _checkCompaction: checkCompaction,
      abortCompaction: vi.fn(),
      agent: {
        state: { messages: [], model: {}, thinkingLevel: 'high' },
        prepareNextTurnWithContext: undefined as unknown,
      },
      subscribe: () => () => {},
      messages: [] as unknown[],
      setSteeringMode: vi.fn(),
    };
  }

  async function createWithAutoCompact(session: ReturnType<typeof compactionSession>, autoCompact: boolean) {
    const factory = new BrainSessionFactory({
      store: new BrainStore(openDb(':memory:')),
      createSession: vi.fn(async () => ({ session })) as never,
      resourceLoaderFactory: () => undefined,
    });
    return factory.create({
      sessionId: session.sessionId, ownerUserId: 1, runtime: undefined,
      model: { id: 'test-model', provider: 'kimi-coding', contextWindow: 200_000 },
      cwd: process.cwd(), systemPrompt: 'sp', appendSystemPrompt: [], skills: [], tools: [],
      autoCompact, autoCompactAtPct: 80,
    } as never);
  }

  /** Drive one PI turn boundary. A session with no hook installed simply has no boundary check, so the
   *  assertions below report the missing CHECK rather than crashing on the missing hook. */
  const runBoundary = async (session: ReturnType<typeof compactionSession>): Promise<void> => {
    const hook = session.agent.prepareNextTurnWithContext as
      ((turn: unknown) => Promise<unknown>) | undefined;
    await hook?.({
      message: { role: 'assistant', content: [], stopReason: 'toolUse', timestamp: 1, usage: undefined },
      context: { messages: [] },
      toolResults: [],
    });
  };

  it('starts checking at turn boundaries as soon as auto-compaction is switched on mid-conversation', async () => {
    // Regression: the boundary hook was installed only when auto-compaction was on AT SPAWN, so enabling
    // it from Account settings did nothing until the session was respawned.
    const session = compactionSession();
    const { applyCompaction } = await createWithAutoCompact(session, false);

    await runBoundary(session);
    expect(session.checkCompaction).not.toHaveBeenCalled();

    applyCompaction(true, 80);
    await runBoundary(session);
    expect(session.checkCompaction).toHaveBeenCalledOnce();
  });

  it('stops checking at turn boundaries as soon as auto-compaction is switched off', async () => {
    const session = compactionSession();
    const { applyCompaction } = await createWithAutoCompact(session, true);

    await runBoundary(session);
    expect(session.checkCompaction).toHaveBeenCalledOnce();

    applyCompaction(false, 80);
    await runBoundary(session);
    expect(session.checkCompaction).toHaveBeenCalledOnce();
  });
});

describe('BrainSessionFactory step-drain hold install order', () => {
  // Mirrors compactionSession above, but on a SUB-AGENT session id — the only kind the hold installs on.
  function heldSession() {
    const checkCompaction = vi.fn(async () => false);
    return {
      checkCompaction,
      sessionId: 'brain-ch-subagent-held',
      _checkCompaction: checkCompaction,
      abortCompaction: vi.fn(),
      agent: {
        state: { messages: [], model: {}, thinkingLevel: 'high' },
        prepareNextTurnWithContext: undefined as unknown,
      },
      subscribe: () => () => {},
      messages: [] as unknown[],
      setSteeringMode: vi.fn(),
    };
  }

  it('installs the hold OUTSIDE the compaction wrapper, so a parked turn never spends a compaction call', async () => {
    // The order is factory code, not coordinator code: installTurnBoundaryAutoCompaction first, then
    // installHold, so the hold (installed last) runs FIRST at each boundary. A reorder would pass every
    // coordinator unit test and silently cost one compaction model call per parked turn — exactly the
    // criterion this pins.
    const session = heldSession();
    const stepDrain = new StepDrainCoordinator();
    const factory = new BrainSessionFactory({
      store: new BrainStore(openDb(':memory:')),
      createSession: vi.fn(async () => ({ session })) as never,
      resourceLoaderFactory: () => undefined,
      stepDrain,
    });
    await factory.create({
      sessionId: session.sessionId, ownerUserId: 1, runtime: undefined,
      model: { id: 'test-model', provider: 'kimi-coding', contextWindow: 200_000 },
      cwd: process.cwd(), systemPrompt: 'sp', appendSystemPrompt: [], skills: [], tools: [],
      autoCompact: true, autoCompactAtPct: 80,
    } as never);

    stepDrain.begin();
    const controller = new AbortController();
    const hook = session.agent.prepareNextTurnWithContext as (turn: unknown, signal?: AbortSignal) => Promise<unknown>;
    let settled = false;
    const held = hook({
      message: { role: 'assistant', content: [], stopReason: 'toolUse', timestamp: 1, usage: undefined },
      context: { messages: [] },
      toolResults: [],
    }, controller.signal).then(() => { settled = true; });
    await new Promise((r) => setTimeout(r, 0));

    expect(settled).toBe(false); // parked at the boundary…
    expect(session.checkCompaction).not.toHaveBeenCalled(); // …BEFORE the compaction wrapper could run
    controller.abort();
    await held;
    expect(session.checkCompaction).not.toHaveBeenCalled(); // the aborted release skips it too
  });
});

describe('BrainSessionFactory deferred-tool wiring', () => {
  async function createWithDeferral(deferred: Set<string>) {
    const home = mkdtempSync(join(tmpdir(), 'elowen-home-'));
    dirs.push(home);
    vi.stubEnv('HOME', home);
    const session = {
      sessionId: 'sess-deferral',
      agent: {} as Record<string, unknown>,
      subscribe: () => () => {},
      messages: [] as unknown[],
      setActiveToolsByName: vi.fn(),
      setSteeringMode: vi.fn(),
    };
    const createSession = vi.fn(async () => ({ session }));
    const factory = new BrainSessionFactory({
      store: new BrainStore(openDb(':memory:')),
      createSession: createSession as never,
      resourceLoaderFactory: () => undefined,
    });
    const tools = [{ name: 'Read' }, { name: 'ToolSearch' }, { name: 'mcp__gh__a' }, { name: 'mcp__gh__b' }];
    const toolSearch = { deferred, activated: new Set<string>(), session: undefined };
    await factory.create({
      sessionId: session.sessionId, ownerUserId: 1,
      runtime: undefined,
      model: { id: 'test-model', provider: 'kimi-coding', contextWindow: 200_000 },
      cwd: process.cwd(), systemPrompt: 'sp', appendSystemPrompt: [], skills: [], tools,
      toolSearch,
      autoCompact: false, autoCompactAtPct: 80,
    } as never);
    vi.unstubAllEnvs();
    return { session, createSession, toolSearch };
  }

  it('keeps deferred tools in the PI allow-list and narrows only the ACTIVE slice after create', async () => {
    // Regression: PI treats the create() `tools` option as allowedToolNames — a REGISTRY filter. Passing
    // the active slice there dropped every deferred tool from the registry, so ToolSearch "matched
    // nothing" even for names its own awareness block advertised, forever.
    const { session, createSession } = await createWithDeferral(new Set(['mcp__gh__a', 'mcp__gh__b']));
    const spec = (createSession.mock.calls[0] as unknown[])[0] as { tools: string[] };
    expect(spec.tools).toEqual(['Read', 'ToolSearch', 'mcp__gh__a', 'mcp__gh__b']); // registry keeps ALL names
    expect(session.setActiveToolsByName).toHaveBeenCalledWith(['Read', 'ToolSearch']); // prompt slice omits deferred
  });

  it('with nothing deferred it never touches the active set (byte-identical to before deferral existed)', async () => {
    const { session } = await createWithDeferral(new Set());
    expect(session.setActiveToolsByName).not.toHaveBeenCalled();
  });
});

describe('BrainSessionFactory cold-start-compaction assessment', () => {
  async function createWithHistory(messages: unknown[], autoCompact = true) {
    const listeners: ((e: unknown) => void)[] = [];
    const session = {
      sessionId: 'sess-cold-assess',
      agent: {} as Record<string, unknown>,
      subscribe: (l: (e: unknown) => void) => { listeners.push(l); return () => {}; },
      messages,
      setSteeringMode: vi.fn(),
    };
    const factory = new BrainSessionFactory({
      store: new BrainStore(openDb(':memory:')),
      createSession: vi.fn(async () => ({ session })) as never,
      resourceLoaderFactory: () => undefined,
    });
    const { assessColdCompaction, applyCompaction } = await factory.create({
      sessionId: session.sessionId, ownerUserId: 1, runtime: undefined,
      model: { id: 'test-model', provider: 'kimi-coding', contextWindow: 200_000 },
      cwd: process.cwd(), systemPrompt: 'sp', appendSystemPrompt: [], skills: [], tools: [],
      autoCompact, autoCompactAtPct: 80,
    } as never);
    return { assess: assessColdCompaction, applyCompaction, listeners };
  }

  // 1.4M chars ≈ 350k estimated tokens: past the break-even C ≥ 5·F + 20·S for the floor here
  // (1 fixed + 8k allowance + 20k tail = 28 001 → 300 005 tokens).
  const bigHistory = [{ role: 'user', content: 'x'.repeat(1_400_000), timestamp: 1 }];

  it('reports a large cold context as eligible, with the estimates PI’s own check would see', async () => {
    const { assess } = await createWithHistory(bigHistory);
    expect(assess()).toEqual({ eligible: true, contextTokens: 350_000, floorTokens: 28_001 });
  });

  it('refuses a context below the break-even — a 4× reduction still loses money', async () => {
    // 300k chars ≈ 75k tokens: 2.7× the floor, which the retired 2×-floor rule would have accepted,
    // but well under 5·28k + 20·8k.
    const { assess } = await createWithHistory([{ role: 'user', content: 'x'.repeat(300_000), timestamp: 1 }]);
    expect(assess()).toEqual({ eligible: false, reason: 'not-worthwhile' });
  });

  it('reads the auto-compact toggle LIVE, exactly like the boundary check does', async () => {
    const { assess, applyCompaction } = await createWithHistory(bigHistory, false);
    expect(assess()).toEqual({ eligible: false, reason: 'auto-compact-off' });
    applyCompaction(true, 80);
    expect(assess().eligible).toBe(true);
  });

  it('is refused by the circuit breaker once repeated automatic compaction failures tripped it', async () => {
    const { assess, listeners } = await createWithHistory(bigHistory);
    expect(assess().eligible).toBe(true);
    // Three exhausted attempts (start + end with no result) — the same evidence that stops PI's own
    // threshold compaction. The factory subscribed the breaker's observe at create time.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      for (const listener of listeners) listener({ type: 'compaction_start' });
      for (const listener of listeners) listener({ type: 'compaction_end', aborted: false });
    }
    expect(assess()).toEqual({ eligible: false, reason: 'breaker' });
  });
});

describe('BrainSessionFactory steering queue', () => {
  it('drains the whole steering queue into one model round', async () => {
    // PI's default is "one-at-a-time": messages sent while a turn streams are injected one per model
    // round, so a burst of three costs three rounds and the agent answers each blind to the rest.
    const session = {
      sessionId: 'sess-steering',
      agent: {} as Record<string, unknown>,
      subscribe: () => () => {},
      messages: [] as unknown[],
      setSteeringMode: vi.fn(),
    };
    const factory = new BrainSessionFactory({
      store: new BrainStore(openDb(':memory:')),
      createSession: vi.fn(async () => ({ session })) as never,
      resourceLoaderFactory: () => undefined,
    });
    await factory.create({
      sessionId: session.sessionId, ownerUserId: 1, runtime: undefined,
      model: { id: 'test-model', provider: 'kimi-coding', contextWindow: 200_000 },
      cwd: process.cwd(), systemPrompt: 'sp', appendSystemPrompt: [], skills: [], tools: [],
      autoCompact: false, autoCompactAtPct: 80,
    } as never);

    expect(session.setSteeringMode).toHaveBeenCalledWith('all');
  });
});
