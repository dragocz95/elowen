import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { projectReviewDiff } from '../../src/integrations/projectFiles.js';

let root: string;
const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' });
const w = (rel: string, body: string) => { const p = join(root, rel); mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, body); };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-reviewdiff-'));
  git('init', '-q');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 'Test');
  w('tracked.md', 'original line\n');
  git('add', '-A');
  git('-c', 'user.email=t@t', '-c', 'user.name=Test', 'commit', '-q', '-m', 'init');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('projectReviewDiff', () => {
  it('includes a tracked modification in the diff', async () => {
    w('tracked.md', 'changed line\n');
    const { changedFiles, diff } = await projectReviewDiff(root);
    expect(changedFiles).toContain('tracked.md');
    expect(diff).toContain('-original line');
    expect(diff).toContain('+changed line');
  });

  it('includes a brand-new UNTRACKED file as a new-file addition (git diff HEAD alone misses it)', async () => {
    w('sandbox/new.md', '# Fresh\nhello from the agent\n');
    const { changedFiles, diff } = await projectReviewDiff(root);
    // The individual untracked file is listed (not just its parent dir)…
    expect(changedFiles).toContain(join('sandbox', 'new.md'));
    // …and its actual added content appears in the diff so the overseer can review it.
    expect(diff).toContain('+# Fresh');
    expect(diff).toContain('+hello from the agent');
  });

  it('covers a tracked change AND an untracked file together', async () => {
    w('tracked.md', 'edited\n');
    w('brand_new.txt', 'created content\n');
    const { diff } = await projectReviewDiff(root);
    expect(diff).toContain('+edited');
    expect(diff).toContain('+created content');
  });

  it('returns empty evidence for a non-git directory (no throw)', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'orca-plain-'));
    try {
      const { changedFiles, diff } = await projectReviewDiff(plain);
      expect(changedFiles).toEqual([]);
      expect(diff).toBe('');
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });
});
