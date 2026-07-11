import type { ToolPolicy } from '../plugins/policyContext.js';
import {
  normalizeNoninteractivePermissionBoundary,
  type NoninteractivePermissionBoundary,
} from './toolPermissions.js';

/**
 * The immutable execution boundary minted for a delegated child.  A child is a durable conversation:
 * after an LRU eviction or an idle drill-in continuation it must resume with this boundary, never with
 * the account owner's ambient all-access policy.  Arrays (rather than Sets) make the boundary safe to
 * store as JSON and deliberately retain an empty allow-list (`allow: []` means no plugin tools).
 */
export interface DelegatedExecutionScope {
  admin: boolean;
  projectIds: number[];
  owner: boolean;
  toolPolicy?: { allow?: string[]; deny?: string[] };
  /** Captured effective granular permission rules for this unattended child. Explicit `null` means the
   * delegating turn had no permission gate wired at all; an absent/malformed field is legacy/corrupt and
   * must fail closed. */
  permissionBoundary: NoninteractivePermissionBoundary | null;
  /** System-prompt appendices that describe the child role. Kept with the execution boundary so an
   * evicted child is rebuilt with the same focused-agent instruction before a later continuation. */
  promptAppend?: string[];
}

const MAX_PROJECT_IDS = 10_000;
const MAX_TOOL_NAMES = 2_000;
const MAX_TOOL_NAME_CHARS = 256;
const MAX_PROMPT_CHUNKS = 16;
const MAX_PROMPT_CHARS = 8_000;
const MAX_PROMPT_TOTAL_CHARS = 32_000;
const own = (value: object, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);

function canonicalStrings(raw: unknown, maxItems: number, maxChars: number): string[] | undefined {
  if (!Array.isArray(raw) || raw.length > maxItems) return undefined;
  const values: string[] = [];
  for (const value of raw) {
    if (typeof value !== 'string') return undefined;
    const clean = value.trim();
    if (!clean || clean.length > maxChars) return undefined;
    values.push(clean);
  }
  return [...new Set(values)].sort();
}

/** Validate and canonicalize persisted/untrusted JSON. Invalid state is intentionally indistinguishable
 * from missing state to callers: both must fail closed before an idle child can execute. */
export function normalizeDelegatedExecutionScope(raw: unknown): DelegatedExecutionScope | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  if (typeof value.admin !== 'boolean' || typeof value.owner !== 'boolean') return undefined;
  if (!Array.isArray(value.projectIds) || value.projectIds.length > MAX_PROJECT_IDS) return undefined;
  const projectIds: number[] = [];
  for (const id of value.projectIds) {
    if (!Number.isSafeInteger(id) || id <= 0) return undefined;
    projectIds.push(id);
  }
  const canonicalProjectIds = [...new Set(projectIds)].sort((a, b) => a - b);
  // `all` is represented by admin=true and no project list; accepting both shapes would make a corrupted
  // row ambiguous and risks a later caller interpreting its project list as a narrower policy.
  if (value.admin && canonicalProjectIds.length) return undefined;

  // Required even when the installation has no granular-permission resolver: explicit null preserves
  // that exact "gate inert" behavior, while a missing field identifies an old/corrupted child that must
  // never resume under its durable row owner's ambient settings.
  if (!own(value, 'permissionBoundary')) return undefined;
  let permissionBoundary: NoninteractivePermissionBoundary | null;
  if (value.permissionBoundary === null) {
    permissionBoundary = null;
  } else {
    const normalized = normalizeNoninteractivePermissionBoundary(value.permissionBoundary);
    if (!normalized) return undefined;
    permissionBoundary = normalized;
  }

  let toolPolicy: DelegatedExecutionScope['toolPolicy'];
  if (own(value, 'toolPolicy')) {
    const rawPolicy = value.toolPolicy;
    if (!rawPolicy || typeof rawPolicy !== 'object' || Array.isArray(rawPolicy)) return undefined;
    const policy = rawPolicy as Record<string, unknown>;
    const hasAllow = own(policy, 'allow');
    const hasDeny = own(policy, 'deny');
    if (hasAllow && !Array.isArray(policy.allow)) return undefined;
    if (hasDeny && !Array.isArray(policy.deny)) return undefined;
    const allow = hasAllow ? canonicalStrings(policy.allow, MAX_TOOL_NAMES, MAX_TOOL_NAME_CHARS) : undefined;
    const deny = hasDeny ? canonicalStrings(policy.deny, MAX_TOOL_NAMES, MAX_TOOL_NAME_CHARS) : undefined;
    if ((hasAllow && !allow) || (hasDeny && !deny)) return undefined;
    if (hasAllow || hasDeny) toolPolicy = {
      ...(hasAllow ? { allow: allow! } : {}),
      ...(hasDeny ? { deny: deny! } : {}),
    };
  }

  let promptAppend: string[] | undefined;
  if (own(value, 'promptAppend')) {
    promptAppend = canonicalStrings(value.promptAppend, MAX_PROMPT_CHUNKS, MAX_PROMPT_CHARS);
    if (!promptAppend || promptAppend.reduce((n, text) => n + text.length, 0) > MAX_PROMPT_TOTAL_CHARS) return undefined;
    // System-prompt append order is meaningful. canonicalStrings sorts, so re-read the validated source
    // preserving its original order while deduplicating exact repeated chunks.
    const ordered = value.promptAppend as string[];
    const seen = new Set<string>();
    promptAppend = ordered.map((text) => text.trim()).filter((text) => {
      if (seen.has(text)) return false;
      seen.add(text);
      return true;
    });
  }

  return {
    admin: value.admin,
    projectIds: canonicalProjectIds,
    owner: value.owner,
    permissionBoundary,
    ...(toolPolicy ? { toolPolicy } : {}),
    ...(promptAppend ? { promptAppend } : {}),
  };
}

/** Semantically compare canonical durable scopes without trusting caller object identity or array order. */
export function sameDelegatedExecutionScope(a: DelegatedExecutionScope, b: DelegatedExecutionScope): boolean {
  const left = normalizeDelegatedExecutionScope(a);
  const right = normalizeDelegatedExecutionScope(b);
  return !!left && !!right && JSON.stringify(left) === JSON.stringify(right);
}

/** Add an account-level deny-list to an inherited scope. This only narrows access; an old deny remains
 * durable even if the account later re-enables that tool. */
export function withDelegatedDeniedTools(scope: DelegatedExecutionScope, denied: Iterable<string>): DelegatedExecutionScope {
  const extra = [...denied]
    .filter((name): name is string => typeof name === 'string')
    .map((name) => name.trim())
    .filter((name) => name.length > 0 && name.length <= MAX_TOOL_NAME_CHARS);
  // Preserve the captured JSON shape when there is nothing new to add. In particular, undefined policy
  // is distinct from the deliberately restrictive `allow: []` form and should not gain a synthetic
  // empty deny-list merely because this helper ran.
  if (extra.length === 0) {
    const unchanged = normalizeDelegatedExecutionScope(scope);
    if (!unchanged) throw new Error('invalid delegated access');
    return unchanged;
  }
  const normalized = normalizeDelegatedExecutionScope({
    ...scope,
    toolPolicy: {
      ...(scope.toolPolicy?.allow !== undefined ? { allow: scope.toolPolicy.allow } : {}),
      deny: [...(scope.toolPolicy?.deny ?? []), ...extra],
    },
  });
  // `scope` was validated on persistence/read and the bounded account list above cannot make it invalid.
  // Keep the explicit assertion here so a future change to the normalizer does not accidentally widen it.
  if (!normalized) throw new Error('invalid delegated access');
  return normalized;
}

/** Rehydrate the execution-time plugin-tool policy. An empty allow-list is preserved as a real empty Set. */
export function delegatedToolPolicy(scope: DelegatedExecutionScope, currentDenied: Iterable<string> = []): ToolPolicy | undefined {
  const narrowed = withDelegatedDeniedTools(scope, currentDenied);
  const allow = narrowed.toolPolicy?.allow;
  const deny = narrowed.toolPolicy?.deny;
  if (allow === undefined && (!deny || deny.length === 0)) return undefined;
  return {
    ...(allow !== undefined ? { allow: new Set(allow) } : {}),
    ...(deny && deny.length ? { deny: new Set(deny) } : {}),
  };
}
