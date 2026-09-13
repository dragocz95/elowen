import { execFile } from 'node:child_process';
import { lstatSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

// Retirement compatibility for the account-owned Git workspaces. The subsystem is gone, but an instance
// that ran it still holds real worktrees under `users/<account>/workspaces/<label>`, and those directories
// are REGISTERED in the Project repositories they were cut from. Deleting the account's data removes the
// directories; leaving the repositories' administrative entries behind would leave every such Project
// reporting a worktree that does not exist, and `git worktree list` would be wrong until somebody pruned
// it by hand. This module proves which repositories that is, from Git's own metadata, and prunes exactly
// those — it offers no workspace API and creates nothing.

/** Bound on the only command here. `worktree prune` touches local administrative files, never a remote, so
 *  a repository that cannot finish inside the window is reported instead of waited on. */
const PRUNE_TIMEOUT_MS = 10_000;
const execFileAsync = promisify(execFile);

function readText(file) {
  try { return readFileSync(file, 'utf8'); } catch { return null; }
}

function entryOf(path) {
  try { return lstatSync(path); } catch { return null; }
}

/** The real path of a directory, with symlinks resolved, or null when it is not one. */
function realDirectory(path) {
  try {
    const real = realpathSync(path);
    return statSync(real).isDirectory() ? real : null;
  } catch { return null; }
}

/** The one line Git writes into a linked worktree's `.git` file: `gitdir: <path>`. Strict on purpose —
 *  a file carrying anything else was not written by `git worktree add`, so it proves nothing. */
function worktreeGitFile(file) {
  const text = readText(file);
  if (text === null) return null;
  const lines = text.split('\n').map((line) => line.trim()).filter((line) => line !== '');
  if (lines.length !== 1 || !lines[0].startsWith('gitdir:')) return null;
  const value = lines[0].slice('gitdir:'.length).trim();
  return value === '' ? null : value;
}

/** A worktree administrative directory's pointer file (`gitdir`, `commondir`): exactly one path. */
function pointerFile(file) {
  const text = readText(file);
  if (text === null) return null;
  const lines = text.split('\n').map((line) => line.trim()).filter((line) => line !== '');
  return lines.length === 1 ? lines[0] : null;
}

/** What Git itself requires of a repository directory before it will run a worktree command in it. */
function isRepositoryDir(dir) {
  return entryOf(join(dir, 'HEAD'))?.isFile() === true && entryOf(join(dir, 'objects'))?.isDirectory() === true;
}

/** The common repository a leftover directory is PROVEN to be a linked worktree of, or null.
 *
 *  The proof is Git's own metadata read in BOTH directions, never the directory's name or a path taken on
 *  trust: the `.git` file names the administrative directory, that directory's `gitdir` file names this
 *  exact working tree's `.git` file back, its `commondir` file resolves the repository, and the
 *  administrative directory must sit inside THAT repository's own `worktrees/` registry. A copied,
 *  hand-written, moved or half-deleted leftover fails one of those steps, so it can never make a
 *  repository prunable. */
export function provenSourceRepo(worktreeDir) {
  // A DIRECTORY `.git` means this leftover is a repository or a subtree of one in its own right, not a
  // linked worktree of somebody else's: there is no administrative entry anywhere to prune.
  if (entryOf(join(worktreeDir, '.git'))?.isFile() !== true) return null;
  const gitdirRaw = worktreeGitFile(join(worktreeDir, '.git'));
  if (!gitdirRaw) return null;
  const gitdir = realDirectory(resolve(worktreeDir, gitdirRaw));
  if (!gitdir) return null;
  const backPointer = pointerFile(join(gitdir, 'gitdir'));
  if (!backPointer) return null;
  // Git records the WORKING TREE's own `.git` FILE in the administrative directory, so the back-proof is
  // that this leftover is the parent of the file it names, and that the named path really is a plain file.
  const named = resolve(gitdir, backPointer);
  if (basename(named) !== '.git' || entryOf(named)?.isFile() !== true) return null;
  if (realDirectory(dirname(named)) !== worktreeDir) return null;
  const commonRaw = pointerFile(join(gitdir, 'commondir'));
  if (!commonRaw) return null;
  const common = realDirectory(resolve(gitdir, commonRaw));
  if (!common) return null;
  if (realDirectory(join(common, 'worktrees')) !== dirname(gitdir)) return null;
  return isRepositoryDir(common) ? common : null;
}

/** Every leftover inside ONE account's own `workspaces/` directory that Git metadata proves is a linked
 *  worktree, paired with the repository that owns its administrative entry.
 *
 *  Reading is confined to that directory by construction: a `workspaces` directory that is a link, and
 *  any entry that is one, is refused rather than followed, so neither the scan nor a later prune can reach
 *  anything outside the account's own data. Every other leftover — a plain directory, a standalone
 *  repository, a malformed or truncated `.git` file — is ordinary account data with no repository to
 *  answer for, and simply leaves this list empty. */
export function provenLegacyWorktrees(workspacesRoot) {
  const rootEntry = entryOf(workspacesRoot);
  if (!rootEntry?.isDirectory() || rootEntry.isSymbolicLink()) return [];
  const root = realDirectory(workspacesRoot);
  if (!root) return [];
  const proven = new Map();
  for (const name of readdirSync(root)) {
    const candidate = join(root, name);
    const entry = entryOf(candidate);
    if (!entry || entry.isSymbolicLink() || !entry.isDirectory()) continue;
    const worktree = realDirectory(candidate);
    if (!worktree || worktree === root || !worktree.startsWith(`${root}${sep}`)) continue;
    const commonDir = provenSourceRepo(worktree);
    // One repository and one working tree per common dir: two leftovers cannot share a repository's own
    // registry slot, and a duplicate would only mean the same prune twice.
    if (commonDir) proven.set(commonDir, worktree);
  }
  return [...proven.entries()].map(([commonDir, worktree]) => ({ commonDir, worktree }));
}

/** The daemon's own Git environment must not reach this child: `--git-dir` is what says WHICH repository to
 *  prune, and an inherited `GIT_DIR`, `GIT_WORK_TREE`, `GIT_COMMON_DIR` or `GIT_CONFIG_*` could point the
 *  command somewhere else. Only `PATH` (to find `git`) and `HOME` are kept. */
function pruneEnv() {
  return { PATH: process.env.PATH ?? '/usr/bin:/bin', ...(process.env.HOME ? { HOME: process.env.HOME } : {}) };
}

/** Prune the administrative entries of the repositories whose worktrees an account removal just deleted.
 *
 *  `--expire now` is stated rather than assumed: the directories these entries describe were removed a
 *  moment ago, and a repository that configures `gc.worktreePruneExpire` must not turn that into a wait.
 *  Only the repositories handed in are touched. A failure is RETURNED rather than thrown — the account's
 *  data is already gone, and failing afterwards would leave an account that cannot be deleted because a
 *  repository moved or `git` is missing — so the caller can report it where the operator will see it. */
export async function pruneLegacyWorktreeMetadata(repos, { timeoutMs = PRUNE_TIMEOUT_MS } = {}) {
  const failures = [];
  for (const { commonDir } of repos) {
    try {
      await execFileAsync('git', ['--git-dir', commonDir, 'worktree', 'prune', '--expire', 'now'], {
        timeout: timeoutMs, env: pruneEnv(), maxBuffer: 64 * 1024,
      });
    } catch (error) {
      failures.push({ commonDir, message: error instanceof Error ? error.message : String(error) });
    }
  }
  return failures;
}
