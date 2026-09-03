/** The daemon's OWN project-file helpers — the ones core routes call directly (`src/api/routes/projects.ts`
 *  for directory browsing and image serving, `brainCore` for a task's commit range).
 *
 *  The file-manager operations that used to be tested alongside them belong to the editor plugin and moved
 *  with it into the plugin registry, where they are exercised against the daemon's real `safeProjectPath`
 *  exactly as they were here. What is left is what this package still owns. */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createDir, listDirs, projectRangeLog, isProjectImage } from '../../src/integrations/projectFiles.js';

let root: string;
const w = (rel: string, body: string) => { const p = join(root, rel); mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, body); };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'elowen-files-'));
  w('src/index.ts', 'export const x = 1;');
  w('README.md', '# hi');
  w('node_modules/dep/index.js', 'ignored');
  w('.git/config', 'ignored');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('listDirs', () => {
  it('shallow-lists only sub-directories (no files), skipping build noise, with a parent', () => {
    mkdirSync(join(root, 'apps'));
    const res = listDirs(root);
    const names = res.entries.map((e) => e.name);
    expect(names).toContain('src');
    expect(names).toContain('apps');
    expect(names).not.toContain('README.md'); // files are never listed
    expect(names.some((n) => n === 'node_modules' || n === '.git')).toBe(false); // noise filtered
    expect(res.entries.every((e) => e.path.startsWith(root))).toBe(true);
    expect(res.parent).not.toBeNull(); // a tmp dir always has a parent
  });

  it('throws on a path that is not a readable directory (route turns it into a 400)', () => {
    expect(() => listDirs(join(root, 'does-not-exist'))).toThrow();
  });
});

describe('createDir', () => {
  it('creates exactly one immediate child and returns its canonical path', () => {
    const created = createDir(root, 'new-app');
    expect(created).toEqual({ path: join(root, 'new-app') });
    expect(listDirs(root).entries).toContainEqual({ name: 'new-app', path: join(root, 'new-app') });
  });

  it('reports duplicate and missing-parent failures without recursive creation', () => {
    mkdirSync(join(root, 'taken'));
    expect(() => createDir(root, 'taken')).toThrow(expect.objectContaining({ code: 'exists' }));
    expect(() => createDir(join(root, 'missing'), 'child')).toThrow(expect.objectContaining({ code: 'invalid-parent' }));
  });
});

describe('projectRangeLog', () => {
  it('rejects a non-hex ref (no git flag injection) and errors safely', async () => {
    expect(await projectRangeLog(root, '--all', 'HEAD')).toEqual([]);
    expect(await projectRangeLog(root, 'deadbeef', 'cafebabe')).toEqual([]); // valid hex, non-repo → caught
  });

  it('returns only the commits a task landed between base..head, newest-first with churn', async () => {
    const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' });
    git('init', '-q');
    git('config', 'user.email', 't@t.io');
    git('config', 'user.name', 'T');
    git('add', '-A');
    git('commit', '-q', '-m', 'before the task');
    const base = git('rev-parse', 'HEAD').toString().trim();
    w('src/index.ts', 'export const x = 2;\nexport const y = 3;'); // the task's first commit: 1 changed, 1 added
    git('add', '-A');
    git('commit', '-q', '-m', 'task commit 1');
    w('README.md', '# hi\nmore'); // the task's second commit
    git('add', '-A');
    git('commit', '-q', '-m', 'task commit 2');
    const head = git('rev-parse', 'HEAD').toString().trim();

    const log = await projectRangeLog(root, base, head);
    expect(log.map((c) => c.subject)).toEqual(['task commit 2', 'task commit 1']); // only the range, newest-first
    const f = log[1].files.find((x) => x.path === join('src', 'index.ts'));
    expect(f).toMatchObject({ added: 2, deleted: 1 });
  });
});

describe('isProjectImage', () => {
  beforeEach(() => {
    w('assets/logo.png', 'PNG');
    w('icon.svg', '<svg/>');
    w('notes.txt', 'text');
  });

  it('accepts a real image file inside the project (by extension)', () => {
    expect(isProjectImage(root, 'assets/logo.png')).toBe(true);
    expect(isProjectImage(root, 'icon.svg')).toBe(true);
  });

  it('rejects a non-image file, a directory and a missing file', () => {
    expect(isProjectImage(root, 'notes.txt')).toBe(false);   // not an image extension
    expect(isProjectImage(root, 'assets')).toBe(false);       // a directory
    expect(isProjectImage(root, 'nope.png')).toBe(false);     // does not exist
  });

  it('never throws and rejects a path that escapes the project root', () => {
    expect(isProjectImage(root, '../../etc/passwd.png')).toBe(false);
    expect(isProjectImage(root, '/etc/hosts')).toBe(false);
  });

  it('rejects an image symlink that points outside the project', () => {
    const outside = mkdtempSync(join(tmpdir(), 'elowen-outside-'));
    writeFileSync(join(outside, 'evil.png'), 'PNG');
    try {
      symlinkSync(join(outside, 'evil.png'), join(root, 'linked.png'));
      expect(isProjectImage(root, 'linked.png')).toBe(false);
    } finally { rmSync(outside, { recursive: true, force: true }); }
  });
});

