import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrainStatusService } from '../../src/brain/service/statusService.js';
import type { SandboxWorkspace } from '../../src/plugins/api.js';

describe('workspace status freshness', () => {
  it('reflects selection, release and revoked access without waiting for a cache window', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'workspace-status-')));
    try {
      let bound: SandboxWorkspace | null = null;
      let allowed = true;
      const service = new BrainStatusService({
        store: { getSession: () => ({ work_dir: root }), getProjectExecution: () => undefined, getLatestTurn: () => [] },
        sessions: { get: () => undefined },
        lifecycle: { activeLive: () => undefined, activeSessionId: () => 'brain-1' },
        cards: { forSession: () => [] },
        permissions: { effectiveYolo: () => false },
        policy: () => ({ allowedProjectIds: new Set(allowed ? [1] : []), allowedPaths: () => allowed ? [root] : [] }),
        projects: { list: () => [{ id: 1, path: root }] },
        sandbox: () => ({ activeSessionWorkspace: () => bound, activeWorkspace: () => null, workspaceRoots: () => [] }),
      } as unknown as ConstructorParameters<typeof BrainStatusService>[0]);
      const ask = () => service.status(1).project.workspace;
      expect(ask()).toBeNull();
      const workspace: SandboxWorkspace = { workspaceId: 'ws_1', projectId: 1, path: root, label: 'selected', branch: 'feature', baseRef: 'main' };
      bound = workspace;
      expect(ask()?.workspaceId).toBe('ws_1');
      bound = null;
      expect(ask()).toBeNull();
      bound = workspace;
      expect(ask()?.workspaceId).toBe('ws_1');
      allowed = false;
      expect(ask()).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
