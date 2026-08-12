import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/** Resolve to the REAL absolute path (symlinks followed) — the ONE helper both project-root discovery
 *  (manager.ts) and tool boundary selection (tools.ts) use, so "is this file inside that repo" answers
 *  the same way everywhere.
 *
 *  A not-yet-existing target resolves through its closest EXISTING ancestor, which is then re-appended
 *  with the missing tail. Falling back to a lexical `resolve()` instead would hide a symlinked ancestor:
 *  `<root>/link/a/b` (link → outside the root) would read as inside it. This mirrors the host's
 *  `realAbs` (src/plugins/pathGuard.ts) deliberately — a plugin's runtime must not import the daemon's
 *  module graph, but it must not weaken the rule it is restating either. */
export function canonical(path: string): string {
  const abs = resolve(path);
  const missing: string[] = [];
  let cur = abs;
  for (;;) {
    try {
      const real = realpathSync(cur);
      return missing.length ? join(real, ...missing) : real;
    } catch {
      const parent = dirname(cur);
      if (parent === cur) return abs; // nothing on this path exists — any disk op will ENOENT anyway
      missing.unshift(basename(cur));
      cur = parent;
    }
  }
}

/** True when `path` is `root` itself or lies beneath it. Both sides are expected to be canonical. */
export function pathWithin(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

/** `path` (canonicalized) lies inside `root` (canonicalized) — the entry point for callers where either
 *  side may be a symlink, a relative spelling, or not exist yet. */
export function containsPath(root: string, path: string): boolean {
  return pathWithin(canonical(path), canonical(root));
}
