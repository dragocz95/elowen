import { resolve, sep } from 'node:path';
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

/** Resolve `path` to an absolute path and assert it is inside one of the current session's allowed repo
 *  roots (or that the session is admin all-access). Throws a clear Error otherwise. This is the single
 *  enforcement point the file/terminal tools call before touching disk. */
export function assertPathAllowed(path: string): string {
  const abs = resolve(path);
  if (isAllAccess()) return abs;
  const roots = allowedRoots();
  const within = (root: string): boolean => {
    const base = root.endsWith(sep) ? root.slice(0, -1) : root;
    return abs === base || abs.startsWith(base + sep);
  };
  if (roots.some(within)) return abs;
  throw new Error(`path not allowed: "${path}" is outside your accessible repositories`);
}
