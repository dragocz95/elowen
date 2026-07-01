import { describe, it, expect } from 'vitest';
import { assertPathAllowed, allowedRoots, isAllAccess } from '../../src/plugins/pathGuard.js';
import { runWithPolicy } from '../../src/plugins/policyContext.js';
import type { Policy } from '../../src/plugins/policy.js';

const userPolicy = (roots: string[]): Policy => ({ allowedProjectIds: new Set([1]), allowedPaths: () => roots });
const adminPolicy: Policy = { allowedProjectIds: 'all', allowedPaths: () => [] };

describe('assertPathAllowed', () => {
  it('allows a path inside an allowed root', () => {
    runWithPolicy(userPolicy(['/repo/a']), () => {
      expect(assertPathAllowed('/repo/a/src/x.ts')).toBe('/repo/a/src/x.ts');
      expect(assertPathAllowed('/repo/a')).toBe('/repo/a');
    });
  });

  it('rejects a path outside every allowed root', () => {
    runWithPolicy(userPolicy(['/repo/a']), () => {
      expect(() => assertPathAllowed('/etc/passwd')).toThrow(/not allowed/);
      expect(() => assertPathAllowed('/repo/ab/x')).toThrow(/not allowed/); // prefix must be a path boundary
    });
  });

  it('rejects a traversal that escapes the root', () => {
    runWithPolicy(userPolicy(['/repo/a']), () => {
      expect(() => assertPathAllowed('/repo/a/../b/secret')).toThrow(/not allowed/);
    });
  });

  it('admin all-access allows any path', () => {
    runWithPolicy(adminPolicy, () => {
      expect(assertPathAllowed('/anywhere/at/all')).toBe('/anywhere/at/all');
      expect(isAllAccess()).toBe(true);
    });
  });

  it('throws with no active policy (defensive)', () => {
    expect(() => assertPathAllowed('/repo/a/x')).toThrow(/not allowed/);
    expect(allowedRoots()).toEqual([]);
  });
});
