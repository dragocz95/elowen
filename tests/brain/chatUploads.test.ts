import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { resolveUploadTarget, sanitizeUploadName, uploadRelativeDir } from '../../src/brain/chatUploads.js';

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

  it('resolves inside the project root and reports the relative path', () => {
    const dir = root();
    try {
      const target = resolveUploadTarget(dir, 'filip', 'notes.md', NOW);
      expect(target.path.startsWith(dir + sep)).toBe(true);
      expect(target.relative).toBe(join('uploads', 'filip', '2026-08-23', 'notes.md'));
      expect(target.name).toBe('notes.md');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('cannot be walked out of the root by the file name', () => {
    const dir = root();
    try {
      const target = resolveUploadTarget(dir, 'filip', '../../../../../../tmp/owned.sh', NOW);
      expect(target.path.startsWith(dir + sep)).toBe(true);
      expect(target.name).toBe('owned.sh');
      expect(target.relative).toBe(join('uploads', 'filip', '2026-08-23', 'owned.sh'));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('never overwrites: a second file of the same name is suffixed before its extension', () => {
    const dir = root();
    try {
      const first = resolveUploadTarget(dir, 'filip', 'screenshot.png', NOW);
      writeFileSync(first.path, 'one');
      const second = resolveUploadTarget(dir, 'filip', 'screenshot.png', NOW);
      expect(second.name).toBe('screenshot (2).png');
      writeFileSync(second.path, 'two');
      const third = resolveUploadTarget(dir, 'filip', 'screenshot.png', NOW);
      expect(third.name).toBe('screenshot (3).png');
      // The original survived — losing somebody else's file in a shared project is the failure that
      // matters here, not the naming.
      expect(first.path).not.toBe(second.path);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('keeps two accounts apart inside one shared project', () => {
    const dir = root();
    try {
      const mine = resolveUploadTarget(dir, 'filip', 'plan.docx', NOW);
      const theirs = resolveUploadTarget(dir, 'michal', 'plan.docx', NOW);
      expect(mine.path).not.toBe(theirs.path);
      expect(mine.name).toBe('plan.docx');
      expect(theirs.name).toBe('plan.docx');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
