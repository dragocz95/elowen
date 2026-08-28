import { basename, dirname, join } from 'node:path';
import { currentContributionUserId, currentIdentity, currentPathView, currentPolicy, currentSessionId, currentToolPolicy, currentTurnMode, currentTurnPermissions, currentWorkDir, turnPrincipal } from './policyContext.js';
import { noninteractivePermissionBoundary, type NoninteractivePermissionBoundary } from '../brain/toolPermissions.js';
import { planFilePath, sessionToolResultSpillDir } from '../shared/paths.js';
import { realAbs, realPathWithin } from './pathUtils.js';
export { realPathWithin } from './pathUtils.js';

/** The repo roots the current session may operate in. Empty for an admin (all-access) or outside a
 *  prompt turn. A tool uses this to default a working directory. */
export function allowedRoots(): string[] {
  return currentPolicy()?.allowedPaths() ?? [];
}

/** Where exec/file tools run when the caller names no directory — the ONE default-cwd resolution:
 *  the project path the turn's session is bound to, else the first allowed repo root, else the
 *  daemon's own cwd (admin all-access carries no roots). The bound path lives on the per-run turn
 *  scope, so it re-asserts itself at the start of every run regardless of where the agent moved. */
export function defaultCwd(): string {
  return currentPathView()?.root ?? currentWorkDir() ?? allowedRoots()[0] ?? process.cwd();
}

/** Whether the current session has unrestricted (admin) access to the filesystem. */
export function isAllAccess(): boolean {
  return currentPolicy()?.allowedProjectIds === 'all';
}

/** The current turn's complete access as a plain descriptor a plugin can safely forward to a sub-agent.
 *  Owner truth stays independent from admin project scope, Set policies cross the platform boundary as
 *  arrays without losing the significant empty-allow-list case, and the effective granular permission
 *  boundary is snapshotted rather than re-resolved from the durable child row owner later.
 *
 *  A turn running in PLAN mode stamps `readOnly`, which the host bakes into the child's toolset and
 *  permission boundary (brain/platforms.ts). Forced here, at the single source every spawner reads, so
 *  both Delegate and WorkflowStart inherit it by construction: the plugin only ever ADDS `readOnly` from
 *  its own argument and never clears it, so a planning turn cannot talk its way into a writing child.
 *
 *  `planMode` is stamped ALONGSIDE `readOnly` rather than folded into it because the two answer different
 *  questions once a child can be promoted out of read-only: `readOnly` says the child gets read-only
 *  tools, `planMode` says the read-only came from a boundary on the PARENT rather than the parent's own
 *  choice. Only the second one is a permanent lock (see DelegatedExecutionScope.readOnlyOrigin).
 *  `principal` identifies whose turn this is, so a child records who spawned it and only that same
 *  identity can later widen it. */
export function currentAccess(): { projectIds: number[]; admin: boolean; owner: boolean; toolPolicy?: { allow?: string[]; deny?: string[] }; permissionBoundary: NoninteractivePermissionBoundary | null; contributionUserId: number | null; readOnly?: boolean; planMode?: boolean; principal?: string; workspaceRef?: { workspaceId: string; projectId: number } } {
  const p = currentPolicy();
  const principal = turnPrincipal(currentIdentity());
  const tools = currentToolPolicy();
  const pathView = currentPathView();
  const toolPolicy = tools ? {
    ...(tools.allow ? { allow: [...tools.allow] } : {}),
    ...(tools.deny ? { deny: [...tools.deny] } : {}),
  } : undefined;
  return {
    projectIds: !p || p.allowedProjectIds === 'all' ? [] : [...p.allowedProjectIds],
    admin: p?.allowedProjectIds === 'all',
    owner: currentIdentity()?.owner === true,
    permissionBoundary: noninteractivePermissionBoundary(currentTurnPermissions()),
    contributionUserId: currentContributionUserId(),
    ...(toolPolicy ? { toolPolicy } : {}),
    ...(currentTurnMode() === 'plan' ? { readOnly: true, planMode: true } : {}),
    ...(principal ? { principal } : {}),
    ...(pathView ? { workspaceRef: pathView.workspace } : {}),
  };
}

/** Is `candidate` exactly this session's plan file?
 *
 *  This is a SECURITY boundary, not a convenience. Plan mode is read-only because it withholds every
 *  writing tool; admitting one back so the model can author its plan is only safe while this predicate
 *  is exact. A false positive here does not misplace a file — it hands plan mode arbitrary write access.
 *
 *  Two properties do the work, and both are needed:
 *
 *  1. The candidate is resolved through symlinks and `..` BEFORE anything is compared, so neither a
 *     traversal nor a link in a parent directory can point somewhere else while spelling the right path.
 *  2. The resolved path must land INSIDE the plans directory. Comparing it against the resolved expected
 *     path alone would look right and be wrong: if the plan file were itself a symlink pointing out of
 *     the directory, both sides would resolve to the same foreign target and agree. Containment is what
 *     refuses that, so it is checked first and the file name is matched inside the RESOLVED directory.
 *
 *  Deny-by-default throughout: anything unresolvable, relative to nowhere, or merely near the plan file
 *  is refused. What this cannot cover is a swap between this check and the write that follows it; the
 *  plans directory lives under the daemon's own config dir and a plan turn has no tool able to create a
 *  link there, so the window is closed by what plan mode withholds rather than by this function.
 *
 *  It lives HERE rather than beside the plan store because both users need it and one of them is
 *  `assertPathAllowed` below: the plan store already depends on this module, so keeping the predicate
 *  there would have forced a cycle to reach it. */
export function isSessionPlanPath(sessionId: string, candidate: string): boolean {
  if (!candidate) return false;
  const expected = planFilePath(process.env, sessionId);
  const plansDir = dirname(expected);
  const resolved = realPathWithin(candidate, [plansDir]);
  if (!resolved) return false;
  return resolved === join(realAbs(plansDir), basename(expected));
}

/** Resolve `path` to its real absolute path and assert it is inside one of the current session's
 *  allowed repo roots (or that the session is admin all-access). Throws a clear Error otherwise.
 *  This is the single enforcement point the file/terminal tools call before touching disk.
 *
 *  A second non-repo allowance: the session's OWN plan file. Plan mode tells the model to write its
 *  plan to a path under the daemon's config dir, which is no repository — so without this every
 *  project-scoped user would be handed a path they are forbidden to write, and plan mode would be
 *  unusable for everyone except admin all-access sessions (which return early above and are the only
 *  reason this went unnoticed). Scoped per-session by the same exact predicate the plan-mode write
 *  clamp uses, so this widens the boundary by exactly one file and never another session's.
 *
 *  One non-repo allowance: the session's OWN tool-result spill dir. Clearing swaps large historical
 *  tool outputs for a placeholder that names the spill path and tells the model to Read it back —
 *  that promise must hold for EVERY session class (shared channels, delegated workers), not just
 *  admin all-access, or cleared content would be unrecoverable for them. Scoped per-session: no
 *  session can ever reach another session's spills. Writes there can't corrupt clearing either —
 *  an EEXIST survivor is latched only when its bytes match the output being spilled. */
export function assertPathAllowed(path: string): string {
  const pathView = currentPathView();
  if (pathView) return pathView.resolve(path);
  if (isAllAccess()) return realAbs(path);
  const abs = realPathWithin(path, allowedRoots());
  if (abs) return abs;
  const sessionId = currentSessionId();
  if (sessionId) {
    if (isSessionPlanPath(sessionId, path)) return realAbs(path);
    // Resolved through the session's immutable spill NAMESPACE, not its re-keyable id: after a channel
    // rollover or a /context bind the conversation keeps reading the directory its placeholders already
    // name, and a fresh conversation minted onto the freed id never inherits access to them.
    const spill = realPathWithin(path, [sessionToolResultSpillDir(process.env, sessionId)]);
    if (spill) return spill;
  }
  throw new Error(`path not allowed: "${path}" is outside your accessible repositories`);
}

/** Model-facing path for a host path already validated by {@link assertPathAllowed}. */
export function displayPath(path: string): string {
  return currentPathView()?.display(path) ?? path;
}

/** Stable read-before-edit identity. Workspace-scoped turns include the durable workspace id. */
export function pathStateKey(path: string): string {
  return currentPathView()?.stateKey(path) ?? path;
}

/** Scrub exact verified workspace prefixes from filesystem/library diagnostics. */
export function sanitizePathOutput(text: string): string {
  return currentPathView()?.sanitize(text) ?? text;
}
