import { describe, expect, it } from 'vitest';
import { effectiveTurnWorkDir } from '../../src/brain/service/workDir.js';
import { currentAccess, assertPathAllowed, defaultCwd, isAllAccess } from '../../src/plugins/pathGuard.js';
import { runWithPolicy } from '../../src/plugins/policyContext.js';
import { normalizeDelegatedExecutionScope } from '../../src/brain/delegatedScope.js';

const projectRef = { kind: 'managed', projectId: 7 } as const;
const policy = { allowedProjectIds: 'all' as const, allowedPaths: () => [], canAccessProject: () => true };
const base = { policy, baseWorkDir: '/host', accountUserId: 1, sessionId: 'test', projectRef, projects: { list: () => [{ id: 7, path: '', executionKind: 'managed' as const, lifecycle: 'active' as const }] } };

describe('managed execution boundary', () => {
  it('does not fall back to the host when the provider is absent, even for administrators', () => {
    expect(() => effectiveTurnWorkDir(base)).toThrow(/environment provider/);
  });
  // A provider that is present but incomplete is not a state this boundary can be handed: every caller
  // sources it from `control('sandbox')`, which resolves to undefined unless every method the key
  // promises is there. That refusal is covered where it lives, in tests/plugins/pluginControls.test.ts.
  it('separates project-admin authority from host-path access', () => {
    runWithPolicy(policy, () => {
      expect(currentAccess().projectRef).toEqual(projectRef);
      expect(currentAccess().admin).toBe(true);
      expect(isAllAccess()).toBe(false);
      expect(defaultCwd()).toBe('/sales-dashboard');
      expect(() => assertPathAllowed('/etc/passwd')).toThrow(/guest/);
    }, { projectRef, workDir: '/sales-dashboard' });
  });
  it('preserves the managed reference through durable delegation and rejects unknown or conflicting targets', () => {
    const scope = { admin: false, owner: false, projectIds: [7], contributionUserId: 2, permissionBoundary: null, projectRef };
    expect(normalizeDelegatedExecutionScope(scope)?.projectRef).toEqual(projectRef);
    expect(normalizeDelegatedExecutionScope({ ...scope, projectRef: { kind: 'managed', projectId: 8 } })).toBeUndefined();
    expect(normalizeDelegatedExecutionScope({ ...scope, projectRef: { kind: 'host' } })).toBeUndefined();
    expect(normalizeDelegatedExecutionScope({ ...scope, workspaceRef: { workspaceId: 'old', projectId: 7 } })).toBeUndefined();
  });
});
