import {
  dedupeRulesKeepingLast,
  normalizeNoninteractivePermissionBoundary,
  NON_DESTRUCTIVE_BASH_RULES,
  type NoninteractivePermissionBoundary,
  type PermissionRule,
} from '../toolPermissions.js';

/** The restrictions layered onto a read-only agent's boundary, in order. Appended AFTER the parent's own
 *  rules so — with last-match-wins resolution — they win over an inherited allow: Write/Edit are denied,
 *  then the shared shell clamp (deny everything, re-permit the non-destructive allow-list, claw back the
 *  exec/delete escapes — see NON_DESTRUCTIVE_BASH_RULES for why each rule is there). The clamp does NOT
 *  block writes: a read-only agent may redirect output into any file the daemon's user can reach. What
 *  "read-only" still guarantees here is no Write/Edit tool and no destructive, system or network
 *  commands. `Write`/`Edit` deny is defense-in-depth (a read-only agent never holds them in its tool
 *  allow-list either). */
const READ_ONLY_RESTRICT_RULES: readonly PermissionRule[] = [
  { scope: 'tools', pattern: 'Write', action: 'deny' },
  { scope: 'tools', pattern: 'Edit', action: 'deny' },
  ...NON_DESTRUCTIVE_BASH_RULES,
];

/**
 * Where a delegated child's read-only mode came from — the value persisted on its durable scope as
 * `readOnlyOrigin`, and the whole basis on which a later DelegateContinue may or may not lift the clamp.
 *
 * Only a clamp the delegating turn CHOSE is liftable, because only then did that turn hold the wider
 * access it is later asked to hand over. The two `imposed` sources are not the caller's to lift:
 *  - `agentReadOnly`: the agent TYPE is defined read-only in its `.md` frontmatter. That is the operator's
 *    definition of the role, not a per-call preference, so promoting an `explore` agent into a writing one
 *    would quietly redefine a type the operator wrote down.
 *  - `planMode`: the delegating turn was itself read-only. It never held write access to give, and the
 *    child must not become a durable handle it can cash in after leaving plan mode.
 * Returns undefined when the child is not read-only at all — there is nothing to promote, and marking it
 * would let an ordinary narrow `tools:` delegation be widened to the caller's full toolset.
 */
export function resolveReadOnlyOrigin(
  input: { agentReadOnly: boolean; requested: boolean; planMode: boolean },
): 'requested' | 'imposed' | undefined {
  if (!input.agentReadOnly && !input.requested) return undefined;
  return input.agentReadOnly || input.planMode ? 'imposed' : 'requested';
}

/**
 * Mint the immutable permission boundary for a read-only sub-agent (explore/plan).
 *
 * A sub-agent runs UNATTENDED — there is no human to answer an `ask`, so an inherited `ask` resolves via
 * the parent's `unattendedAsks` (default 'allow'), which would let a "read-only" agent holding the Bash
 * tool run `rm -rf`. This mints a strictly narrower boundary: the parent's rules, then the read-only
 * restrictions above, then the parent's own DENY rules re-asserted last, with `unattendedAsks: 'deny'`.
 *
 * The order is load-bearing (last-match-wins):
 *  - parent rules first, so the operator's baseline carries through;
 *  - the read-only restrictions next, so Write/Edit and destructive shell are clamped and only the
 *    non-destructive allow-list runs;
 *  - the parent's DENY rules re-asserted LAST, so a command the operator explicitly denied can never be
 *    re-permitted by our allow-list — the boundary can only ever NARROW, never widen.
 * A null parent (permission gate absent) falls back to a minimal allow-all-tools base the restrictions
 * clamp down.
 */
export function buildReadOnlyBoundary(parent: NoninteractivePermissionBoundary | null): NoninteractivePermissionBoundary {
  const base: PermissionRule[] = parent ? parent.rules : [{ scope: 'tools', pattern: '*', action: 'allow' }];
  const parentDenies = base.filter((rule) => rule.action === 'deny');
  const boundary = normalizeNoninteractivePermissionBoundary({
    rules: dedupeRulesKeepingLast([...base, ...READ_ONLY_RESTRICT_RULES, ...parentDenies]),
    unattendedAsks: 'deny',
  });
  // The base was already validated on read and the appended rules are well-formed literals, so this
  // cannot fail — assert it so a future normalizer change can never silently widen the boundary.
  if (!boundary) throw new Error('invalid read-only agent boundary');
  return boundary;
}
