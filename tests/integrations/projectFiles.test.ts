import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { listProjectFiles, readProjectFile, writeProjectFile } from '../../src/integrations/projectFiles.js';

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

describe('path-traversal safety', () => {
  it('refuses to read or write outside the project root', () => {
    expect(() => readProjectFile(root, '../../etc/passwd')).toThrow(/outside project/);
    expect(() => readProjectFile(root, '/etc/passwd')).toThrow(/outside project/);
    expect(() => writeProjectFile(root, '../escape.txt', 'nope')).toThrow(/outside project/);
  });
});
