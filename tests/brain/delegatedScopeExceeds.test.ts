import { describe, it, expect } from 'vitest';
import { delegatedToolPolicy, scopeExceedsCurrentAccess, type DelegatedExecutionScope } from '../../src/brain/delegatedScope.js';
import { buildReadOnlyBoundary } from '../../src/brain/agents/readOnlyBoundary.js';
import type { NoninteractivePermissionBoundary, PermissionRule } from '../../src/brain/toolPermissions.js';

type Access = Parameters<typeof scopeExceedsCurrentAccess>[1];

const scope = (over: Partial<DelegatedExecutionScope> = {}): DelegatedExecutionScope => ({
  admin: false, projectIds: [1], owner: false, permissionBoundary: null, ...over,
});
const access = (over: Partial<Access> = {}): Access => ({
  admin: false, projectIds: [1], owner: false, permissionBoundary: null, ...over,
});
const boundary = (
  rules: PermissionRule[], unattendedAsks: 'allow' | 'deny' = 'allow',
): NoninteractivePermissionBoundary => ({ rules, unattendedAsks });
const WRITE_ALLOW: PermissionRule = { scope: 'tools', pattern: 'Write', action: 'allow' };
const WRITE_DENY: PermissionRule = { scope: 'tools', pattern: 'Write', action: 'deny' };
const READ_ALLOW: PermissionRule = { scope: 'tools', pattern: 'Read', action: 'allow' };

/** Continuing an existing sub-agent replays a scope minted in the PAST. It must therefore be checked
 *  against the delegating turn's CURRENT authority, not only against what it was originally granted —
 *  otherwise a conversation that has since been narrowed could reach back through an old child. */
describe('scopeExceedsCurrentAccess', () => {
  it('accepts a child whose scope matches the caller exactly', () => {
    expect(scopeExceedsCurrentAccess(scope(), access())).toBeUndefined();
  });

  it('accepts a child strictly narrower than the caller', () => {
    expect(scopeExceedsCurrentAccess(
      scope({ projectIds: [1], toolPolicy: { allow: ['Read'] } }),
      access({ projectIds: [1, 2], toolPolicy: { allow: ['Read', 'Write'] } }),
    )).toBeUndefined();
  });

  it('an admin caller may continue any project-scoped child', () => {
    expect(scopeExceedsCurrentAccess(scope({ projectIds: [3, 4] }), access({ admin: true, projectIds: [] })))
      .toBeUndefined();
    expect(scopeExceedsCurrentAccess(scope({ admin: true, projectIds: [] }), access({ admin: true, projectIds: [] })))
      .toBeUndefined();
  });

  describe('refuses to hand back more than the caller now holds', () => {
    it('an all-project child under a project-scoped caller', () => {
      expect(scopeExceedsCurrentAccess(scope({ admin: true, projectIds: [] }), access()))
        .toMatch(/all-project/i);
    });

    it('a child scoped to a project the caller has since lost', () => {
      expect(scopeExceedsCurrentAccess(scope({ projectIds: [1, 9] }), access({ projectIds: [1] })))
        .toMatch(/project/i);
    });

    it('an owner-authority child under a non-owner caller', () => {
      expect(scopeExceedsCurrentAccess(scope({ owner: true }), access({ owner: false })))
        .toMatch(/owner/i);
    });

    it('a child holding a tool the caller no longer has', () => {
      expect(scopeExceedsCurrentAccess(
        scope({ toolPolicy: { allow: ['Read', 'Bash'] } }),
        access({ toolPolicy: { allow: ['Read'] } }),
      )).toMatch(/Bash/);
    });

    // The dangerous asymmetry: "no allow-list" means UNRESTRICTED, so an old unrestricted child is
    // strictly wider than a caller who now runs on an allow-list. Absence must not read as "narrow".
    it('an unrestricted child under a caller restricted to an allow-list', () => {
      expect(scopeExceedsCurrentAccess(scope(), access({ toolPolicy: { allow: ['Read'] } })))
        .toMatch(/tool/i);
    });

    // A PLANNING turn must never reach a writing child. The persisted scope cannot prove a child was
    // spawned read-only (an ordinary `tools: ['Read']` delegation looks the same), so this fails closed
    // for every continuation rather than guessing.
    it('any continuation from a read-only (planning) turn', () => {
      expect(scopeExceedsCurrentAccess(scope(), access({ readOnly: true }))).toMatch(/read-only|plan/i);
    });
  });

  // A deny is a narrowing, and the continuation path adds the caller's current denies on top; it is
  // never a reason to refuse.
  it('does not refuse merely because the caller gained a deny-list', () => {
    expect(scopeExceedsCurrentAccess(scope(), access({ toolPolicy: { deny: ['Bash'] } }))).toBeUndefined();
  });

  /** The granular permission boundary is the half that actually decides whether a tool CALL runs, so a
   *  continuation that replays an old boundary under a since-narrowed conversation is the widest hole
   *  available: an old child would stay a durable handle onto permissions the operator has revoked. */
  describe('permission boundary', () => {
    // The exact escalation: the child captured `Write: allow`, the operator has since set `Write: deny`.
    it('refuses a child whose captured rules the caller has since revoked', () => {
      expect(scopeExceedsCurrentAccess(
        scope({ permissionBoundary: boundary([WRITE_ALLOW]) }),
        access({ permissionBoundary: boundary([WRITE_DENY]) }),
      )).toMatch(/permission/i);
    });

    // Strict mode (`unattendedAsks: 'deny'`) is the operator's hard opt-in; a child minted before it must
    // not carry the old 'allow' back into an unattended turn.
    it('refuses a child minted before the caller turned on strict unattended asks', () => {
      expect(scopeExceedsCurrentAccess(
        scope({ permissionBoundary: boundary([READ_ALLOW], 'allow') }),
        access({ permissionBoundary: boundary([READ_ALLOW], 'deny') }),
      )).toMatch(/permission/i);
    });

    // `null` means no permission gate was wired at all — i.e. ungated. A gated caller must not resume it.
    it('refuses an ungated child under a caller that now runs on a permission gate', () => {
      expect(scopeExceedsCurrentAccess(
        scope({ permissionBoundary: null }),
        access({ permissionBoundary: boundary([WRITE_DENY]) }),
      )).toMatch(/permission/i);
    });

    // Rule resolution is last-match-wins, so the same rules in a different order are a DIFFERENT boundary.
    it('refuses rules that match only as a set, not in order', () => {
      expect(scopeExceedsCurrentAccess(
        scope({ permissionBoundary: boundary([WRITE_DENY, WRITE_ALLOW]) }),
        access({ permissionBoundary: boundary([WRITE_ALLOW, WRITE_DENY]) }),
      )).toMatch(/permission/i);
    });

    it('accepts an identical boundary', () => {
      expect(scopeExceedsCurrentAccess(
        scope({ permissionBoundary: boundary([READ_ALLOW, WRITE_DENY]) }),
        access({ permissionBoundary: boundary([READ_ALLOW, WRITE_DENY]) }),
      )).toBeUndefined();
    });

    // An ungated caller has no permission authority to exceed in the first place.
    it('accepts any child boundary when the caller has no permission gate wired', () => {
      expect(scopeExceedsCurrentAccess(
        scope({ permissionBoundary: boundary([WRITE_ALLOW]) }),
        access({ permissionBoundary: null }),
      )).toBeUndefined();
    });

    describe('read-only children', () => {
      // explore/plan children are minted with a clamp, so they never equal their parent's boundary. The
      // continuation is allowed exactly when spawning that child TODAY would mint the same one.
      it('accepts a clamped child that still matches the caller\'s current authority', () => {
        const parent = boundary([READ_ALLOW, WRITE_DENY]);
        expect(scopeExceedsCurrentAccess(
          scope({ permissionBoundary: buildReadOnlyBoundary(parent) }),
          access({ permissionBoundary: parent }),
        )).toBeUndefined();
      });

      it('refuses a clamp minted from authority the caller has since lost', () => {
        expect(scopeExceedsCurrentAccess(
          scope({ permissionBoundary: buildReadOnlyBoundary(boundary([WRITE_ALLOW])) }),
          access({ permissionBoundary: boundary([WRITE_DENY]) }),
        )).toMatch(/permission/i);
      });
    });
  });
});

/** A delegated child is a DURABLE handle: its scope was minted from what the spawning account held at
 *  spawn time and then frozen. Rehydrating it must therefore intersect that frozen scope with the
 *  account's grant as it stands NOW — a child that could out-live a revocation would be a way to keep
 *  using a tool an admin took away. */
describe('delegatedToolPolicy', () => {
  const child = (over: Partial<DelegatedExecutionScope> = {}): DelegatedExecutionScope =>
    scope({ toolPolicy: { allow: ['Read', 'Bash'] }, ...over });

  it('intersects the captured scope with the spawning account\'s current grant', () => {
    expect(delegatedToolPolicy(child(), [], ['Read', 'Write']))
      .toEqual({ allow: new Set(['Read']) }); // Write is granted but was never in the child's scope
  });

  it('stops handing the child a tool the account has since lost', () => {
    // Bash was legitimately captured at spawn; the admin has since revoked it from the account.
    expect(delegatedToolPolicy(child(), [], ['Read'])).toEqual({ allow: new Set(['Read']) });
    // Revoke everything and the child reaches no plugin tool at all, rather than falling back to its scope.
    expect(delegatedToolPolicy(child(), [], [])).toEqual({ allow: new Set() });
  });

  it('never lets an account grant WIDEN what the child was spawned with', () => {
    expect(delegatedToolPolicy(child({ toolPolicy: { allow: ['Read'] } }), [], ['Read', 'Bash', 'Write']))
      .toEqual({ allow: new Set(['Read']) });
  });

  it('narrows an unrestricted child to the account grant, and leaves it alone when there is none', () => {
    // A scope with no allow-list is unrestricted; an account grant is still authority over it.
    expect(delegatedToolPolicy(scope(), [], ['Read'])).toEqual({ allow: new Set(['Read']) });
    // No grant at all (an admin parent) → the captured scope stands unchanged.
    expect(delegatedToolPolicy(child(), [])).toEqual({ allow: new Set(['Read', 'Bash']) });
    expect(delegatedToolPolicy(scope(), [])).toBeUndefined();
  });

  it('applies the account\'s current denies on top of the intersection', () => {
    expect(delegatedToolPolicy(child(), ['Bash'], ['Read', 'Bash']))
      .toEqual({ allow: new Set(['Read', 'Bash']), deny: new Set(['Bash']) });
  });
});
