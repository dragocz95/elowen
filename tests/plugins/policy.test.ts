import { describe, it, expect } from 'vitest';
import { resolvePolicy } from '../../src/plugins/policy.js';
import { runWithPolicy, currentPolicy } from '../../src/plugins/policyContext.js';

function deps(over: Record<string, unknown> = {}) {
  return {
    userProjects: { forUser: (_id: number) => [1, 2], isAdmin: (_id: number) => false },
    projects: { get: (id: number) => (id === 1 ? { path: '/repo/a' } : id === 2 ? { path: '/repo/b' } : undefined) },
    ...over,
  } as never;
}

describe('resolvePolicy', () => {
  it('maps a user to their project repo paths', () => {
    const p = resolvePolicy(deps(), 5);
    expect(p.allowedProjectIds).toEqual(new Set([1, 2]));
    expect(p.allowedPaths().sort()).toEqual(['/repo/a', '/repo/b']);
  });
  it('gives admin "all"', () => {
    const p = resolvePolicy(deps({ userProjects: { forUser: () => [], isAdmin: () => true } }), 1);
    expect(p.allowedProjectIds).toBe('all');
    expect(p.allowedPaths()).toEqual([]);
  });
  it('skips a project whose row is missing', () => {
    const p = resolvePolicy(deps({ userProjects: { forUser: () => [1, 9], isAdmin: () => false } }), 5);
    expect(p.allowedPaths()).toEqual(['/repo/a']);
  });
  it('no access → empty paths', () => {
    const p = resolvePolicy(deps({ userProjects: { forUser: () => [], isAdmin: () => false } }), 5);
    expect(p.allowedPaths()).toEqual([]);
  });
});

describe('policy context', () => {
  it('exposes the policy inside runWithPolicy and nothing outside', () => {
    const p = resolvePolicy(deps(), 5);
    expect(currentPolicy()).toBeUndefined();
    const seen = runWithPolicy(p, () => currentPolicy());
    expect(seen).toBe(p);
    expect(currentPolicy()).toBeUndefined();
  });
});
