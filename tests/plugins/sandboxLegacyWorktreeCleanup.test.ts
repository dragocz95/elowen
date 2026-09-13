import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { removeUserData } from '../../plugins/sandbox/lib/execution.mjs';
import { provenLegacyWorktrees } from '../../plugins/sandbox/lib/legacyWorktrees.mjs';

/** What an instance that ran the retired account-owned workspaces still holds: REAL Git worktrees under
 *  `users/<account>/workspaces/<label>`, registered in the Project repositories they were cut from, mixed
 *  with whatever else ended up in that directory. Removing the account deletes those directories, so it
 *  also has to clear each repository's administrative entry for them — and only for a repository the
 *  metadata actually proves, because the cost of being wrong is a prune in somebody else's repository. */

const GIT_IDENTITY = ['-c', 'user.email=test@example.test', '-c', 'user.name=Sandbox Test'];
const tmp = (): string => realpathSync(mkdtempSync(join(tmpdir(), 'elowen-legacy-workspaces-')));
let dir = '';

afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = ''; });

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** A repository with one commit, at its real path: Git records the path it was given, so the fixture must
 *  not depend on a symlinked temp root. */
function makeRepo(path: string): string {
  mkdirSync(path, { recursive: true });
  git(path, ['init', '--quiet']);
  writeFileSync(join(path, 'file.txt'), 'content\n');
  git(path, [...GIT_IDENTITY, 'add', 'file.txt']);
  git(path, [...GIT_IDENTITY, 'commit', '--quiet', '-m', 'init']);
  return realpathSync(path);
}

function setup() {
  dir = tmp();
  const dataDir = join(dir, 'data');
  const userRoot = (id: number): string => join(dataDir, 'users', String(id));
  return { dataDir, userRoot, workspaces: (id: number): string => join(userRoot(id), 'workspaces') };
}

/** The administrative entries the repository would still prune, exactly as `git` reports them. `prune`
 *  writes that report to stderr, and `--expire now` is stated so nothing can hide behind an expiry window. */
const prunable = (repo: string): string => {
  const result = spawnSync('git', ['worktree', 'prune', '--dry-run', '--verbose', '--expire', 'now'], { cwd: repo, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || `git worktree prune exited ${result.status}`);
  return `${result.stdout}${result.stderr}`.trim();
};
/** The working trees the repository currently lists. */
const worktrees = (repo: string): string[] => git(repo, ['worktree', 'list', '--porcelain'])
  .split('\n').filter((line) => line.startsWith('worktree ')).map((line) => line.slice('worktree '.length));
/** What the repository itself reports as prunable — how a stale worktree shows up in its own listing
 *  (`prunable <reason>`) for as long as nobody prunes it. */
const staleEntries = (repo: string): string[] => git(repo, ['worktree', 'list', '--porcelain'])
  .split('\n').filter((line) => line.startsWith('prunable '));
/** The administrative entries the repository keeps; Git removes the whole registry once its last entry goes. */
const registry = (repo: string): string[] => {
  try { return readdirSync(join(repo, '.git', 'worktrees')); } catch { return []; }
};

describe('account removal clears the Git metadata of the legacy worktrees it deletes', () => {
  it('prunes the proven repository, leaving nothing stale behind', async () => {
    const { dataDir, userRoot, workspaces } = setup();
    const repo = makeRepo(join(dir, 'repo'));
    const worktree = join(workspaces(1), 'feature');
    mkdirSync(workspaces(1), { recursive: true });
    git(repo, ['worktree', 'add', '--quiet', worktree, '-b', 'elowen/u1/feature']);

    // The proof has to be taken while the tree is still on disk; afterwards there is nothing to prove it
    // against. This is that proof, and the only repository the removal may prune.
    expect(provenLegacyWorktrees(workspaces(1))).toEqual([{ commonDir: join(repo, '.git'), worktree }]);
    expect(worktrees(repo)).toContain(worktree);
    expect(prunable(repo)).toBe('');

    const warnings: string[] = [];
    await removeUserData(dataDir, 1, { warn: (message: string) => warnings.push(message) });

    expect(warnings).toEqual([]);
    expect(existsSync(userRoot(1))).toBe(false);
    expect(worktrees(repo)).not.toContain(worktree);
    expect(staleEntries(repo)).toEqual([]);
    expect(prunable(repo)).toBe('');
    expect(registry(repo)).toEqual([]);
  });

  it('leaves the same repository stale when the directories go without that step', () => {
    // The state the cleanup replaces, so the assertion above cannot pass for the wrong reason: deleting
    // the account's directories alone leaves the repository describing worktrees that no longer exist,
    // and `git worktree list` wrong until somebody prunes by hand.
    const { workspaces } = setup();
    const repo = makeRepo(join(dir, 'repo'));
    const worktree = join(workspaces(1), 'feature');
    mkdirSync(workspaces(1), { recursive: true });
    git(repo, ['worktree', 'add', '--quiet', worktree, '-b', 'elowen/u1/feature']);

    rmSync(workspaces(1), { recursive: true, force: true });

    expect(prunable(repo)).toContain('Removing worktrees/feature');
    expect(staleEntries(repo)).toHaveLength(1);
  });

  it('prunes nothing it cannot prove, and touches nothing foreign or linked', async () => {
    const { dataDir, userRoot, workspaces } = setup();
    // A repository that already carries a genuinely stale entry, from a worktree deleted elsewhere.
    const staleRepo = makeRepo(join(dir, 'stale-repo'));
    const stale = join(dir, 'elsewhere', 'stale');
    mkdirSync(dirname(stale), { recursive: true });
    git(staleRepo, ['worktree', 'add', '--quiet', stale, '-b', 'stale-branch']);
    const staleAdmin = join(staleRepo, '.git', 'worktrees', basename(stale));
    rmSync(stale, { recursive: true, force: true });
    expect(prunable(staleRepo)).toContain('Removing worktrees/');

    // A live worktree of another repository, reachable only through a link inside the account's data.
    const foreignRepo = makeRepo(join(dir, 'foreign-repo'));
    const foreign = join(dir, 'foreign-live', 'live');
    mkdirSync(dirname(foreign), { recursive: true });
    git(foreignRepo, ['worktree', 'add', '--quiet', foreign, '-b', 'live-branch']);

    mkdirSync(workspaces(2), { recursive: true });
    // A `.git` file naming a REAL administrative directory whose own back-pointer names a different, now
    // deleted working tree: the metadata contradicts this leftover, so it proves nothing.
    mkdirSync(join(workspaces(2), 'fake'), { recursive: true });
    writeFileSync(join(workspaces(2), 'fake', '.git'), `gitdir: ${staleAdmin}\n`);
    // A truncated `.git` file, a standalone repository of its own, a bare leftover, and a link out.
    mkdirSync(join(workspaces(2), 'broken'), { recursive: true });
    writeFileSync(join(workspaces(2), 'broken', '.git'), 'gitdir: ../missing\n');
    makeRepo(join(workspaces(2), 'own-repo'));
    mkdirSync(join(workspaces(2), 'plain'), { recursive: true });
    symlinkSync(foreign, join(workspaces(2), 'linked'));

    expect(provenLegacyWorktrees(workspaces(2))).toEqual([]);

    const warnings: string[] = [];
    await removeUserData(dataDir, 2, { warn: (message: string) => warnings.push(message) });

    expect(warnings).toEqual([]);                    // no repository was even attempted
    expect(existsSync(userRoot(2))).toBe(false);     // the account's own leftovers went with the account
    expect(prunable(staleRepo)).not.toBe('');        // an unproven repository keeps exactly what it had
    expect(worktrees(foreignRepo)).toContain(foreign);
    expect(staleEntries(foreignRepo)).toEqual([]);
    expect(existsSync(foreign)).toBe(true);          // the link's target was neither followed nor deleted
  });

  it('refuses a workspaces directory that is itself a link out of the account data', async () => {
    const { dataDir, userRoot, workspaces } = setup();
    const repo = makeRepo(join(dir, 'repo'));
    const linkedStore = join(dir, 'linked-store');
    const worktree = join(linkedStore, 'feature');
    mkdirSync(linkedStore, { recursive: true });
    git(repo, ['worktree', 'add', '--quiet', worktree, '-b', 'linked-branch']);
    mkdirSync(userRoot(3), { recursive: true });
    symlinkSync(linkedStore, workspaces(3));

    expect(provenLegacyWorktrees(workspaces(3))).toEqual([]);

    const warnings: string[] = [];
    await removeUserData(dataDir, 3, { warn: (message: string) => warnings.push(message) });

    expect(warnings).toEqual([]);
    expect(existsSync(userRoot(3))).toBe(false);
    expect(worktrees(repo)).toContain(worktree);     // the repository behind the link was never reached
    expect(staleEntries(repo)).toEqual([]);
    expect(existsSync(worktree)).toBe(true);
  });
});
