import { describe, expect, it } from 'vitest';
import { closeSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { chooseUploadProject, createUploadTarget, sanitizeUploadName, uploadCandidates, uploadRelativeDir } from '../../src/brain/chatUploads.js';

const SOURCES = { id: 1, slug: 'chetty', path: '/opt/elowen', executionKind: 'host' as const };
const SHARED = { id: 2, slug: 'sdilene', path: '/data/project', executionKind: 'host' as const };
/** A managed project as the store really reports one: its files live in the guest, so it has NO host
 *  path at all and `path` is the empty string. */
const MANAGED = { id: 3, slug: 'marketing', path: '', executionKind: 'managed' as const };

describe('which projects can hold an upload', () => {
  it('offers a managed project like any other — its files simply live in the guest', () => {
    expect(uploadCandidates({ all: [SOURCES, MANAGED], assigned: [1, 3], isAdmin: false })).toEqual([SOURCES, MANAGED]);
    expect(uploadCandidates({ all: [SOURCES, MANAGED], assigned: [], isAdmin: true })).toEqual([SOURCES, MANAGED]);
  });

  it('confines a member to their assignment, and gives an unassigned member nothing', () => {
    expect(uploadCandidates({ all: [SOURCES, SHARED], assigned: [2], isAdmin: false })).toEqual([SHARED]);
    expect(uploadCandidates({ all: [SOURCES, SHARED], assigned: [], isAdmin: false })).toEqual([]);
  });
});

describe('which project an upload belongs in', () => {
  it('refuses when the caller has no project at all', () => {
    expect(() => chooseUploadProject([], '/data/project')).toThrow(/ask an administrator to assign you one/);
  });

  it('takes the only project without consulting the preference', () => {
    expect(chooseUploadProject([SHARED], '/somewhere/else')).toBe(SHARED);
    // Including a managed one: a single candidate is unambiguous wherever its files live.
    expect(chooseUploadProject([MANAGED], '/somewhere/else')).toBe(MANAGED);
  });

  it('never lets a managed project’s empty root match the configured workspace', () => {
    // `resolve('')` is the DAEMON'S working directory, so an empty path once compared equal to the
    // workspace whenever the daemon happened to run there — silently electing an unrelated project.
    const daemonCwd = process.cwd();
    expect(() => chooseUploadProject([SOURCES, MANAGED], daemonCwd)).toThrow(/pick one for the conversation/);
    expect(() => chooseUploadProject([SOURCES, MANAGED], '')).toThrow(/pick one for the conversation/);
  });

  it('prefers the shared workspace over a source checkout', () => {
    // The real Chetty shape: an admin is assigned to both, and the lowest id is the live sources — the
    // one destination an upload must never land in.
    expect(chooseUploadProject([SOURCES, SHARED], '/data/project')).toBe(SHARED);
    expect(chooseUploadProject([SHARED, SOURCES], '/data/project')).toBe(SHARED);
  });

  it('matches the preferred workspace regardless of a trailing separator', () => {
    expect(chooseUploadProject([SOURCES, SHARED], '/data/project/')).toBe(SHARED);
  });

  it('fails loudly rather than guessing when nothing matches', () => {
    // Guessing would be invisible: the file lands somewhere real and nobody notices until they look
    // for it. The message names the candidates AND the one action that resolves it — choosing a project
    // for the conversation, which is what the route consults first.
    expect(() => chooseUploadProject([SOURCES, SHARED], '/data/nothing')).toThrow(/chetty, sdilene/);
    expect(() => chooseUploadProject([SOURCES, SHARED], '/data/nothing')).toThrow(/pick one for the conversation/);
  });
});

const NOW = new Date(2026, 7, 23, 10, 30);

function root(): string {
  return mkdtempSync(join(tmpdir(), 'elowen-uploads-'));
}

describe('an uploaded file name is attacker-controlled', () => {
  // The browser sends a plain name, but the endpoint is reachable by anything holding a session. Every
  // case here is a string that must not become a path.
  it.each([
    // basename() runs first, so a POSIX path loses its directories outright.
    ['../../../etc/passwd', 'passwd'],
    ['/absolute/path.txt', 'path.txt'],
    ['....//....//escape.sh', 'escape.sh'],
    // A Windows-style path has no POSIX separator, so basename hands the whole string over and the
    // backslashes are flattened here instead.
    ['..\\..\\windows\\system32', 'windows-system32'],
    ['..', 'upload'],
    ['.', 'upload'],
    ['.hidden', 'hidden'],
    ['-rf', 'rf'],
    ['', 'upload'],
    ['   ', 'upload'],
  ])('reduces %j to %j', (raw, expected) => {
    expect(sanitizeUploadName(raw)).toBe(expected);
  });

  it('strips the NUL that would truncate the path inside a syscall', () => {
    expect(sanitizeUploadName('report\u0000.png.exe')).toBe('report.png.exe');
    expect(sanitizeUploadName('a\u001fb\u007fc.txt')).toBe('abc.txt');
  });

  it('keeps the extension when it shortens a very long name', () => {
    const name = sanitizeUploadName(`${'x'.repeat(400)}.xlsx`);
    expect(name.endsWith('.xlsx')).toBe(true);
    expect(name.length).toBeLessThanOrEqual(180);
  });

  it('leaves an ordinary name, spaces and diacritics alone', () => {
    expect(sanitizeUploadName('Nabídka pro klienta 2026.pdf')).toBe('Nabídka pro klienta 2026.pdf');
  });

  it('keeps a long Czech name under the filesystem limit, which counts BYTES', () => {
    // Every accented letter costs two bytes, so a name that is comfortably short in characters can
    // still be refused by the kernel with ENAMETOOLONG — which reached the user as a bare 500.
    const name = sanitizeUploadName(`${'ř'.repeat(200)}.xlsx`);
    expect(Buffer.byteLength(name)).toBeLessThanOrEqual(255);
    expect(name.endsWith('.xlsx')).toBe(true);
    // Cut on a character boundary: a sliced buffer would end in U+FFFD and the stored name would no
    // longer be the one that was sent.
    expect(name).not.toContain('\ufffd');
  });
});

describe('where an upload lands', () => {
  it('files it per account and per day', () => {
    expect(uploadRelativeDir('filip', NOW)).toBe(join('uploads', 'filip', '2026-08-23'));
  });

  it('sanitizes the account segment too — it reaches the path just like the name does', () => {
    expect(uploadRelativeDir('../../root', NOW)).toBe(join('uploads', 'root', '2026-08-23'));
    // An e-mail login is the ordinary case on an SSO instance and must survive intact.
    expect(uploadRelativeDir('lukas.korinek@chetty.ai', NOW)).toBe(join('uploads', 'lukas.korinek@chetty.ai', '2026-08-23'));
  });

  /** Claim a target and close its descriptor — the tests care about placement, not about writing. */
  function claim(dir: string, account: string, name: string): { path: string; name: string; relative: string } {
    const target = createUploadTarget(dir, account, name, NOW);
    closeSync(target.fd);
    return target;
  }

  it('resolves inside the project root and reports the relative path', () => {
    const dir = root();
    try {
      const target = claim(dir, 'filip', 'notes.md');
      expect(target.path.startsWith(dir + sep)).toBe(true);
      expect(target.relative).toBe(join('uploads', 'filip', '2026-08-23', 'notes.md'));
      expect(target.name).toBe('notes.md');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('cannot be walked out of the root by the file name', () => {
    const dir = root();
    try {
      const target = claim(dir, 'filip', '../../../../../../tmp/owned.sh');
      expect(target.path.startsWith(dir + sep)).toBe(true);
      expect(target.name).toBe('owned.sh');
      expect(target.relative).toBe(join('uploads', 'filip', '2026-08-23', 'owned.sh'));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('never overwrites: a second file of the same name is suffixed before its extension', () => {
    const dir = root();
    try {
      const first = claim(dir, 'filip', 'screenshot.png');
      writeFileSync(first.path, 'one');
      const second = claim(dir, 'filip', 'screenshot.png');
      expect(second.name).toBe('screenshot (2).png');
      writeFileSync(second.path, 'two');
      const third = claim(dir, 'filip', 'screenshot.png');
      expect(third.name).toBe('screenshot (3).png');
      // The original survived — losing somebody else's file in a shared project is the failure that
      // matters here, not the naming.
      expect(readFileSync(first.path, 'utf8')).toBe('one');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('hands two simultaneous uploads of one name two different files', () => {
    // The regression: the old code asked whether the name was free and only then opened it, so two
    // uploads racing through that gap both got the same path and the second silently replaced the
    // first. Claiming both targets BEFORE either writes reproduces exactly that interleaving.
    const dir = root();
    try {
      const a = createUploadTarget(dir, 'filip', 'report.txt', NOW);
      const b = createUploadTarget(dir, 'filip', 'report.txt', NOW);
      expect(a.path).not.toBe(b.path);
      writeSync(a.fd, 'from A');
      writeSync(b.fd, 'from B');
      closeSync(a.fd);
      closeSync(b.fd);
      expect(readFileSync(a.path, 'utf8')).toBe('from A');
      expect(readFileSync(b.path, 'utf8')).toBe('from B');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('refuses to write through a symlink left at the chosen name', () => {
    // A DANGLING symlink is the dangerous one: the old existsSync check followed it, saw nothing and
    // called the name free, so the write landed wherever the link pointed — outside the project.
    const dir = root();
    const outside = join(tmpdir(), `elowen-escape-${process.pid}.txt`);
    try {
      const planted = createUploadTarget(dir, 'filip', 'invoice.pdf', NOW);
      closeSync(planted.fd);
      rmSync(planted.path);
      symlinkSync(outside, planted.path);

      const target = createUploadTarget(dir, 'filip', 'invoice.pdf', NOW);
      writeSync(target.fd, 'payload');
      closeSync(target.fd);

      expect(target.path).not.toBe(planted.path);
      expect(target.name).toBe('invoice (2).pdf');
      expect(existsOutside(outside)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(outside, { force: true });
    }
  });

  it('keeps two accounts apart inside one shared project', () => {
    const dir = root();
    try {
      const mine = claim(dir, 'filip', 'plan.docx');
      const theirs = claim(dir, 'michal', 'plan.docx');
      expect(mine.path).not.toBe(theirs.path);
      expect(mine.name).toBe('plan.docx');
      expect(theirs.name).toBe('plan.docx');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

function existsOutside(path: string): boolean {
  try { readFileSync(path); return true; } catch { return false; }
}
