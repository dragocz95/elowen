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
