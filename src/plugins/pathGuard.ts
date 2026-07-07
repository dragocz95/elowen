import { realpathSync } from 'node:fs';
import { resolve, sep, dirname, basename, join } from 'node:path';
import { currentPolicy, currentWorkDir } from './policyContext.js';

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
  return currentWorkDir() ?? allowedRoots()[0] ?? process.cwd();
}

/** Whether the current session has unrestricted (admin) access to the filesystem. */
export function isAllAccess(): boolean {
  return currentPolicy()?.allowedProjectIds === 'all';
}

/** The current turn's access as a plain descriptor a plugin can forward when delegating to a sub-agent:
 *  admin (all repos) or an explicit project-id list. */
export function currentAccess(): { projectIds: number[]; admin: boolean } {
  const p = currentPolicy();
  if (!p || p.allowedProjectIds === 'all') return { projectIds: [], admin: p?.allowedProjectIds === 'all' };
  return { projectIds: [...p.allowedProjectIds], admin: false };
}

/** Resolve to the REAL absolute path (symlinks followed), so a link inside an allowed repo pointing
 *  outside it can't smuggle access past the prefix check. A not-yet-existing target (a new file)
 *  resolves through its closest existing ancestor instead. */
function realAbs(path: string): string {
  const abs = resolve(path);
  try { return realpathSync(abs); }
  catch {
    try { return join(realpathSync(dirname(abs)), basename(abs)); }
    catch { return abs; } // deeper non-existent path — any disk op will ENOENT anyway
  }
}

/** `path` resolved to its real absolute form when it lies inside one of `roots`, else null. The
 *  explicit-roots variant of {@link assertPathAllowed} for callers OUTSIDE a policy turn scope
 *  (e.g. validating a client-reported cwd against a Policy before the scope is established). */
export function realPathWithin(path: string, roots: string[]): string | null {
  const abs = realAbs(path);
  const within = (root: string): boolean => {
    const real = realAbs(root); // the root itself may be reached via a symlink
    const base = real.endsWith(sep) ? real.slice(0, -1) : real;
    return abs === base || abs.startsWith(base + sep);
  };
  return roots.some(within) ? abs : null;
}

/** Resolve `path` to its real absolute path and assert it is inside one of the current session's
 *  allowed repo roots (or that the session is admin all-access). Throws a clear Error otherwise.
 *  This is the single enforcement point the file/terminal tools call before touching disk. */
export function assertPathAllowed(path: string): string {
  if (isAllAccess()) return realAbs(path);
  const abs = realPathWithin(path, allowedRoots());
  if (abs) return abs;
  throw new Error(`path not allowed: "${path}" is outside your accessible repositories`);
}
