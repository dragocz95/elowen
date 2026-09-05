import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chdirFailure, prettyCwd, resolveCdTarget } from '../../../src/cli/chat/projectDir.js';

describe('resolveCdTarget', () => {
  const from = '/srv/app/src';
  const home = '/home/filip';

  it('expands the home shorthand, bare and with a subpath', () => {
    expect(resolveCdTarget('~', from, home)).toBe('/home/filip');
    expect(resolveCdTarget('~/projects/api', from, home)).toBe('/home/filip/projects/api');
  });

  it('resolves a relative path against the current directory, not the home', () => {
    expect(resolveCdTarget('cli', from, home)).toBe('/srv/app/src/cli');
    expect(resolveCdTarget('../..', from, home)).toBe('/srv');
    expect(resolveCdTarget('./tests', from, home)).toBe('/srv/app/src/tests');
  });

  it('passes an absolute path through untouched', () => {
    expect(resolveCdTarget('/etc/nginx', from, home)).toBe('/etc/nginx');
  });

  it('tolerates the whitespace a user types around the argument', () => {
    expect(resolveCdTarget('  ~/api  ', from, home)).toBe('/home/filip/api');
  });

  it('treats ~user literally rather than guessing another account\'s home', () => {
    // Resolving it would need /etc/passwd; a real `./~ubuntu` directory is likelier here than the shell's
    // user-home syntax, and guessing wrong would move the session somewhere the user never asked for.
    expect(resolveCdTarget('~ubuntu', from, home)).toBe('/srv/app/src/~ubuntu');
  });
});

describe('chdirFailure', () => {
  /** Real errors from a real chdir — the message shape is Node's, so inventing the string would test the
   *  invention. This is the branch a user only ever sees when something already went wrong. */
  const failureOf = (dir: string): string => {
    const from = process.cwd();
    try { process.chdir(dir); process.chdir(from); throw new Error(`expected ${dir} to be unenterable`); }
    catch (e) { return chdirFailure(e); }
  };

  it('keeps the reason for each distinct failure and drops the paths', () => {
    // Three different problems needing three different answers from the user — they must not read alike.
    const root = mkdtempSync(join(tmpdir(), 'elowen-project-dir-'));
    try {
      const file = join(root, 'regular-file');
      writeFileSync(file, 'not a directory');
      expect(failureOf(join(root, 'missing'))).toBe('ENOENT: no such file or directory');
      expect(failureOf(file)).toBe('ENOTDIR: not a directory');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
    expect(chdirFailure(new Error("EACCES: permission denied, chdir '/tmp' -> '/root'"))).toBe('EACCES: permission denied');
  });

  it('leaves anything not shaped like a chdir error alone', () => {
    expect(chdirFailure(new Error('something else entirely'))).toBe('something else entirely');
    expect(chdirFailure('a bare string')).toBe('a bare string');
  });
});

describe('prettyCwd', () => {
  const home = '/home/filip';

  it('shortens a path under the home directory and leaves everything else alone', () => {
    expect(prettyCwd('/home/filip/elowen', home)).toBe('~/elowen');
    expect(prettyCwd('/srv/app', home)).toBe('/srv/app');
  });

  it('never shortens another account whose path merely shares the prefix', () => {
    // '/home/filipe' starts with '/home/filip' as a STRING but is a different account — only a whole path
    // segment counts, which is what the separator in the comparison enforces.
    expect(prettyCwd('/home/filipe/api', home)).toBe('/home/filipe/api');
  });

  it('leaves the home directory itself alone rather than rendering a bare tilde', () => {
    expect(prettyCwd(home, home)).toBe(home);
  });
});
