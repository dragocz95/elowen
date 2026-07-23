import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrainSessionFactory, compactionReserveTokens, resolveAutoCompactPct } from '../../src/brain/session/factory.js';
import { openDb } from '../../src/store/db.js';
import { BrainStore } from '../../src/store/brainStore.js';
import { CLEAR_MIN_BYTES } from '../../src/brain/session/toolResultClearing.js';

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
});

describe('BrainSessionFactory context-saving installers', () => {
  async function createWithProvider(provider: string) {
    // Spills resolve through dataDir(HOME) — point HOME at a tmp dir so the test never touches the
    // real ~/.config/elowen.
    const home = mkdtempSync(join(tmpdir(), 'elowen-home-'));
    vi.stubEnv('HOME', home);
    const listeners: ((e: unknown) => void)[] = [];
    const session = {
      sessionId: `sess-${provider}`,
      agent: {} as { transformContext?: (m: unknown[]) => Promise<unknown[]> },
      subscribe: (l: (e: unknown) => void) => { listeners.push(l); return () => {}; },
      messages: [] as unknown[],
    };
    const factory = new BrainSessionFactory({
      store: new BrainStore(openDb(':memory:')),
      createSession: vi.fn(async () => ({ session })) as never,
      resourceLoaderFactory: () => undefined,
    });
    await factory.create({
      sessionId: session.sessionId, ownerUserId: 1,
      runtime: undefined,
      model: { id: 'test-model', provider, contextWindow: 200_000 },
      cwd: process.cwd(), systemPrompt: 'sp', appendSystemPrompt: [], skills: [], tools: [],
      autoCompact: false, autoCompactAtPct: 80,
    } as never);
    return { home, listeners, session };
  }

  it('installs tool-result clearing (with spill under the data dir) and subscribes cacheWatch', async () => {
    // A 66-minute idle gap exceeds BOTH the short (6m) and long (61m) gate, so the test is robust
    // regardless of PI_CACHE_RETENTION in the environment.
    const { home, listeners, session } = await createWithProvider('anthropic');
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
      expect(readFileSync(join(home, '.config/elowen/tool-results/sess-anthropic/old-big.txt'), 'utf8')).toBe(big);

      // cacheWatch + the persistence projector both subscribed at create time.
      expect(listeners.length).toBeGreaterThanOrEqual(2);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('skips cacheWatch for non-anthropic providers (their cache stats would make it cry wolf)', async () => {
    const { listeners, session } = await createWithProvider('kimi-coding');
    try {
      // Only the persistence projector subscribed; clearing's transformContext is still installed.
      expect(listeners).toHaveLength(1);
      expect(typeof session.agent.transformContext).toBe('function');
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('BrainSessionFactory deferred-tool wiring', () => {
  async function createWithDeferral(deferred: Set<string>) {
    const home = mkdtempSync(join(tmpdir(), 'elowen-home-'));
    vi.stubEnv('HOME', home);
    const session = {
      sessionId: 'sess-deferral',
      agent: {} as Record<string, unknown>,
      subscribe: () => () => {},
      messages: [] as unknown[],
      setActiveToolsByName: vi.fn(),
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
