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

  const delegate = async (turnModel: { provider?: string; model: string; thinkingLevel?: string } | undefined) => {
    const reg = await loadPlugins({
      dirs: [join(repoRoot, 'plugins')], enabled: ['subagent'], dataRoot,
      logger: { info() {}, warn() {}, error() {} },
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
    const executor = tool as unknown as { execute: (id: string, p: unknown) => Promise<unknown> };
    await runWithPolicy(
      adminPolicy,
      () => executor.execute('call-1', { task: 'a task' }),
      { identity: owner, sessionId: 'brain-1', model: turnModel, emitSubagent: (u) => updates.push(u) },
    );
    return updates;
  };

  // Mutation: drop `thinkingLevel` from the plugin's progress payload and every update reports undefined.
  it('carries the inherited reasoning level on the progress update', async () => {
    const seen = await delegate({ provider: 'anthropic', model: 'claude-opus-5', thinkingLevel: 'low' });

    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((u) => u.thinkingLevel === 'low')).toBe(true);
  });

  // The absent case must stay absent rather than acquire a default: a model with no reasoning ladder has
  // no level, and inventing one would put a word in the status line that never applied to that run.
  it('reports no level when the parent turn had none', async () => {
    const seen = await delegate({ provider: 'anthropic', model: 'claude-opus-5' });

    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((u) => u.thinkingLevel === undefined)).toBe(true);
  });
});
