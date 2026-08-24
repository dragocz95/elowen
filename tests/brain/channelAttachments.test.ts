import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  attachmentTurnNote,
  storeChannelAttachments,
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_BYTES,
  type ChannelAttachment,
} from '../../src/brain/channelAttachments.js';

/** A room attachment is attacker-controlled in every field the sender touches: the file name, the size and
 *  the declared content type all arrive from a platform message anybody in the channel can post. These
 *  tests hold the two properties that matter — the bytes never leave the writer's own project, and a file
 *  that cannot be placed is REFUSED out loud rather than dropped (a dropped attachment is the exact
 *  silence this path exists to end: the sender sees their PDF in the channel, the agent never gets it). */

let dirs: string[] = [];
afterEach(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); dirs = []; });

function projectRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'elowen-room-upload-'));
  dirs.push(dir);
  return dir;
}

/** A deps shape with one project the writer (account 7) is assigned to. */
function deps(root: string, overrides: Record<string, unknown> = {}) {
  return {
    projects: { list: () => [{ id: 1, slug: 'workspace', path: root }] },
    userProjects: { forUser: () => [1] },
    users: { get: () => ({ username: 'patricie', is_admin: false }) },
    projectPath: () => root,
    ...overrides,
  };
}

const file = (name: string, body = 'hello', mimeType?: string): ChannelAttachment => ({
  name, data: Buffer.from(body).toString('base64'), ...(mimeType ? { mimeType } : {}),
});

const AT = new Date('2026-08-24T10:00:00Z');

describe('storeChannelAttachments places a room attachment like a web upload', () => {
  it('writes the bytes into the writer\'s project and hands back a real path', () => {
    const root = projectRoot();
    const [stored] = storeChannelAttachments(deps(root), 7, [file('report.pdf', 'PDF BYTES', 'application/pdf')], AT);
    expect(stored!.name).toBe('report.pdf');
    expect(stored!.relative).toBe(join('uploads', 'patricie', '2026-08-24', 'report.pdf'));
    expect(stored!.size).toBe(9);
    expect(readFileSync(stored!.path, 'utf8')).toBe('PDF BYTES');
    // The path is what the agent is given, which is the entire point of routing through the upload target.
    expect(attachmentTurnNote([stored!])).toBe(`[📎 report.pdf (application/pdf) — saved to ${stored!.path}]`);
  });

  it('accepts a content type it has never heard of — the type is recorded, never trusted', () => {
    const root = projectRoot();
    const [stored] = storeChannelAttachments(deps(root), 7, [file('thing.dat', 'x', 'application/x-nonsense')], AT);
    expect(readFileSync(stored!.path, 'utf8')).toBe('x');
    expect(stored!.mimeType).toBe('application/x-nonsense');
    // A declared type cannot influence the stored name — a `.dat` claiming to be a PDF stays a `.dat`.
    expect(stored!.name).toBe('thing.dat');
  });

  it('keeps every hostile file name inside the writer\'s own day directory', () => {
    const root = projectRoot();
    const hostile = [
      '../../../etc/passwd',           // relative traversal
      '/etc/shadow',                   // absolute path
      'evil\u0000.png.pdf',            // NUL truncation inside a syscall
      '..\\..\\windows\\system32.dll', // backslash traversal
      '\uFF0E\uFF0E\uFF0Fetc\uFF0Fx',  // fullwidth lookalikes for ../ — legal filename characters here
      '.bashrc',                       // hidden-file shadowing
      '-rf',                           // a name that reads as an option on any command line
    ];
    const expectedDir = resolve(root, 'uploads', 'patricie', '2026-08-24');
    const stored = storeChannelAttachments(deps(root), 7, hostile.map((n) => file(n)), AT);
    expect(stored).toHaveLength(hostile.length);
    for (const s of stored) {
      expect(dirname(s.path)).toBe(expectedDir);
      expect(s.name).not.toContain('/');
      expect(s.name).not.toContain('\\');
      expect(s.name).not.toContain('\u0000');
      expect(s.path.startsWith(`${root}/`)).toBe(true);
    }
    // Nothing was created anywhere but that one directory.
    expect(readdirSync(expectedDir)).toHaveLength(hostile.length);
    expect(readdirSync(root)).toEqual(['uploads']);
  });

  it('refuses to follow a symlink planted at the name it is about to claim', () => {
    const root = projectRoot();
    const outside = projectRoot();
    const victim = join(outside, 'secrets.env');
    writeFileSync(victim, 'ORIGINAL');
    // Claim the day directory first so the symlink can be planted at the exact target name.
    storeChannelAttachments(deps(root), 7, [file('seed.txt')], AT);
    const dayDir = resolve(root, 'uploads', 'patricie', '2026-08-24');
    symlinkSync(victim, join(dayDir, 'notes.txt'));
    const [stored] = storeChannelAttachments(deps(root), 7, [file('notes.txt', 'ATTACKER')], AT);
    // The exclusive create saw the name as taken and moved on; the file outside is untouched.
    expect(readFileSync(victim, 'utf8')).toBe('ORIGINAL');
    expect(stored!.name).toBe('notes (2).txt');
  });
});

describe('storeChannelAttachments refuses loudly rather than dropping the file', () => {
  it('refuses an attachment over the transport ceiling', () => {
    const root = projectRoot();
    const huge = { name: 'big.bin', data: Buffer.alloc(MAX_ATTACHMENT_BYTES + 1).toString('base64') };
    expect(() => storeChannelAttachments(deps(root), 7, [huge], AT)).toThrow(/too large/);
    expect(readdirSync(root)).toEqual([]);
  });

  it('refuses an empty attachment and an over-long list', () => {
    const root = projectRoot();
    expect(() => storeChannelAttachments(deps(root), 7, [{ name: 'x.pdf', data: '' }], AT)).toThrow(/empty/);
    const many = Array.from({ length: MAX_ATTACHMENTS + 1 }, (_, i) => file(`f${i}.txt`));
    expect(() => storeChannelAttachments(deps(root), 7, many, AT)).toThrow(/too many attachments/);
  });

  it('refuses a sender with no verified account — a stranger\'s bytes never enter somebody\'s project', () => {
    const root = projectRoot();
    expect(() => storeChannelAttachments(deps(root), undefined, [file('a.txt')], AT))
      .toThrow(/verified sender/);
    expect(readdirSync(root)).toEqual([]);
  });

  it('refuses a room whose writer has no project to write into', () => {
    const root = projectRoot();
    // Assigned to nothing and not an admin — the same state the web upload route reports as a 409.
    const noTarget = deps(root, { userProjects: { forUser: () => [] } });
    expect(() => storeChannelAttachments(noTarget, 7, [file('a.txt')], AT))
      .toThrow(/no project to upload into/);
    // …and an ambiguous set is refused rather than guessed.
    const ambiguous = deps(root, {
      projects: { list: () => [{ id: 1, slug: 'one', path: join(root, 'one') }, { id: 2, slug: 'two', path: join(root, 'two') }] },
      userProjects: { forUser: () => [1, 2] },
      projectPath: () => '/somewhere/else',
    });
    expect(() => storeChannelAttachments(ambiguous, 7, [file('a.txt')], AT)).toThrow(/several projects/);
    expect(readdirSync(root)).toEqual([]);
  });

  it('refuses when the host wired no project store at all', () => {
    expect(() => storeChannelAttachments({}, 7, [file('a.txt')], AT)).toThrow(/unknown account/);
  });

  it('does nothing at all for a message with no attachments', () => {
    expect(storeChannelAttachments({}, undefined, [], AT)).toEqual([]);
  });
});
