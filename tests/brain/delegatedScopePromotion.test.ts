import { describe, it, expect } from 'vitest';
import {
  promoteDelegatedScope,
  scopeExceedsCurrentAccess,
  normalizeDelegatedExecutionScope,
  type DelegatedExecutionScope,
  type DelegatingTurnAccess,
} from '../../src/brain/delegatedScope.js';
import { buildReadOnlyBoundary, resolveReadOnlyOrigin } from '../../src/brain/agents/readOnlyBoundary.js';
import type { NoninteractivePermissionBoundary, PermissionRule } from '../../src/brain/toolPermissions.js';

const WRITE_ALLOW: PermissionRule = { scope: 'tools', pattern: 'Write', action: 'allow' };
const READ_ALLOW: PermissionRule = { scope: 'tools', pattern: 'Read', action: 'allow' };
const boundary = (rules: PermissionRule[]): NoninteractivePermissionBoundary => ({ rules, unattendedAsks: 'allow' });

const PARENT_BOUNDARY = boundary([READ_ALLOW, WRITE_ALLOW]);
const SPAWNER = 'elowen:7';

/** A parent that holds real write access, exactly as pathGuard.currentAccess() would report it. */
const access = (over: Partial<DelegatingTurnAccess> = {}): DelegatingTurnAccess => ({
  admin: false,
  projectIds: [1],
  owner: false,
  toolPolicy: { allow: ['Read', 'Write', 'Bash', 'Delegate'] },
  permissionBoundary: PARENT_BOUNDARY,
  principal: SPAWNER,
  ...over,
});

/** The child that parent spawned with `read_only: true`: the read-only preset intersected with what the
 *  parent holds, plus the clamped boundary — i.e. what brain/platforms.ts mints for that call. */
const readOnlyChild = (over: Partial<DelegatedExecutionScope> = {}): DelegatedExecutionScope => ({
  admin: false,
  projectIds: [1],
  owner: false,
  toolPolicy: { allow: ['Bash', 'Read'] },
  permissionBoundary: buildReadOnlyBoundary(PARENT_BOUNDARY),
  promptAppend: ['You are a focused sub-agent.'],
  readOnlyOrigin: 'requested',
  spawnedBy: SPAWNER,
  ...over,
});

const errorOf = (result: ReturnType<typeof promoteDelegatedScope>): string =>
  'error' in result ? result.error : '(promoted — expected a refusal)';
const scopeOf = (result: ReturnType<typeof promoteDelegatedScope>): DelegatedExecutionScope => {
  if ('error' in result) throw new Error(`expected a promotion, got: ${result.error}`);
  return result.scope;
};

/** Promotion is the ONE place a delegated scope is allowed to grow, so every rule that keeps it bounded is
 *  asserted here rather than described in a comment. The shape of the guarantee: the promoted scope is
 *  minted from the delegating turn's CURRENT authority and from nothing else, so it can never be a way to
 *  reach access the caller does not hold at the moment it asks. */
describe('promoteDelegatedScope', () => {
  it('hands the child exactly what the delegating turn holds right now', () => {
    const promoted = scopeOf(promoteDelegatedScope(readOnlyChild(), access()));
    expect(promoted.toolPolicy).toEqual({ allow: ['Bash', 'Delegate', 'Read', 'Write'] });
    expect(promoted.permissionBoundary).toEqual(PARENT_BOUNDARY);
    expect(promoted.projectIds).toEqual([1]);
    // The clamp is gone for good, so a second promotion has nothing left to lift.
    expect(promoted.readOnlyOrigin).toBeUndefined();
    expect(errorOf(promoteDelegatedScope(promoted, access()))).toMatch(/not started as a read-only sub-agent/);
  });

  it('carries the child\'s identity across but none of its old authority', () => {
    const promoted = scopeOf(promoteDelegatedScope(readOnlyChild(), access()));
    // The role prompt is what makes the continuation the SAME sub-agent; it is not authority.
    expect(promoted.promptAppend).toEqual(['You are a focused sub-agent.']);
    expect(promoted.spawnedBy).toBe(SPAWNER);
    // Nothing from the old scope's access half survives: every field matches the caller, not the child.
    expect(promoted.permissionBoundary).not.toEqual(readOnlyChild().permissionBoundary);
  });

  it('never exceeds the caller — the promoted scope passes the continuation check against that same turn', () => {
    const now = access();
    expect(scopeExceedsCurrentAccess(scopeOf(promoteDelegatedScope(readOnlyChild(), now)), now)).toBeUndefined();
  });

  it('promotes to the NARROWED authority when the caller lost tools since spawning', () => {
    const narrowed = access({ toolPolicy: { allow: ['Bash', 'Read', 'Write'] } });
    const promoted = scopeOf(promoteDelegatedScope(readOnlyChild(), narrowed));
    // Not the toolset that existed at spawn time (which included Delegate) — the one held now.
    expect(promoted.toolPolicy).toEqual({ allow: ['Bash', 'Read', 'Write'] });
  });

  describe('refuses every attempt to reach past the delegating turn', () => {
    it('a planning (read-only) turn, which holds no write access to hand over', () => {
      expect(errorOf(promoteDelegatedScope(readOnlyChild(), access({ readOnly: true, planMode: true }))))
        .toMatch(/read-only|plan/i);
    });

    it('a child whose read-only mode the caller did not choose', () => {
      expect(errorOf(promoteDelegatedScope(readOnlyChild({ readOnlyOrigin: 'imposed' }), access())))
        .toMatch(/not yours to choose/);
    });

    // A child spawned before this field existed, and an ordinary `tools: ['Read']` delegation, are
    // indistinguishable from each other in the durable row — so neither may be widened.
    it('a child with no recorded read-only origin (legacy, or an ordinary narrow delegation)', () => {
      const legacy = readOnlyChild();
      delete legacy.readOnlyOrigin;
      expect(errorOf(promoteDelegatedScope(legacy, access()))).toMatch(/not started as a read-only sub-agent/);
    });

    // The shared-channel case: two members write into ONE parent session, so the session guard alone
    // would let either of them widen the other's sub-agent.
    it('a promoter who is not the principal that spawned the child', () => {
      expect(errorOf(promoteDelegatedScope(readOnlyChild(), access({ principal: 'discord:999' }))))
        .toMatch(/only the person whose request started/);
    });

    it('an unidentified promoter, and an unidentified spawner — unknown is never a match', () => {
      expect(errorOf(promoteDelegatedScope(readOnlyChild(), access({ principal: undefined }))))
        .toMatch(/only the person whose request started/);
      const anonymous = readOnlyChild();
      delete anonymous.spawnedBy;
      expect(errorOf(promoteDelegatedScope(anonymous, access()))).toMatch(/only the person whose request started/);
    });

    // The continuation check has to run FIRST: without it, a child scoped to a project the caller has since
    // lost would be silently "promoted" instead of refused.
    it('a child scoped to a project the caller no longer holds', () => {
      expect(errorOf(promoteDelegatedScope(readOnlyChild({ projectIds: [1, 9] }), access({ projectIds: [1] }))))
        .toMatch(/project/i);
    });

    it('a child carrying owner authority the caller does not have', () => {
      expect(errorOf(promoteDelegatedScope(readOnlyChild({ owner: true }), access({ owner: false }))))
        .toMatch(/owner/i);
    });

    it('a child holding all-project access under a project-scoped caller', () => {
      expect(errorOf(promoteDelegatedScope(readOnlyChild({ admin: true, projectIds: [] }), access())))
        .toMatch(/all-project/i);
    });
  });

  it('mints a canonical scope an admin caller can actually run', () => {
    const promoted = scopeOf(promoteDelegatedScope(
      readOnlyChild({ admin: true, projectIds: [] }),
      access({ admin: true, projectIds: [] }),
    ));
    // admin + a project list is the ambiguous shape the normalizer rejects outright.
    expect(promoted.projectIds).toEqual([]);
    expect(normalizeDelegatedExecutionScope(promoted)).toEqual(promoted);
  });
});

/** Which read-only children may EVER be promoted is decided once, at spawn, and frozen into the durable
 *  scope. Everything downstream only reads that verdict, so it is asserted directly here. */
describe('resolveReadOnlyOrigin', () => {
  it('marks a clamp the delegating turn asked for as liftable', () => {
    expect(resolveReadOnlyOrigin({ agentReadOnly: false, requested: true, planMode: false })).toBe('requested');
  });

  it('locks a read-only agent TYPE — that is the operator\'s definition of the role, not a call option', () => {
    expect(resolveReadOnlyOrigin({ agentReadOnly: true, requested: false, planMode: false })).toBe('imposed');
    // Passing read_only alongside a read-only type must not downgrade the lock to a choice.
    expect(resolveReadOnlyOrigin({ agentReadOnly: true, requested: true, planMode: false })).toBe('imposed');
  });

  it('locks a child spawned from a PLANNING turn even when it asked for read-only itself', () => {
    expect(resolveReadOnlyOrigin({ agentReadOnly: false, requested: true, planMode: true })).toBe('imposed');
  });

  it('records nothing for a child that is not read-only at all', () => {
    expect(resolveReadOnlyOrigin({ agentReadOnly: false, requested: false, planMode: false })).toBeUndefined();
    // Plan mode always forces read_only upstream, so this pairing cannot occur — and if it ever did, an
    // ordinary writing child must not be marked promotable.
    expect(resolveReadOnlyOrigin({ agentReadOnly: false, requested: false, planMode: true })).toBeUndefined();
  });
});
