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

/** Delegate's `workspaceId` confines the child to one Sandbox worktree, and that same id is what the
 *  sandboxed-run icon (CLI SubagentPanel + web TelemetryPanel/AgentsTable) keys on to tell a sandboxed
 *  run from a legacy project-scope one. If the plugin's progress payload dropped it, every one of those
 *  renderers would silently show no icon at all — never wrong, just permanently absent. */
describe('subagent plugin — the rail entry reports the workspace the child is confined to', () => {
  let dataRoot: string;
  let updates: SubagentUpdate[];

  beforeEach(() => {
    dataRoot = mkdtempSync(join(tmpdir(), 'subagent-rail-workspace-'));
    updates = [];
  });

  afterEach(() => rmSync(dataRoot, { recursive: true, force: true }));

  const delegate = async (params: Record<string, unknown>) => {
    const reg = await loadPlugins({
      dirs: [join(repoRoot, 'plugins')], enabled: ['subagent'], dataRoot,
      logger: { info() {}, warn() {}, error() {} },
    });
    const platform = reg.platforms.find((p) => p.name === 'subagent');
    if (!platform) throw new Error('subagent platform not registered');
    // A progress update is only emitted once the child has announced its session, so announce one and
    // then answer immediately — this suite is about what the update CARRIES, not about the run's shape.
    platform.listen(async (_src, _task, onEvent) => {
      onEvent?.({ type: 'session', sessionId: 'brain-ch-subagent-sub-ws' });
      return 'done';
    });
    const tool = reg.tools.find((t) => t.name === 'Delegate');
    if (!tool) throw new Error('Delegate tool not registered');
    const executor = tool as unknown as { execute: (id: string, p: unknown) => Promise<unknown> };
    await runWithPolicy(
      adminPolicy,
      () => executor.execute('call-1', params),
      { identity: owner, sessionId: 'brain-1', emitSubagent: (u) => updates.push(u) },
    );
    return updates;
  };

  // Mutation: drop `workspaceId: p.workspaceId` from the plugin's job state and every update loses it.
  it('carries the explicit workspaceId on the progress update', async () => {
    const seen = await delegate({ task: 'a task', workspaceId: 'ws_abc123' });

    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((u) => u.workspaceId === 'ws_abc123')).toBe(true);
  });

  // The legacy project-scope case must stay absent rather than acquire a placeholder: no workspaceId
  // means no sandbox icon anywhere, and inventing a value would draw one for a run that has none.
  it('reports no workspaceId for a legacy project-scope delegation', async () => {
    const seen = await delegate({ task: 'a task' });

    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((u) => u.workspaceId === undefined)).toBe(true);
  });
});
