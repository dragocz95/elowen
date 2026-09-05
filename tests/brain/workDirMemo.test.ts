import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { memoizedTurnWorkspace, WORKSPACE_MEMO_TTL_MS } from '../../src/brain/service/workDir.js';
import type { Policy } from '../../src/plugins/policy.js';

/** The status poll asks "where does the next turn run" for every attached client, several times a second
 *  across an instance. The answer is memoized per (account, conversation, base directory) for the same
 *  short window gitBranch uses, so a poll never costs a plugin lookup per request while a Use, Create or
 *  Release in that conversation still shows up within the window. */
describe('memoizedTurnWorkspace', () => {
  const dirs: string[] = [];
  const dir = () => { const d = realpathSync(mkdtempSync(join(tmpdir(), 'workdir-memo-'))); dirs.push(d); return d; };
  const cleanup = () => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); };

  it('reuses the answer within the window and asks again after it, per account, conversation and directory', () => {
    try {
      const project = dir();
      const worktree = dir();
      const policy: Policy = { allowedProjectIds: new Set([1]), allowedPaths: () => [project, worktree] };
      let lookups = 0;
      let bound: { workspaceId: string; projectId: number; path: string; label: string; branch: string; baseRef: string } | null = null;
      const sandbox = {
        workspaceRoots: () => [],
        activeSessionWorkspace: () => { lookups += 1; return bound; },
        activeWorkspace: () => null,
      } as never;
      const ask = (now: number, sessionId = 'brain-1', accountUserId = 1) => memoizedTurnWorkspace({
        policy, baseWorkDir: project, accountUserId, sessionId, projects: { list: () => [{ id: 1, path: project }] }, sandbox,
      }, now);

      expect(ask(1_000).workspace).toBeNull();
      bound = { workspaceId: 'ws_1', projectId: 1, path: worktree, label: 'w', branch: 'b', baseRef: 'main' };
      // Still inside the window: the earlier answer stands and the plugin is not asked again.
      expect(ask(1_000 + WORKSPACE_MEMO_TTL_MS - 1).workspace).toBeNull();
      expect(lookups).toBe(1);
      // A different conversation or account is its own entry, not a hit on the first one.
      expect(ask(1_000, 'brain-2').workspace?.workspaceId).toBe('ws_1');
      expect(ask(1_000, 'brain-1', 2).workspace?.workspaceId).toBe('ws_1');
      expect(lookups).toBe(3);
      // Past the window the binding shows up.
      expect(ask(1_000 + WORKSPACE_MEMO_TTL_MS).workspace?.workspaceId).toBe('ws_1');
      expect(lookups).toBe(4);
    } finally { cleanup(); }
  });
});
