import { realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

/** Path containment, resolved through symlinks — the ONE helper both the project-root discovery
 *  (manager.ts) and the tool boundary selection (tools.ts) use, so "is this file inside that repo"
 *  answers the same way everywhere. Mirrors the host's `realPathWithin` semantics (resolve both sides,
 *  then compare) without importing it: a plugin's runtime must not reach into the daemon's module graph. */
export function canonical(path: string): string {
  try { return realpathSync(path); }
  catch { return resolve(path); }
}

/** True when `path` is `root` itself or lies beneath it. Both sides are expected to be canonical. */
export function pathWithin(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

/** `path` (canonicalized) lies inside `root` (canonicalized) — the un-canonicalized entry point callers
 *  use when either side may be a symlink or a relative spelling. */
export function containsPath(root: string, path: string): boolean {
  return pathWithin(canonical(path), canonical(root));
}
