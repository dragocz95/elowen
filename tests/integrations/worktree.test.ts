import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createMissionWorktree, removeWorktree, commitAll, detectBaseBranch, pushBranch } from '../../src/integrations/git/worktree.js';

let repo: string;
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'orca-wt-'));
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@orca.dev');
  git(repo, 'config', 'user.name', 'Orca Test');
  writeFileSync(join(repo, 'README.md'), '# repo\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init');
});
afterEach(() => { rmSync(repo, { recursive: true, force: true }); });

describe('worktree', () => {
  it('creates a worktree on a new branch off the base', async () => {
    const dir = join(repo, '..', `wt-${Date.now()}`);
    await createMissionWorktree(repo, 'orca/feat-1', 'main', dir);
    expect(existsSync(join(dir, 'README.md'))).toBe(true);          // checked out base content
    expect(git(dir, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('orca/feat-1');
    rmSync(dir, { recursive: true, force: true });
  });

  it('commitAll commits staged changes and returns true', async () => {
    const dir = join(repo, '..', `wt-${Date.now()}-c`);
    await createMissionWorktree(repo, 'orca/feat-2', 'main', dir);
    writeFileSync(join(dir, 'new.txt'), 'hello\n');
    const made = await commitAll(dir, 'add new.txt');
    expect(made).toBe(true);
    expect(git(dir, 'log', '-1', '--pretty=%s').trim()).toBe('add new.txt');
    rmSync(dir, { recursive: true, force: true });
  });

  it('commitAll is a no-op (returns false) when nothing changed', async () => {
    const dir = join(repo, '..', `wt-${Date.now()}-e`);
    await createMissionWorktree(repo, 'orca/feat-3', 'main', dir);
    const made = await commitAll(dir, 'nothing');
    expect(made).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it('commitAll also commits new untracked files', async () => {
    const dir = join(repo, '..', `wt-${Date.now()}-u`);
    await createMissionWorktree(repo, 'orca/feat-4', 'main', dir);
    mkdirSync(join(dir, 'sub'));
    writeFileSync(join(dir, 'sub', 'a.txt'), 'a\n');
    expect(await commitAll(dir, 'add sub/a.txt')).toBe(true);
    expect(git(dir, 'ls-files').includes('sub/a.txt')).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it('removeWorktree detaches the worktree but keeps the branch', async () => {
    const dir = join(repo, '..', `wt-${Date.now()}-r`);
    await createMissionWorktree(repo, 'orca/feat-5', 'main', dir);
    writeFileSync(join(dir, 'x.txt'), 'x\n');
    await commitAll(dir, 'work');
    await removeWorktree(repo, dir);
    expect(existsSync(dir)).toBe(false);                            // worktree gone
    expect(git(repo, 'branch', '--list', 'orca/feat-5').trim()).toContain('orca/feat-5'); // branch survives
  });

  it('detectBaseBranch falls back to the current branch without a remote', async () => {
    expect(await detectBaseBranch(repo, '')).toBe('main'); // repo is on `main`
  });

  it('detectBaseBranch returns the actual default branch on a master-named repo (no silent main fallback)', async () => {
    // A local repo whose default is `master` (or anything non-main) must resolve to THAT branch, else
    // `git worktree add ... main` fails and PR-native mode silently degrades to the shared checkout.
    git(repo, 'branch', '-m', 'main', 'master');
    expect(await detectBaseBranch(repo, '')).toBe('master');
  });

  it('detectBaseBranch honours an explicit configured base', async () => {
    expect(await detectBaseBranch(repo, 'develop')).toBe('develop');
  });
});

describe('pushBranch', () => {
  let remote: string;
  beforeEach(() => {
    remote = mkdtempSync(join(tmpdir(), 'orca-remote-'));
    execFileSync('git', ['init', '-q', '--bare', remote]);
    git(repo, 'remote', 'add', 'origin', remote);
  });
  afterEach(() => { rmSync(remote, { recursive: true, force: true }); });

  it('re-pushes additional commits to an already-pushed branch (lease stays valid)', async () => {
    const dir = join(repo, '..', `wt-${Date.now()}-p`);
    await createMissionWorktree(repo, 'orca/feat-push', 'main', dir);
    writeFileSync(join(dir, 'a.txt'), 'one\n'); await commitAll(dir, 'first');
    expect(await pushBranch(dir, 'orca/feat-push', '')).toBe(true);   // initial push
    writeFileSync(join(dir, 'b.txt'), 'two\n'); await commitAll(dir, 'second');
    expect(await pushBranch(dir, 'orca/feat-push', '')).toBe(true);   // re-push must NOT 'stale info'
    expect(git(remote, 'log', '--oneline', 'orca/feat-push')).toContain('second');
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns false when the repo has no origin remote', async () => {
    git(repo, 'remote', 'remove', 'origin');
    const dir = join(repo, '..', `wt-${Date.now()}-n`);
    await createMissionWorktree(repo, 'orca/feat-noremote', 'main', dir);
    writeFileSync(join(dir, 'a.txt'), 'x\n'); await commitAll(dir, 'work');
    expect(await pushBranch(dir, 'orca/feat-noremote', '')).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it('pushes with a configured token without persisting it to the repo config', async () => {
    const dir = join(repo, '..', `wt-${Date.now()}-t`);
    await createMissionWorktree(repo, 'orca/feat-token', 'main', dir);
    writeFileSync(join(dir, 'a.txt'), 'x\n'); await commitAll(dir, 'work');
    expect(await pushBranch(dir, 'orca/feat-token', 'ghs_faketoken123')).toBe(true);
    expect(git(remote, 'log', '--oneline', 'orca/feat-token')).toContain('work');
    // The one-shot `-c http.extraHeader` is command-scoped — the token must never land in config.
    expect(git(dir, 'config', '--local', '--list')).not.toContain('ghs_faketoken123');
    rmSync(dir, { recursive: true, force: true });
  });
});
