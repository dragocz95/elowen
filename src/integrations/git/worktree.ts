import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { logger } from '../../shared/logger.js';

const run = promisify(execFile);
const log = logger('worktree');

/** Resolve a repo root to its real path (mirrors projectFiles' guard) so every git call runs against a
 *  stable, symlink-followed cwd. */
const realRepo = (repo: string): string => realpathSync(resolve(repo));

/** Create a git worktree at `dir` checked out on `branch`, based off `base`. Re-engaging a mission can
 *  hit an already-existing branch (the prior worktree was removed but the branch kept) — in that case
 *  attach the existing branch instead of recreating it. */
export async function createMissionWorktree(repo: string, branch: string, base: string, dir: string): Promise<void> {
  const cwd = realRepo(repo);
  try {
    await run('git', ['-C', cwd, 'worktree', 'add', '-b', branch, dir, base]);
  } catch (e) {
    // Branch already exists → attach it to a fresh worktree rather than failing the engage.
    const msg = String((e as { stderr?: string }).stderr ?? e);
    if (/already exists|already used by worktree|is not a valid/i.test(msg)) {
      await run('git', ['-C', cwd, 'worktree', 'add', dir, branch]);
    } else {
      throw e;
    }
  }
}

/** Remove a mission's worktree (force, since it may hold uncommitted state) and prune the registry.
 *  The branch is intentionally left behind so an open PR keeps its commits. Never throws — a missing
 *  worktree on cleanup is fine. */
export async function removeWorktree(repo: string, dir: string): Promise<void> {
  const cwd = realRepo(repo);
  try {
    await run('git', ['-C', cwd, 'worktree', 'remove', '--force', dir]);
  } catch (e) {
    log.warn(`worktree remove failed for ${dir} — pruning`, e);
  }
  try { await run('git', ['-C', cwd, 'worktree', 'prune']); } catch { /* best-effort */ }
}

/** Stage everything in the worktree and commit with `message`. Returns true when a commit was made,
 *  false when there was nothing to commit (empty diff → no-op, never an empty commit). */
export async function commitAll(dir: string, message: string): Promise<boolean> {
  const cwd = realRepo(dir);
  await run('git', ['-C', cwd, 'add', '-A']);
  // `git diff --cached --quiet` exits 0 when the index matches HEAD (nothing staged), 1 when it differs.
  try {
    await run('git', ['-C', cwd, 'diff', '--cached', '--quiet']);
    return false; // exit 0 → no staged changes
  } catch { /* exit 1 → there is something to commit */ }
  await run('git', ['-C', cwd, 'commit', '-m', message]);
  return true;
}

/** Push `branch` from the worktree to origin using a short-lived token-auth remote URL. GitHub-only;
 *  returns false (warn) when the repo has no `origin` remote. The token is embedded in the remote URL
 *  of a single push and never persisted to the repo config. */
export async function pushBranch(dir: string, branch: string, token: string): Promise<boolean> {
  const cwd = realRepo(dir);
  let origin = '';
  try { origin = (await run('git', ['-C', cwd, 'remote', 'get-url', 'origin'])).stdout.trim(); }
  catch { log.warn(`push skipped for ${branch} — no origin remote`); return false; }
  await run('git', ['-C', cwd, 'push', '--force-with-lease', authenticatedRemote(origin, token), `${branch}:${branch}`]);
  return true;
}

/** Rewrite an https GitHub remote to embed a token for a single push. SSH or non-GitHub remotes (and a
 *  blank token) are returned unchanged — token auth doesn't apply. */
function authenticatedRemote(origin: string, token: string): string {
  if (!token) return origin;
  const m = /^https:\/\/(?:[^@/]+@)?github\.com\/(.+?)(?:\.git)?\/?$/i.exec(origin);
  return m ? `https://x-access-token:${token}@github.com/${m[1]}.git` : origin;
}

/** The base branch a PR targets: an explicit `configured` value wins; otherwise detect the remote's
 *  default branch (`origin/HEAD`), falling back to `main` when there's no remote. */
export async function detectBaseBranch(repo: string, configured: string): Promise<string> {
  if (configured.trim()) return configured.trim();
  const cwd = realRepo(repo);
  try {
    const { stdout } = await run('git', ['-C', cwd, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
    const ref = stdout.trim().replace(/^origin\//, '');
    if (ref) return ref;
  } catch { /* no origin/HEAD — fall through */ }
  return 'main';
}
