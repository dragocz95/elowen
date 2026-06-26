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

/** Push `branch` from the worktree to the **named** `origin` remote; returns false (warn) when the repo
 *  has no `origin`. Pushing to the named remote (not a bare URL) keeps `refs/remotes/origin/*` current,
 *  so `--force-with-lease` has a valid lease on every re-push — a bare-URL push never updates the
 *  tracking ref and breaks the lease on the second round ("stale info"). A configured token is injected
 *  as a one-shot `http.extraHeader` (command-scoped, never persisted); without one, git falls back to
 *  the host's credential helper (e.g. `gh`), so the push works token-free. */
export async function pushBranch(dir: string, branch: string, token: string): Promise<boolean> {
  const cwd = realRepo(dir);
  try { await run('git', ['-C', cwd, 'remote', 'get-url', 'origin']); }
  catch { log.warn(`push skipped for ${branch} — no origin remote`); return false; }
  await run('git', ['-C', cwd, ...tokenAuthArgs(token), 'push', '--force-with-lease', 'origin', `${branch}:${branch}`]);
  return true;
}

/** One-shot git auth: when a token is set, pass it as a Basic `AUTHORIZATION` header scoped to this
 *  single command (`-c http.extraHeader=...`), never written to config. Blank token → no args, so git
 *  uses whatever credential helper the host has configured. */
function tokenAuthArgs(token: string): string[] {
  if (!token) return [];
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
  return ['-c', `http.extraHeader=AUTHORIZATION: basic ${basic}`];
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
  // No remote default — common for local-only project checkouts. Use the repo's CURRENT branch so a
  // `master` (or any non-`main` default) still resolves to a REAL branch. Without this, the base falls
  // back to a possibly-nonexistent `main`, `git worktree add` fails, and PR-native mode silently
  // degrades to the shared checkout — which kills the parallelism the worktree was meant to enable.
  try {
    const { stdout } = await run('git', ['-C', cwd, 'symbolic-ref', '--short', 'HEAD']);
    const ref = stdout.trim();
    // Skip an `orca/…` ref: if the main checkout happens to sit on a prior mission branch, basing a new
    // mission off it would chain unrelated work. Only a real base branch (main/master/…) qualifies here.
    if (ref && !ref.startsWith('orca/')) return ref;
  } catch { /* detached HEAD — fall through */ }
  return 'main';
}
