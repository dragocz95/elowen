import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { projectRangeDiff, projectRangeFileDiff } from '../../src/integrations/projectFiles.js';

let root: string;
const git = (...args: string[]) => execFileSync('git', ['-C', root, '-c', 'user.email=t@t', '-c', 'user.name=Test', ...args], { stdio: 'pipe' });
const w = (rel: string, body: string) => { const p = join(root, rel); mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, body); };
const head = () => execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-rangediff-'));
  git('init', '-q');
  w('tracked.md', 'original line\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('projectRangeDiff', () => {
  it('reports per-file +added / −deleted for commits in the base..head range', async () => {
    const base = head();
    w('tracked.md', 'changed line\n');
    w('feature.ts', 'export const a = 1;\nexport const b = 2;\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'work');
    const files = await projectRangeDiff(root, base, head());
    const byPath = Object.fromEntries(files.map((f) => [f.path, f]));
    expect(byPath['tracked.md']).toEqual({ path: 'tracked.md', added: 1, deleted: 1 });
    expect(byPath['feature.ts']).toEqual({ path: 'feature.ts', added: 2, deleted: 0 });
  });

  it('is empty when the range has no commits (base === head)', async () => {
    expect(await projectRangeDiff(root, head(), head())).toEqual([]);
  });

  it('returns [] for a non-hex ref (no flag injection) and a non-repo dir', async () => {
    expect(await projectRangeDiff(root, '--output=/tmp/x', head())).toEqual([]);
    const plain = mkdtempSync(join(tmpdir(), 'orca-plain-'));
    try { expect(await projectRangeDiff(plain, head(), head())).toEqual([]); }
    finally { rmSync(plain, { recursive: true, force: true }); }
  });
});

describe('projectRangeFileDiff', () => {
  it('returns the unified diff of a single file across the range', async () => {
    const base = head();
    w('tracked.md', 'changed line\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'work');
    const diff = await projectRangeFileDiff(root, base, head(), 'tracked.md');
    expect(diff).toContain('-original line');
    expect(diff).toContain('+changed line');
  });

  it('rejects a path outside the project and empties on a non-hex ref', async () => {
    const base = head();
    await expect(projectRangeFileDiff(root, base, head(), '../escape')).rejects.toThrow();
    expect(await projectRangeFileDiff(root, 'nothex!', head(), 'tracked.md')).toBe('');
  });
});
