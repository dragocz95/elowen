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

  // `users.allowed_tools` defaults to the `*` marker, so between the deploy and the migration EVERY
  // non-admin grant is literally `['*']` — and a child spawned in that window carries it. Comparing raw
  // membership made `*` "a tool this conversation does not hold", so the moment the migration wrote a real
  // grant, every DelegateContinue against a live child was refused. Nothing is handed back here: the
  // continuation clamps the child to `scope ∩ current grant` on the way in (delegatedToolPolicy), so what
  // it names beyond the caller's grant is unreachable rather than merely unaudited.
  it('accepts a child minted under the pre-migration `*` grant once the caller has a real one', () => {
    expect(scopeExceedsCurrentAccess(
      scope({ toolPolicy: { allow: ['*'] } }),
      access({ toolPolicy: { allow: ['Read', 'Write'] } }),
    )).toBeUndefined();
  });

  // The other half of the same asymmetry: a family name can only ever be matched by pattern.
  it('accepts a child holding an MCP family the caller holds a member of', () => {
    expect(scopeExceedsCurrentAccess(
      scope({ toolPolicy: { allow: ['mcp__*'] } }),
      access({ toolPolicy: { allow: ['mcp__github__issue'] } }),
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
  const expected = (allow?: string[], deny: string[] = []) => ({
    ...(allow !== undefined ? { allow: new Set(allow) } : {}),
    deny: new Set([...deny, 'AskUserQuestion']),
  });

  it('intersects the captured scope with the spawning account\'s current grant', () => {
    expect(delegatedToolPolicy(child(), [], ['Read', 'Write']))
      .toEqual(expected(['Read'])); // Write is granted but was never in the child's scope
  });

  it('stops handing the child a tool the account has since lost', () => {
    // Bash was legitimately captured at spawn; the admin has since revoked it from the account.
    expect(delegatedToolPolicy(child(), [], ['Read'])).toEqual(expected(['Read']));
    // Revoke everything and the child reaches no plugin tool at all, rather than falling back to its scope.
    expect(delegatedToolPolicy(child(), [], [])).toEqual(expected([]));
  });

  it('never lets an account grant WIDEN what the child was spawned with', () => {
    expect(delegatedToolPolicy(child({ toolPolicy: { allow: ['Read'] } }), [], ['Read', 'Bash', 'Write']))
      .toEqual(expected(['Read']));
  });

  it('narrows an unrestricted child to the account grant, and denies interactive tools even without one', () => {
    // A scope with no allow-list is unrestricted; an account grant is still authority over it.
    expect(delegatedToolPolicy(scope(), [], ['Read'])).toEqual(expected(['Read']));
    // No grant at all (an admin parent) keeps the captured scope, except for tools an unattended child
    // cannot complete because no user is attached to answer them.
    expect(delegatedToolPolicy(child(), [])).toEqual(expected(['Read', 'Bash']));
    expect(delegatedToolPolicy(scope(), [])).toEqual(expected());
  });

  // Both sides of the intersection are PATTERN lists, and an exact one is wrong in both directions.
  it('honours a wildcard on either side of the intersection', () => {
    // Pre-migration the account's grant is the `*` marker: it restricts nothing, so the scope stands.
    expect(delegatedToolPolicy(child(), [], ['*'])).toEqual(expected(['Read', 'Bash']));
    // A scope holding an MCP FAMILY narrows to the members the account was actually granted — the family
    // name itself can never equal a concrete grant, and dropping it lost the child MCP entirely.
    expect(delegatedToolPolicy(child({ toolPolicy: { allow: ['Read', 'mcp__*'] } }), [], ['Read', 'mcp__github__issue']))
      .toEqual(expected(['Read', 'mcp__github__issue']));
    // …and it is still a narrowing: a member outside the family stays out.
    expect(delegatedToolPolicy(child({ toolPolicy: { allow: ['mcp__*'] } }), [], ['Bash', 'mcp__github__issue']))
      .toEqual(expected(['mcp__github__issue']));
  });

  it('applies the account\'s current denies on top of the mandatory interactive-tool deny', () => {
    expect(delegatedToolPolicy(child(), ['Bash'], ['Read', 'Bash']))
      .toEqual(expected(['Read', 'Bash'], ['Bash']));
  });
});
