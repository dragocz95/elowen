import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, symlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { listProjectFiles, readProjectFile, writeProjectFile, projectCommitDiff } from '../../src/integrations/projectFiles.js';

let root: string;
const w = (rel: string, body: string) => { const p = join(root, rel); mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, body); };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-files-'));
  w('src/index.ts', 'export const x = 1;');
  w('README.md', '# hi');
  w('node_modules/dep/index.js', 'ignored');
  w('.git/config', 'ignored');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('listProjectFiles', () => {
  it('lists files + dirs, skipping node_modules and .git', () => {
    const paths = listProjectFiles(root).map((n) => n.path);
    expect(paths).toContain('src');
    expect(paths).toContain(join('src', 'index.ts'));
    expect(paths).toContain('README.md');
    expect(paths.some((p) => p.includes('node_modules'))).toBe(false);
    expect(paths.some((p) => p.includes('.git'))).toBe(false);
  });
});

describe('readProjectFile', () => {
  it('reads file content', () => {
    expect(readProjectFile(root, 'src/index.ts')).toEqual({ content: 'export const x = 1;', truncated: false });
  });
});

describe('writeProjectFile', () => {
  it('writes content and round-trips, creating parent dirs', () => {
    writeProjectFile(root, 'a/b/c.txt', 'hello');
    expect(readFileSync(join(root, 'a/b/c.txt'), 'utf8')).toBe('hello');
  });
});

describe('projectCommitDiff', () => {
  it('rejects a non-hex hash (no git option/flag injection) and errors safely', async () => {
    expect(await projectCommitDiff(root, '-O/tmp/pwn')).toBe('');
    expect(await projectCommitDiff(root, 'not a hash')).toBe('');
    expect(await projectCommitDiff(root, '--output=/tmp/x')).toBe('');
    expect(await projectCommitDiff(root, 'deadbeef')).toBe(''); // valid hex but non-repo → caught
  });
});

describe('path-traversal safety', () => {
  it('refuses to read or write outside the project root', () => {
    expect(() => readProjectFile(root, '../../etc/passwd')).toThrow(/outside project/);
    expect(() => readProjectFile(root, '/etc/passwd')).toThrow(/outside project/);
    expect(() => writeProjectFile(root, '../escape.txt', 'nope')).toThrow(/outside project/);
  });

  it('refuses to read through a symlink that points outside the project', () => {
    const outside = mkdtempSync(join(tmpdir(), 'orca-outside-'));
    writeFileSync(join(outside, 'secret.txt'), 'SECRET');
    try {
      symlinkSync(join(outside, 'secret.txt'), join(root, 'link'));
      expect(() => readProjectFile(root, 'link')).toThrow(/outside project/);
    } finally { rmSync(outside, { recursive: true, force: true }); }
  });

  it('refuses to write through a symlinked directory that escapes the project', () => {
    const outside = mkdtempSync(join(tmpdir(), 'orca-outside-'));
    try {
      symlinkSync(outside, join(root, 'linkdir'));
      expect(() => writeProjectFile(root, 'linkdir/pwned.txt', 'nope')).toThrow(/outside project/);
      expect(existsSync(join(outside, 'pwned.txt'))).toBe(false); // nothing written outside
    } finally { rmSync(outside, { recursive: true, force: true }); }
  });

  it('refuses to OVERWRITE an existing leaf file that is a symlink pointing outside', () => {
    const outside = mkdtempSync(join(tmpdir(), 'orca-outside-'));
    writeFileSync(join(outside, 'secret.txt'), 'ORIGINAL');
    try {
      symlinkSync(join(outside, 'secret.txt'), join(root, 'link')); // existing leaf symlink
      expect(() => writeProjectFile(root, 'link', 'OVERWRITTEN')).toThrow(/outside project/);
      expect(readFileSync(join(outside, 'secret.txt'), 'utf8')).toBe('ORIGINAL'); // untouched
    } finally { rmSync(outside, { recursive: true, force: true }); }
  });
});
