import { realpathSync } from 'node:fs';
import { resolve, sep, dirname, basename, join } from 'node:path';
import { currentPolicy } from './policyContext.js';

/** The repo roots the current session may operate in. Empty for an admin (all-access) or outside a
 *  prompt turn. A tool uses this to default a working directory. */
export function allowedRoots(): string[] {
  return currentPolicy()?.allowedPaths() ?? [];
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

/** Resolve `path` to its real absolute path and assert it is inside one of the current session's
 *  allowed repo roots (or that the session is admin all-access). Throws a clear Error otherwise.
 *  This is the single enforcement point the file/terminal tools call before touching disk. */
export function assertPathAllowed(path: string): string {
  const abs = realAbs(path);
  if (isAllAccess()) return abs;
  const within = (root: string): boolean => {
    const real = realAbs(root); // the root itself may be reached via a symlink
    const base = real.endsWith(sep) ? real.slice(0, -1) : real;
    return abs === base || abs.startsWith(base + sep);
  };
  if (allowedRoots().some(within)) return abs;
  throw new Error(`path not allowed: "${path}" is outside your accessible repositories`);
}
