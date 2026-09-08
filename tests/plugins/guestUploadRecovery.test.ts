import { mkdtempSync, readFileSync, rmSync, writeFileSync, symlinkSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
