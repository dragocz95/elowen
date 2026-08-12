import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';

const run = promisify(execFile);

/** Cap on untracked files rendered into a review diff — bounds the work (and the diff size) when an
 *  agent drops a large new tree; the overseer still sees the change list for the rest. */
const REVIEW_UNTRACKED_LIMIT = 50;

/** Working-tree evidence for an overseer review: the changed-file list (with INDIVIDUAL untracked
 *  files, not just their parent dir) plus a unified diff that ALSO covers brand-new untracked files.
 *  Plain `git diff HEAD` omits untracked files — the common case when an agent creates files — so each
 *  is rendered as a "new file" diff via `git diff --no-index`, which is read-only and never mutates
 *  the index. Empty evidence on a non-repo / git failure. Moved from core projectFiles.ts with the
 *  review gate (the plugin compile unit cannot runtime-import core modules). */
export async function projectReviewDiff(root: string): Promise<{ changedFiles: string[]; diff: string }> {
  let cwd: string;
  try { cwd = realpathSync(resolve(root)); } catch { return { changedFiles: [], diff: '' }; }
  const changedFiles: string[] = [];
  try {
    // `-uall` lists every untracked file individually instead of collapsing a new dir to `dir/`.
    const { stdout } = await run('git', ['-C', cwd, 'status', '--porcelain', '-uall'], { maxBuffer: 4 * 1024 * 1024 });
    for (const line of stdout.split('\n')) {
      const p = line.slice(3).trim();              // strip the 2-char XY status + space
      if (!p) continue;
      const a = p.indexOf(' -> ');                 // rename → new path
      changedFiles.push(a >= 0 ? p.slice(a + 4) : p);
    }
  } catch {
    return { changedFiles: [], diff: '' };          // not a git repo / git unavailable
  }
  let diff = '';
  // Tracked, uncommitted changes. HEAD may not exist on a repo with no commits — tolerate that.
  try { diff += (await run('git', ['-C', cwd, 'diff', 'HEAD'], { maxBuffer: 8 * 1024 * 1024 })).stdout; } catch { /* no HEAD yet */ }
  // Untracked files (respecting .gitignore) rendered as new-file additions.
  try {
    const { stdout } = await run('git', ['-C', cwd, 'ls-files', '--others', '--exclude-standard'], { maxBuffer: 4 * 1024 * 1024 });
    for (const f of stdout.split('\n').filter(Boolean).slice(0, REVIEW_UNTRACKED_LIMIT)) {
      // `git diff --no-index` exits 1 when the inputs differ (a new file always does), which rejects;
      // the patch is still on the error's stdout. Read it either way — no index mutation.
      try {
        diff += (await run('git', ['-C', cwd, 'diff', '--no-index', '--', '/dev/null', f], { maxBuffer: 8 * 1024 * 1024 })).stdout;
      } catch (e) {
        const out = (e as { stdout?: string }).stdout;
        if (typeof out === 'string') diff += out;
      }
    }
  } catch { /* no untracked files / git unavailable */ }
  return { changedFiles, diff };
}
