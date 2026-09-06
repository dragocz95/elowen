import { describe, expect, it } from 'vitest';
import { currentWorkDir, runWithPolicy } from '../../src/plugins/policyContext.js';
import { createWorkspacePathView } from '../../src/plugins/pathView.js';

const policy = { allowedProjectIds: 'all' as const, allowedPaths: () => [] };

describe('live turn working directory', () => {
  it('reads the current selection and never resurrects a stale cwd when the resolver returns nothing', () => {
    let selected: string | undefined = '/project';
    runWithPolicy(policy, () => {
      expect(currentWorkDir()).toBe('/project');
      selected = '/workspace';
      expect(currentWorkDir()).toBe('/workspace');
      selected = undefined;
      expect(currentWorkDir()).toBeUndefined();
    }, { workDir: '/stale', resolveWorkDir: () => selected });
  });

  it('keeps an explicitly confined child pinned even when a resolver would widen it', () => {
    const pathView = createWorkspacePathView({ workspaceId: 'ws-pinned', projectId: 1, accountUserId: 1, path: '/pinned' });
    runWithPolicy(policy, () => {
      expect(currentWorkDir()).toBe('/pinned');
    }, { workDir: '/pinned', pathView, resolveWorkDir: () => '/outside' });
  });

  it('does not change an inherited child scope when its parent switches', async () => {
    let selected = '/first';
    await runWithPolicy(policy, async () => {
      const inherited = currentWorkDir();
      await runWithPolicy(policy, async () => {
        selected = '/second';
        await Promise.resolve();
        expect(currentWorkDir()).toBe('/first');
      }, { workDir: inherited });
      expect(currentWorkDir()).toBe('/second');
    }, { resolveWorkDir: () => selected });
  });
});
