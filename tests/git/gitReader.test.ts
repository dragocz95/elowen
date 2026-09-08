import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RealGitReader, sanitizeRemoteUrl } from '../../src/git/gitReader.js';

let roots: string[] = [];
afterEach(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); roots = []; });

function git(root: string, ...args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
}

describe('RealGitReader snapshot', () => {
  it('returns branch/head/status counts and strips embedded remote credentials', async () => {
    const root = mkdtempSync(join(tmpdir(), 'elowen-git-reader-'));
    roots.push(root);
    git(root, 'init', '-b', 'main');
    git(root, 'config', 'user.name', 'Test');
    git(root, 'config', 'user.email', 'test@example.com');
    writeFileSync(join(root, 'tracked.txt'), 'one\n');
    git(root, 'add', 'tracked.txt');
    git(root, 'commit', '-m', 'initial');
    git(root, 'remote', 'add', 'origin', 'https://oauth2:top-secret@github.com/example/repo.git');
    writeFileSync(join(root, 'tracked.txt'), 'two\n');
    writeFileSync(join(root, 'new.txt'), 'new\n');

    const snapshot = await new RealGitReader().snapshot(root);
    expect(snapshot.isRepo).toBe(true);
    expect(snapshot.status).toMatchObject({
      branch: 'main', head: git(root, 'rev-parse', 'HEAD'), upstream: null,
      dirty: 1, untracked: 1, clean: false,
    });
    expect(snapshot.remotes).toEqual([{
      name: 'origin',
      fetchUrl: 'https://github.com/example/repo.git',
      pushUrl: 'https://github.com/example/repo.git',
    }]);
    expect(JSON.stringify(snapshot)).not.toContain('top-secret');
  });

  it('preserves ordinary SCP-style SSH remotes while sanitizing URL userinfo', () => {
    expect(sanitizeRemoteUrl('git@github.com:owner/repo.git')).toBe('git@github.com:owner/repo.git');
    expect(sanitizeRemoteUrl('https://token@github.com/owner/repo.git')).toBe('https://github.com/owner/repo.git');
  });
});

describe('RealGitReader managed execution', () => {
  const EMPTY = { isRepo: false, status: null, remotes: [] };

  it('recovers only stderr-attested git semantics in strict managed mode', async () => {
    const notARepo = Object.assign(new Error('git exited 128'), { code: 128, stderr: 'fatal: not a git repository (or any of the parent directories): .git\n' });
    expect(await new RealGitReader(async () => { throw notARepo; }, true).snapshot('/workspace')).toEqual(EMPTY);
    // Launcher/runtime (podman 125, exec 126/127) and provider-shaped exits never look like a repo verdict.
    for (const code of [125, 126, 127, 403]) {
      const launcher = Object.assign(new Error(`launcher exited ${code}`), { code, stderr: 'fatal: not a git repository' });
      await expect(new RealGitReader(async () => { throw launcher; }, true).snapshot('/workspace')).rejects.toThrow(`launcher exited ${code}`);
    }
    // Even the right exit code is not a verdict without git's stderr attesting it.
    const bare = Object.assign(new Error('git exited 128'), { code: 128 });
    await expect(new RealGitReader(async () => { throw bare; }, true).snapshot('/workspace')).rejects.toThrow('git exited 128');
  });

  it('keeps the host default lax: any numeric exit still degrades to not-a-repo', async () => {
    const lax = new RealGitReader(async () => { throw Object.assign(new Error('launcher exited 127'), { code: 127, stderr: '' }); });
    expect(await lax.snapshot('/workspace')).toEqual(EMPTY);
  });

  it('yields empty commits for an unborn HEAD while keeping the repo in strict managed mode', async () => {
    const scripted = new RealGitReader(async (_file: string, args: string[]) => {
      const rest = args.slice(args.indexOf('-C') + 2).join(' ');
      if (rest === 'log -n 15 --pretty=format:%h%x09%s%x09%an%x09%cr') {
        throw Object.assign(new Error('git exited 128'), { code: 128, stderr: "fatal: your current branch 'main' does not have any commits yet" });
      }
      if (rest === 'rev-parse --is-inside-work-tree') return { stdout: 'true\n', stderr: '' };
      if (rest.startsWith('status')) return { stdout: '# branch.head main\n', stderr: '' };
      return { stdout: '', stderr: '' };
    }, true);
    const project = await scripted.read('/workspace');
    expect(project.isRepo).toBe(true);
    expect(project.status).toMatchObject({ branch: 'main' });
    expect(project.commits).toEqual([]);
  });

  it('throws non-command provider errors in strict managed mode but degrades in default host mode', async () => {
    const providerError = new Error('provider revoked access');
    await expect(new RealGitReader(async () => { throw providerError; }, true).snapshot('/workspace')).rejects.toThrow('provider revoked access');
    expect(await new RealGitReader(async () => { throw providerError; }).snapshot('/workspace')).toEqual(EMPTY);
  });

  it('refuses a non-numeric child spawn failure in strict managed mode', async () => {
    const reader = new RealGitReader(async () => { throw Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' }); }, true);
    await expect(reader.read('/workspace')).rejects.toThrow('spawn git ENOENT');
  });
});
