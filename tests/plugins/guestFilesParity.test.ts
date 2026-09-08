import { spawnSync } from 'node:child_process';
import { closeSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, symlinkSync, truncateSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const HELPER = readFileSync(new URL('../../plugins/sandbox/lib/guestFiles.py', import.meta.url), 'utf8');

type HelperReply = { ok: true; result: any } | { ok: false; error: { code: string; message: string } };

function runHelper(operation: unknown): HelperReply {
  const done = spawnSync('python3', ['-c', HELPER], { input: JSON.stringify(operation), encoding: 'utf8' });
  return JSON.parse(done.stdout) as HelperReply;
}

let root: string;
beforeAll(() => { root = mkdtempSync(join(tmpdir(), 'elowen-guest-files-')); });
afterAll(() => { rmSync(root, { recursive: true, force: true }); });

describe('guestFiles helper parity', () => {
  it('pages a directory larger than the page size with a name keyset cursor and no total cap', () => {
    const dir = join(root, 'paging');
    mkdirSync(dir);
    const count = 1250;
    for (let index = 0; index < count; index += 1) writeFileSync(join(dir, `f-${String(index).padStart(5, '0')}`), String(index));
    const names: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; ; page += 1) {
      expect(page).toBeLessThan(5);
      const reply = runHelper({ kind: 'list', path: dir, limit: 1000, cursor });
      expect(reply.ok).toBe(true);
      if (!reply.ok) return;
      expect(reply.result.entries.length).toBeLessThanOrEqual(1000);
      for (const item of reply.result.entries) names.push(item.path);
      if (!reply.result.truncated) { expect(reply.result.nextCursor).toBeNull(); break; }
      expect(reply.result.nextCursor).toBe(reply.result.entries[reply.result.entries.length - 1].path.split('/').pop());
      cursor = reply.result.nextCursor;
    }
    expect(names.length).toBe(count);
    expect([...names].sort()).toEqual(names);
    expect(names[0]).toBe(join(dir, 'f-00000'));
  });

  it('rejects a malformed cursor', () => {
    const reply = runHelper({ kind: 'list', path: root, limit: 10, cursor: 5 });
    expect(reply.ok).toBe(false);
    if (!reply.ok) expect(reply.error.code).toBe('invalid_cursor');
  });

  it('versions and stats a sparse file far beyond the old 256MiB cap', () => {
    const file = join(root, 'sparse.bin');
    closeSync(openSync(file, 'w'));
    truncateSync(file, 300 * 1024 * 1024);
    const reply = runHelper({ kind: 'stat', path: file });
    expect(reply.ok).toBe(true);
    if (!reply.ok) return;
    expect(reply.result.entry.size).toBe(300 * 1024 * 1024);
    const tail = runHelper({ kind: 'read', path: file, maxBytes: 16, offset: 300 * 1024 * 1024 - 16 });
    expect(tail.ok).toBe(true);
    if (!tail.ok) return;
    expect(tail.result.totalBytes).toBe(300 * 1024 * 1024);
    expect(tail.result.base64).toBe(Buffer.alloc(16).toString('base64'));
  });

  it('keeps stat, read and write on the same final symlink target and preserves the link', () => {
    const dir = join(root, 'links');
    mkdirSync(dir);
    const target = join(dir, 'real.txt');
    const link = join(dir, 'alias.txt');
    const other = join(dir, 'other.txt');
    writeFileSync(target, 'first');
    writeFileSync(other, 'elsewhere');
    symlinkSync(target, link);

    const linkStat = runHelper({ kind: 'stat', path: link });
    expect(linkStat.ok && linkStat.result.entry.kind).toBe('symlink');
    const stat = runHelper({ kind: 'stat', path: link, followSymlinks: true });
    expect(stat.ok).toBe(true);
    if (!stat.ok) return;
    expect(stat.result.entry.kind).toBe('file');
    expect(stat.result.entry.path).toBe(target);
    const version: string = stat.result.entry.version;

    const read = runHelper({ kind: 'read', path: link, maxBytes: 1024 });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(Buffer.from(read.result.base64, 'base64').toString()).toBe('first');

    const write = runHelper({ kind: 'write', path: link, base64: Buffer.from('second').toString('base64'), expectedVersion: version });
    expect(write.ok).toBe(true);
    expect(write.ok ? write.result.entry.path : null).toBe(target);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readFileSync(target, 'utf8')).toBe('second');

    // Writing through the link after it was retargeted must not touch the new target.
    unlinkSync(link);
    symlinkSync(other, link);
    const stale = runHelper({ kind: 'write', path: link, base64: Buffer.from('third').toString('base64'), expectedVersion: version });
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.error.code).toBe('version_conflict');
    expect(readFileSync(other, 'utf8')).toBe('elsewhere');
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
  });
});