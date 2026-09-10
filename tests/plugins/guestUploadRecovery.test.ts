import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, symlinkSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { afterEach, expect, it } from 'vitest';
const helper = readFileSync(new URL('../../plugins/sandbox/lib/guestFiles.py', import.meta.url), 'utf8');
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'guest-upload-')); roots.push(root);
  const path = join(root, 'target');
  const scope = { resourceKind: 'project', resourceId: '7', projectId: 7, accountUserId: 1, generation: 1 };
  const invoke = (operation: any) => {
    const result = spawnSync('python3', ['-c', helper], { input: JSON.stringify(operation), encoding: 'utf8', maxBuffer: 2 ** 21,
      env: { ...process.env, ELOWEN_UPLOAD_ROOT: join(root, 'uploads') } });
    if (result.error) throw result.error;
    return JSON.parse(result.stdout);
  };
  const op = { path, scope, uploadId: 'a'.repeat(32), expectedVersion: null, size: 524291 };
  return { root, path, invoke, op };
}
it('assembles reordered bounded chunks and preserves a durable repeated-commit receipt', () => {
  const { path, invoke, op } = fixture();
  expect(invoke({ ...op, kind: 'write-begin' }).ok).toBe(true);
  expect(invoke({ ...op, kind: 'write-chunk', offset: 524288, base64: Buffer.from('end').toString('base64') }).result.received).toBe(3);
  const chunk = { ...op, kind: 'write-chunk', offset: 0, base64: Buffer.alloc(524288, 65).toString('base64') };
  expect(invoke(chunk).result.received).toBe(op.size);
  expect(invoke(chunk).result.received).toBe(op.size);
  expect(invoke({ ...chunk, base64: Buffer.alloc(524288, 66).toString('base64') }).error.code).toBe('chunk_conflict');
  const committed = invoke({ ...op, kind: 'write-commit' });
  expect(committed.ok).toBe(true);
  expect(readFileSync(path).length).toBe(op.size);
  expect(invoke({ ...op, kind: 'write-commit' })).toEqual(committed);
  expect(invoke({ ...op, kind: 'write-abort' }).ok).toBe(true);
  expect(readFileSync(path).length).toBe(op.size);
});
it('rejects foreign scope, incomplete chunks and final CAS without touching the target', () => {
  const { path, invoke, op } = fixture();
  expect(invoke({ ...op, kind: 'write-begin' }).ok).toBe(true);
  expect(invoke({ ...op, scope: { ...op.scope, accountUserId: 2 }, kind: 'write-abort' }).error.code).toBe('upload_forbidden');
  expect(invoke({ ...op, kind: 'write-commit' }).error.code).toBe('upload_incomplete');
  for (const [offset, data] of [[0, Buffer.alloc(524288)], [524288, Buffer.from('end')]] as const) {
    expect(invoke({ ...op, kind: 'write-chunk', offset, base64: data.toString('base64') }).ok).toBe(true);
  }
  writeFileSync(path, 'concurrent');
  expect(invoke({ ...op, kind: 'write-commit' }).error.code).toBe('version_conflict');
  expect(readFileSync(path, 'utf8')).toBe('concurrent');
});
it('builds the missing destination ancestry at 0700 and commits the exact bytes into it', () => {
  const { root, invoke, op } = fixture();
  // Nothing along `reports/2026/september` exists yet. An upload used to accept this destination and then
  // fail on the FIRST CHUNK with a raw errno, because the candidate file had nowhere to be created.
  const nested = join(root, 'reports', '2026', 'september', 'summary.bin');
  const body = Buffer.concat([Buffer.alloc(524288, 88), Buffer.from('tail')]);
  const nestedOp = { ...op, path: nested, size: body.length };

  expect(invoke({ ...nestedOp, kind: 'write-begin' }).ok).toBe(true);
  for (const directory of ['reports', 'reports/2026', 'reports/2026/september']) {
    const info = statSync(join(root, directory));
    expect(info.isDirectory()).toBe(true);
    // The same mode the mkdir operation gives a directory it creates: private to the owner.
    expect(info.mode & 0o777).toBe(0o700);
  }

  expect(invoke({ ...nestedOp, kind: 'write-chunk', offset: 0, base64: body.subarray(0, 524288).toString('base64') }).ok).toBe(true);
  expect(invoke({ ...nestedOp, kind: 'write-chunk', offset: 524288, base64: body.subarray(524288).toString('base64') }).ok).toBe(true);
  expect(invoke({ ...nestedOp, kind: 'write-commit' }).ok).toBe(true);

  const written = readFileSync(nested);
  expect(written.length).toBe(body.length);
  expect(createHash('sha256').update(written).digest('hex')).toBe(createHash('sha256').update(body).digest('hex'));
  // The staging candidate is gone from the directory the upload just built, not merely from the root.
  expect(readdirSync(join(root, 'reports', '2026', 'september'))).toEqual(['summary.bin']);
});

it('creates no directories when the compare-and-swap refuses the upload', () => {
  const { root, invoke, op } = fixture();
  const nested = join(root, 'never', 'created', 'file.bin');
  // A version is expected, but nothing is there to match it. The destination must be refused BEFORE any
  // ancestry is built, or a rejected upload would litter the tree with empty private directories.
  const refused = invoke({ ...op, kind: 'write-begin', path: nested, expectedVersion: 'sha256:absent' });
  expect(refused.error.code).toBe('version_conflict');
  expect(existsSync(join(root, 'never'))).toBe(false);
});

it('reports a non-directory in the destination path as a conflict, not an errno', () => {
  const { root, invoke, op } = fixture();
  writeFileSync(join(root, 'occupied'), 'i am a file');
  const blocked = invoke({ ...op, kind: 'write-begin', path: join(root, 'occupied', 'child', 'file.bin') });
  expect(blocked.error.code).toBe('not_directory');
  // The caller learns the shape of the problem without the staging location or an errno being handed over.
  expect(JSON.stringify(blocked)).not.toMatch(/elowen-upload|Errno|ENOTDIR|errno/i);
  expect(readFileSync(join(root, 'occupied'), 'utf8')).toBe('i am a file');
});

it('still resolves through an existing symlinked ancestor and still catches drift under it', () => {
  const { root, path, invoke, op } = fixture();
  // An ancestor that is a symlink TO a directory is a normal destination — it is followed, not rebuilt.
  const real = join(root, 'real'); mkdirSync(real);
  symlinkSync(real, join(root, 'link'));
  const through = { ...op, path: join(root, 'link', 'deep', 'file.bin'), size: 4 };
  expect(invoke({ ...through, kind: 'write-begin' }).ok).toBe(true);
  expect(statSync(join(real, 'deep')).isDirectory()).toBe(true);   // built under the link's real target

  // Retargeting the ancestor after the upload was bound is drift, exactly as retargeting the file is.
  unlinkSync(join(root, 'link')); mkdirSync(join(root, 'elsewhere')); symlinkSync(join(root, 'elsewhere'), join(root, 'link'));
  expect(invoke({ ...through, kind: 'write-chunk', offset: 0, base64: Buffer.from('abcd').toString('base64') }).error.code).toBe('resolution_drift');
  expect(existsSync(join(root, 'elsewhere', 'deep'))).toBe(false);
  void path;
});

it('refuses retargeted symlinks before committing and supports empty files', () => {
  const { root, path, invoke, op } = fixture();
  const target = join(root, 'actual'); const other = join(root, 'other');
  symlinkSync(target, path);
  const empty = { ...op, size: 0 };
  expect(invoke({ ...empty, kind: 'write-begin' }).ok).toBe(true);
  unlinkSync(path); symlinkSync(other, path);
  expect(invoke({ ...empty, kind: 'write-commit' }).error.code).toBe('resolution_drift');
  unlinkSync(path); symlinkSync(target, path);
  expect(invoke({ ...empty, kind: 'write-commit' }).ok).toBe(true);
  expect(readFileSync(target).length).toBe(0);
});
