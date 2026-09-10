import { spawnSync } from 'node:child_process';
import { chmodSync, closeSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, symlinkSync, truncateSync, unlinkSync, writeFileSync } from 'node:fs';
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

  // The traversal that used to be driven from the host, one container round trip per directory. These
  // run the real helper against real trees, because the bounds are the whole point and an in-memory
  // stand-in cannot exercise a deadline or an output budget.
  describe('bounded walk', () => {
    const walk = (path: string, extra: Record<string, unknown> = {}) =>
      runHelper({ kind: 'walk', path, limit: 10001, skip: ['.git', 'node_modules'], ...extra });

    it('returns files AND directories in one pass, sorted, with kind, size and time', () => {
      const dir = join(root, 'walk-basic');
      mkdirSync(join(dir, 'src', 'deep'), { recursive: true });
      writeFileSync(join(dir, 'top.md'), 'top');
      writeFileSync(join(dir, 'src', 'a.ts'), 'a');
      writeFileSync(join(dir, 'src', 'deep', 'b.ts'), 'b');

      const reply = walk(dir);
      expect(reply.ok).toBe(true);
      if (!reply.ok) return;
      expect(reply.result).toMatchObject({ root: dir, rootKind: 'directory', truncated: false });
      // Directories are entries of their own, which is what lets a consumer show an empty one.
      expect(reply.result.entries.map((item: any) => [item.path, item.kind])).toEqual([
        [join(dir, 'src'), 'directory'],
        [join(dir, 'top.md'), 'file'],
        [join(dir, 'src', 'a.ts'), 'file'],
        [join(dir, 'src', 'deep'), 'directory'],
        [join(dir, 'src', 'deep', 'b.ts'), 'file'],
      ]);
      // Metadata only: nothing walked past is read, so nothing is hashed and no version exists.
      for (const item of reply.result.entries) {
        expect(Object.keys(item).sort()).toEqual(['kind', 'mtime', 'path', 'size']);
        expect(item.mtime).toBeGreaterThan(0);
      }
      expect(reply.result.entries.find((item: any) => item.path.endsWith('top.md')).size).toBe(3);
    });

    it('never descends a skipped directory and never follows a symlink out of the tree', () => {
      const dir = join(root, 'walk-skip');
      mkdirSync(join(dir, 'node_modules', 'pkg'), { recursive: true });
      mkdirSync(join(dir, '.git'), { recursive: true });
      mkdirSync(join(dir, 'src'), { recursive: true });
      writeFileSync(join(dir, 'src', 'kept.ts'), 'kept');
      writeFileSync(join(dir, 'node_modules', 'pkg', 'dep.ts'), 'dep');
      writeFileSync(join(dir, '.git', 'HEAD'), 'ref');
      const outside = join(root, 'walk-skip-outside');
      mkdirSync(outside, { recursive: true });
      writeFileSync(join(outside, 'secret.ts'), 'secret');
      symlinkSync(join(outside, 'secret.ts'), join(dir, 'src', 'link.ts'));
      symlinkSync(outside, join(dir, 'src', 'linkdir'));

      const reply = walk(dir);
      expect(reply.ok).toBe(true);
      if (!reply.ok) return;
      // `src` itself is reported, the skipped directories are not descended into, and the two links are
      // reported AS links without being followed.
      expect(reply.result.entries.map((item: any) => [item.path, item.kind])).toEqual([
        [join(dir, 'src'), 'directory'],
        [join(dir, 'src', 'kept.ts'), 'file'],
        [join(dir, 'src', 'link.ts'), 'symlink'],
        [join(dir, 'src', 'linkdir'), 'symlink'],
      ]);
      // Nothing BEHIND a link appears: the traversal cannot be walked out of its own root.
      const paths = reply.result.entries.map((item: any) => item.path);
      expect(paths.some((path: string) => path.includes('secret'))).toBe(false);
    });

    it('reports a missing root as absent and walks a file root from its parent', () => {
      const dir = join(root, 'walk-roots');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'only.ts'), 'only');

      const missing = walk(join(dir, 'absent'));
      expect(missing.ok).toBe(true);
      if (missing.ok) expect(missing.result).toMatchObject({ rootKind: null, entries: [], truncated: false });

      const fileRoot = walk(join(dir, 'only.ts'));
      expect(fileRoot.ok).toBe(true);
      if (fileRoot.ok) {
        expect(fileRoot.result).toMatchObject({ root: dir, rootKind: 'file' });
        expect(fileRoot.result.entries.map((item: any) => item.path)).toEqual([join(dir, 'only.ts')]);
      }
    });

    it('truncates explicitly on the entry budget rather than answering as though it finished', () => {
      const dir = join(root, 'walk-entries');
      mkdirSync(dir, { recursive: true });
      for (let index = 0; index < 40; index += 1) writeFileSync(join(dir, `f-${String(index).padStart(3, '0')}`), 'x');

      const reply = walk(dir, { limit: 10 });
      expect(reply.ok).toBe(true);
      if (!reply.ok) return;
      expect(reply.result.entries).toHaveLength(10);
      expect(reply.result.truncated).toBe(true);
      // A truncated answer is a stable PREFIX of the sorted order, not an arbitrary subset.
      expect(reply.result.entries[0].path).toBe(join(dir, 'f-000'));
    });

    it('counts directories and symlinks against the visit budget, not only files', () => {
      // A tree of empty directories returns no files at all. If only files were counted, a traversal
      // could wander through an unbounded number of them while its budget never moved.
      const dir = join(root, 'walk-visits');
      mkdirSync(dir, { recursive: true });
      for (let index = 0; index < 11000; index += 1) mkdirSync(join(dir, `d-${String(index).padStart(5, '0')}`));

      const started = Date.now();
      const done = spawnSync('python3', ['-c', HELPER], {
        input: JSON.stringify({ kind: 'walk', path: dir, limit: 10001, skip: [] }),
        encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
      });
      const reply = JSON.parse(done.stdout) as HelperReply;
      expect(reply.ok).toBe(true);
      if (!reply.ok) return;
      expect(reply.result.entries.length).toBeLessThanOrEqual(10001);
      expect(reply.result.truncated).toBe(true);
      // And it stops on that budget rather than running until the deadline, which is only the backstop
      // for a filesystem slow enough that even a bounded number of entries takes too long.
      expect(Date.now() - started).toBeLessThan(10_000);
    });

    it('truncates on its output budget, well below what the transport would cut', () => {
      // Long paths rather than many files: a tree can exhaust the byte budget long before it reaches the
      // entry budget, and that is the case where an unbounded answer would be cut mid-JSON by the
      // transport and surface as a protocol failure instead of an honest truncation.
      let dir = join(root, 'walk-bytes');
      mkdirSync(dir, { recursive: true });
      for (let level = 0; level < 15; level += 1) { dir = join(dir, 'd'.repeat(240)); mkdirSync(dir); }
      const long = 'n'.repeat(200);
      for (let index = 0; index < 2600; index += 1) writeFileSync(join(dir, `${long}-${String(index).padStart(5, '0')}`), 'x');

      const done = spawnSync('python3', ['-c', HELPER], {
        input: JSON.stringify({ kind: 'walk', path: join(root, 'walk-bytes'), limit: 10001, skip: [] }),
        encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
      });
      const reply = JSON.parse(done.stdout) as HelperReply;
      expect(reply.ok).toBe(true);
      if (!reply.ok) return;
      expect(reply.result.truncated).toBe(true);
      expect(reply.result.entries.length).toBeLessThan(2600);
      // Comfortably under the 16 MB the transport allows.
      expect(Buffer.byteLength(done.stdout)).toBeLessThan(12 * 1024 * 1024);
    });

    // A directory costs the same to examine as a file. Counting only the files it chose to RETURN let a
    // walk look at any number of directories and still answer "complete".
    it('counts directories against the requested limit, so a shallow bound is not a false complete', () => {
      const dir = join(root, 'walk-limit-dirs');
      mkdirSync(dir, { recursive: true });
      for (let index = 0; index < 20; index += 1) mkdirSync(join(dir, `d-${String(index).padStart(2, '0')}`));

      const reply = runHelper({ kind: 'walk', path: dir, limit: 10, skip: [] });
      expect(reply.ok).toBe(true);
      if (!reply.ok) return;
      expect(reply.result.entries).toHaveLength(10);
      expect(reply.result.truncated).toBe(true);
    });

    it('reports symlinks and counts them against the requested limit', () => {
      const dir = join(root, 'walk-limit-links');
      mkdirSync(dir, { recursive: true });
      for (let index = 0; index < 6; index += 1) symlinkSync('/etc/hostname', join(dir, `l-${index}`));
      writeFileSync(join(dir, 'z-real.ts'), 'real');

      const reply = runHelper({ kind: 'walk', path: dir, limit: 4, skip: [] });
      expect(reply.ok).toBe(true);
      if (!reply.ok) return;
      // Four entries were examined and all four were links: they are reported, and the answer says it is
      // incomplete because two more entries were never reached.
      expect(reply.result.entries).toHaveLength(4);
      expect(reply.result.entries.every((item: any) => item.kind === 'symlink')).toBe(true);
      expect(reply.result.truncated).toBe(true);
    });

    // The link's own facts, never its target's. Resolving a target is the consumer's decision, made one
    // path at a time, and a link pointing nowhere must still be able to describe itself.
    it('describes a link by its own metadata, including one that points nowhere', () => {
      const dir = join(root, 'walk-broken-link');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'real.ts'), 'a much longer body than the link');
      symlinkSync(join(dir, 'real.ts'), join(dir, 'a-live'));
      symlinkSync(join(dir, 'gone.ts'), join(dir, 'b-broken'));

      const reply = runHelper({ kind: 'walk', path: dir, limit: 10001, skip: [] });
      expect(reply.ok).toBe(true);
      if (!reply.ok) return;
      const byName = Object.fromEntries(reply.result.entries.map((item: any) => [item.path.split('/').pop(), item]));
      expect(byName['a-live'].kind).toBe('symlink');
      expect(byName['b-broken'].kind).toBe('symlink');
      // A link's size is the length of the path it holds, so it never matches the file it points at.
      expect(byName['a-live'].size).toBe(join(dir, 'real.ts').length);
      expect(byName['a-live'].size).not.toBe(byName['real.ts'].size);
      expect(byName['b-broken'].mtime).toBeGreaterThan(0);
    });

    it('descends exactly as far as maxDepth allows', () => {
      const dir = join(root, 'walk-depth');
      mkdirSync(join(dir, 'one', 'two', 'three'), { recursive: true });
      writeFileSync(join(dir, 'root.ts'), 'r');
      writeFileSync(join(dir, 'one', 'a.ts'), 'a');
      writeFileSync(join(dir, 'one', 'two', 'b.ts'), 'b');
      writeFileSync(join(dir, 'one', 'two', 'three', 'c.ts'), 'c');

      // Depth 0 lists the root's own children and goes no further, which is what expanding a single
      // directory asks for. The child directory is still visible, just not opened.
      const shallow = runHelper({ kind: 'walk', path: dir, limit: 10001, skip: [], maxDepth: 0 });
      expect(shallow.ok).toBe(true);
      if (shallow.ok) {
        expect(shallow.result.entries.map((item: any) => item.path)).toEqual([join(dir, 'one'), join(dir, 'root.ts')]);
        expect(shallow.result.truncated).toBe(false);
      }

      const deeper = runHelper({ kind: 'walk', path: dir, limit: 10001, skip: [], maxDepth: 1 });
      expect(deeper.ok).toBe(true);
      if (deeper.ok) {
        expect(deeper.result.entries.map((item: any) => item.path)).toEqual([
          join(dir, 'one'), join(dir, 'root.ts'), join(dir, 'one', 'a.ts'), join(dir, 'one', 'two'),
        ]);
      }
    });

    it('shows an empty directory as an entry of its own', () => {
      const dir = join(root, 'walk-empty');
      mkdirSync(join(dir, 'hollow'), { recursive: true });
      const reply = runHelper({ kind: 'walk', path: dir, limit: 10001, skip: [] });
      expect(reply.ok).toBe(true);
      if (!reply.ok) return;
      expect(reply.result.entries).toEqual([
        { path: join(dir, 'hollow'), kind: 'directory', size: expect.any(Number), mtime: expect.any(Number) },
      ]);
      expect(reply.result.truncated).toBe(false);
    });

    // A directory that cannot be read is not an empty directory, and answering as though it were hides a
    // misconfiguration behind a result that looks complete.
    it('fails on a directory it may not read, at the root and nested alike', () => {
      const dir = join(root, 'walk-permission');
      mkdirSync(join(dir, 'closed'), { recursive: true });
      writeFileSync(join(dir, 'closed', 'hidden.ts'), 'hidden');
      writeFileSync(join(dir, 'open.ts'), 'open');
      chmodSync(join(dir, 'closed'), 0o000);
      try {
        const nested = runHelper({ kind: 'walk', path: dir, limit: 10001, skip: [] });
        expect(nested.ok).toBe(false);
        if (!nested.ok) expect(nested.error.code).toBe('permission_denied');

        const asRoot = runHelper({ kind: 'walk', path: join(dir, 'closed'), limit: 10001, skip: [] });
        expect(asRoot.ok).toBe(false);
        if (!asRoot.ok) expect(asRoot.error.code).toBe('permission_denied');
      } finally {
        chmodSync(join(dir, 'closed'), 0o700);
      }
    });

    // The budget is spent on the ENCODED answer. Non-ASCII names inflate to six bytes per character once
    // escaped, so a count taken on raw path bytes under-measures such a tree several times over.
    it('budgets the escaped encoding, not the raw path bytes', () => {
      let dir = join(root, 'walk-unicode');
      mkdirSync(dir, { recursive: true });
      // Every component is non-ASCII, so an encoded path costs six bytes per character where the raw one
      // costs two. A budget kept on raw bytes would let roughly three times this tree through.
      const component = 'ř'.repeat(120);
      for (let level = 0; level < 10; level += 1) { dir = join(dir, `${component}${level}`); mkdirSync(dir); }
      for (let index = 0; index < 1200; index += 1) writeFileSync(join(dir, `${component}-${String(index).padStart(5, '0')}`), 'x');

      const done = spawnSync('python3', ['-c', HELPER], {
        input: JSON.stringify({ kind: 'walk', path: join(root, 'walk-unicode'), limit: 10001, skip: [] }),
        encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
      });
      const reply = JSON.parse(done.stdout) as HelperReply;
      expect(reply.ok).toBe(true);
      if (!reply.ok) return;
      expect(reply.result.truncated).toBe(true);
      // The escaped reply stays under the budget; measured on raw UTF-8 it would have sailed past it.
      expect(Buffer.byteLength(done.stdout)).toBeLessThan(12 * 1024 * 1024);
    });

    // The deadline used to be consulted only after a whole directory had been read and sorted, so a
    // single enormous directory could overshoot it without bound. Running a COPY of the helper whose
    // deadline has already passed proves the check happens during enumeration, and needs no seam in the
    // shipped source to do it.
    it('stops during enumeration when the deadline has already passed, and reports truncation', () => {
      const dir = join(root, 'walk-deadline');
      mkdirSync(dir, { recursive: true });
      for (let index = 0; index < 200; index += 1) writeFileSync(join(dir, `f-${String(index).padStart(3, '0')}`), 'x');

      const expired = HELPER.replace('deadline = time.monotonic() + 10', 'deadline = time.monotonic() - 1');
      expect(expired).not.toBe(HELPER);
      const done = spawnSync('python3', ['-c', expired], {
        input: JSON.stringify({ kind: 'walk', path: dir, limit: 10001, skip: [] }), encoding: 'utf8',
      });
      const reply = JSON.parse(done.stdout) as HelperReply;
      expect(reply.ok).toBe(true);
      if (!reply.ok) return;
      // The partial listing is discarded rather than passed off as a prefix of the sorted answer.
      expect(reply.result.entries).toEqual([]);
      expect(reply.result.truncated).toBe(true);
    });

    it('refuses a malformed skip list instead of ignoring it', () => {
      const dir = join(root, 'walk-skip-invalid');
      mkdirSync(dir, { recursive: true });
      for (const skip of [['ok', 'with/slash'], ['ok', ''], 'notalist', [5]]) {
        const reply = runHelper({ kind: 'walk', path: dir, limit: 10, skip });
        expect(reply.ok).toBe(false);
        if (!reply.ok) expect(reply.error.code).toBe('invalid_operation');
      }
    });
  });
});