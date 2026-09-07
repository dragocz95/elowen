import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPlugins } from '../../src/plugins/loader.js';
import { runWithPolicy, type TurnIdentity } from '../../src/plugins/policyContext.js';
import type { Policy } from '../../src/plugins/policy.js';
import type { SubagentUpdate } from '../../src/brain/events.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const adminPolicy: Policy = { allowedProjectIds: 'all', allowedPaths: () => [] };
const owner: TurnIdentity = { platform: 'elowen', userId: '1', elowenUserId: 1, admin: true, owner: true };

/** A delegation inherits the parent turn's reasoning level and spawns with it, but the rail entry never
 *  carried that level back. The CLI status line of a drilled-in sub-agent reads its level from exactly
 *  there, so the field rendered blank — indistinguishable from "this model has no reasoning ladder"
 *  while the parent line kept showing one. The level has to travel with the progress update. */
describe('subagent plugin — the rail entry reports the level the child runs on', () => {
  let dataRoot: string;
  let updates: SubagentUpdate[];

  beforeEach(() => {
    dataRoot = mkdtempSync(join(tmpdir(), 'subagent-rail-level-'));
    updates = [];
  });

  afterEach(() => rmSync(dataRoot, { recursive: true, force: true }));

  /** The catalog `ctx.listModels()` serves: one model with a real ladder, one without. An explicit level
   *  is measured against exactly this, so the suite covers both a supported and an impossible request. */
  const catalog = [
    { provider: 'anthropic', providerLabel: 'Anthropic', model: 'claude-opus-5', reasoningLevels: ['low', 'medium', 'high'] },
    { provider: 'openai', providerLabel: 'OpenAI', model: 'chat-only' },
  ];

  const delegate = async (
    turnModel: { provider?: string; model: string; thinkingLevel?: string } | undefined,
    args: Record<string, unknown> = {},
  ) => {
    const reg = await loadPlugins({
      dirs: [join(repoRoot, 'plugins')], enabled: ['subagent'], dataRoot,
      logger: { info() {}, warn() {}, error() {} },
      listModels: async () => catalog,
    });
    const platform = reg.platforms.find((p) => p.name === 'subagent');
    if (!platform) throw new Error('subagent platform not registered');
    // A progress update is only emitted once the child has announced its session, so announce one and
    // then answer immediately — this suite is about what the update CARRIES, not about the run's shape.
    platform.listen(async (_src, _task, onEvent) => {
      onEvent?.({ type: 'session', sessionId: 'brain-ch-subagent-sub-dlg-level' });
      return 'done';
    });
    const tool = reg.tools.find((t) => t.name === 'Delegate');
    if (!tool) throw new Error('Delegate tool not registered');
    const executor = tool as unknown as {
      execute: (id: string, p: unknown) => Promise<{ content: { text: string }[] }>;
      parameters?: { properties?: Record<string, { description?: string }> };
    };
    const result = await runWithPolicy(
      adminPolicy,
      () => executor.execute('call-1', { task: 'a task', ...args }),
      { identity: owner, sessionId: 'brain-1', model: turnModel, emitSubagent: (u) => updates.push(u) },
    );
    return { updates, text: result.content[0]?.text ?? '', tool: executor };
  };

  // Mutation: drop `thinkingLevel` from the plugin's progress payload and every update reports undefined.
  it('carries the inherited reasoning level on the progress update', async () => {
    const { updates: seen } = await delegate({ provider: 'anthropic', model: 'claude-opus-5', thinkingLevel: 'low' });

    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((u) => u.thinkingLevel === 'low')).toBe(true);
  });

  // The absent case must stay absent rather than acquire a default: a model with no reasoning ladder has
  // no level, and inventing one would put a word in the status line that never applied to that run.
  it('reports no level when the parent turn had none', async () => {
    const { updates: seen } = await delegate({ provider: 'anthropic', model: 'claude-opus-5' });

    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((u) => u.thinkingLevel === undefined)).toBe(true);
  });

  /** The per-delegation choice: a task's difficulty, not the parent conversation's, decides how hard the
   *  child thinks. Mutation: resolve the level as `parentTurn?.thinkingLevel` again and the child silently
   *  runs on the parent's effort while the argument reads as accepted. */
  it('runs the sub-agent on an explicitly chosen level instead of the parent turn\'s', async () => {
    const { updates: seen } = await delegate(
      { provider: 'anthropic', model: 'claude-opus-5', thinkingLevel: 'high' },
      { thinkingLevel: 'low' },
    );

    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((u) => u.thinkingLevel === 'low')).toBe(true);
  });

  /** A level the child's model does not have is refused the way an unknown `model` is: a readable,
   *  self-correctable error naming the levels that DO exist, and no sub-agent spawned at all. Silently
   *  clamping it would run the child at an effort nobody chose while the rail reported the requested one. */
  it('refuses a level the child model does not support and lists the ones it has', async () => {
    const { updates: seen, text } = await delegate(
      { provider: 'anthropic', model: 'claude-opus-5', thinkingLevel: 'medium' },
      { thinkingLevel: 'xhigh' },
    );

    expect(text).toContain('thinkingLevel "xhigh" is not available on anthropic/claude-opus-5');
    expect(text).toContain('low, medium, high');
    expect(seen).toEqual([]);
  });

  it('refuses any level for a model that has no reasoning ladder at all', async () => {
    const { text } = await delegate(
      { provider: 'openai', model: 'chat-only' },
      { thinkingLevel: 'high' },
    );

    expect(text).toContain('reports no reasoning levels');
  });

  /** The level is validated against the model this delegation resolves to, not the parent's — otherwise a
   *  cross-model delegation would be checked against a ladder the child never runs on. */
  it('validates the level against an explicitly chosen child model', async () => {
    const { text } = await delegate(
      { provider: 'anthropic', model: 'claude-opus-5', thinkingLevel: 'high' },
      { model: 'openai/chat-only', thinkingLevel: 'high' },
    );

    expect(text).toContain('openai/chat-only');
    expect(text).toContain('reports no reasoning levels');
  });

  /** The argument only pays for itself if the model is told WHEN to raise it; a bare "reasoning effort"
   *  line gets either ignored or maxed out on every call. */
  it('teaches the model when to pick a level in the argument description', async () => {
    const { tool } = await delegate({ provider: 'anthropic', model: 'claude-opus-5' });
    const description = tool.parameters?.properties?.thinkingLevel?.description ?? '';

    expect(description).toMatch(/mechanical/i);
    expect(description).toMatch(/design|debug/i);
    expect(description).toMatch(/time and tokens/i);
    expect(description).toMatch(/inherit/i);
  });
});
