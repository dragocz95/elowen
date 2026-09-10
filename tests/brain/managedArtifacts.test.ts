import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  GUEST_READ_CHUNK_BYTES,
  GUEST_WRITE_OP_BYTES,
  readGuestFileBounded,
  statGuestFile,
  writeGuestFile,
} from '../../src/brain/managedArtifacts.js';
import { managedGuestFs, PROJECT } from '../helpers/managedGuest.js';

/** The bounded read/write primitives every central guest artifact consumer rides on, against the
 *  contract bounds the runtime enforces (512 KiB per read/write op, CAS writes, single-level mkdir). */

const access = (fs: ReturnType<typeof managedGuestFs>) => ({ sandbox: fs.sandbox, projectRef: PROJECT, accountUserId: 1 });

describe('readGuestFileBounded', () => {
  it('chunks a file larger than one read op across versioned reads', async () => {
    const fs = managedGuestFs();
    const bytes = Buffer.from('a'.repeat(GUEST_READ_CHUNK_BYTES * 2 + 123));
    await writeGuestFile(access(fs), '/data/.elowen/test/big.bin', bytes, null);
    const read = await readGuestFileBounded(access(fs), '/data/.elowen/test/big.bin', 512 * 1024 * 1024);
    expect(Buffer.isBuffer(read)).toBe(true);
    expect((read as Buffer).length).toBe(bytes.length);
    expect((read as Buffer).equals(bytes)).toBe(true);
    // Chunked: 262 275 bytes at 128 KiB per op — several reads plus the boundary stats.
    expect(fs.calls()).toBeGreaterThanOrEqual(5);
  });

  it('refuses a file larger than the requested bound instead of reading it in part', async () => {
    const fs = managedGuestFs({ '/workspace/data.bin': 'x'.repeat(300_000) });
    const read = await readGuestFileBounded(access(fs), '/workspace/data.bin', 10_000);
    expect(read as string).toBe('data.bin is 293 KiB, over the 10 KiB limit.');
    // stat only — the chunked read never started.
    expect(fs.calls()).toBe(1);
  });

  // Whole-megabyte rounding used to describe the 512 KiB guest bound as a "1 MB limit" and then report a
  // 0.6 MB file as being over it, while any bound under half a megabyte came out as "0 MB".
  it('states a sub-megabyte bound in the unit that fits it', async () => {
    const fs = managedGuestFs({ '/workspace/big.json': 'x'.repeat(614_400) });
    const read = await readGuestFileBounded(access(fs), '/workspace/big.json', GUEST_WRITE_OP_BYTES);
    expect(read).toBe('big.json is 600 KiB, over the 512 KiB limit.');
  });

  it('keeps whole megabytes for the multi-megabyte share limits', async () => {
    const fs = managedGuestFs({ '/workspace/huge.bin': 'x'.repeat(27 * 1048576) });
    const read = await readGuestFileBounded(access(fs), '/workspace/huge.bin', 25 * 1048576);
    expect(read).toBe('huge.bin is 27 MB, over the 25 MB limit.');
  });

  it('reports a missing file and a directory with the host-branch wording', async () => {
    const fs = managedGuestFs({ '/workspace/dir/f.txt': 'x' });
    expect(await readGuestFileBounded(access(fs), '/workspace/absent.txt', 1000)).toContain('cannot find');
    expect(await readGuestFileBounded(access(fs), '/workspace/dir', 1000)).toContain('is not a file');
  });

  it('refuses a MALFORMED totalBytes before accumulating anything', async () => {
    const fs = managedGuestFs({ '/workspace/data.bin': 'x'.repeat(300_000) }, { malformedTotal: 999_999 });
    const read = await readGuestFileBounded(access(fs), '/workspace/data.bin', 400_000);
    // A total outside the requested bound is refused before anything accumulates.
    expect(read as string).toContain('invalid size');
    expect(fs.calls()).toBe(2); // stat + the first read; nothing more was requested
  });

  it('refuses an in-bounds total that disagrees with the pinned size', async () => {
    const fs = managedGuestFs({ '/workspace/data.bin': 'x'.repeat(300_000) }, { malformedTotal: 299_999 });
    expect(await readGuestFileBounded(access(fs), '/workspace/data.bin', 400_000)).toContain('file changed');
  });

  it('refuses a file that GROWS mid-read instead of reading across the growth', async () => {
    const fs = managedGuestFs({ '/workspace/data.bin': 'x'.repeat(1000) }, {
      growOn: { call: 2, path: '/workspace/data.bin', append: Buffer.from('y'.repeat(500)) },
    });
    const read = await readGuestFileBounded(access(fs), '/workspace/data.bin', 100_000);
    expect(read as string).toContain('file changed');
    expect(Buffer.isBuffer(read)).toBe(false);
  });

  it('surfaces a provider error verbatim instead of half-answering', async () => {
    const fs = managedGuestFs({}, { fail: new Error('environment_error: container paused') });
    expect(await readGuestFileBounded(access(fs), '/data/.elowen/test/a.txt', 1000)).toContain('container paused');
  });
});

describe('writeGuestFile', () => {
  it('creates missing parent directories and reports the written entry', async () => {
    const fs = managedGuestFs();
    const entry = await writeGuestFile(access(fs), '/data/.elowen/plans/slug.md', Buffer.from('# plan'));
    expect(typeof entry).toBe('object');
    expect((entry as { kind: string }).kind).toBe('file');
    expect(fs.file('/data/.elowen/plans/slug.md')?.toString('utf8')).toBe('# plan');
  });

  it('enforces the create-once CAS: a second null-version write conflicts', async () => {
    const fs = managedGuestFs({ '/data/.elowen/test/a.txt': 'one' });
    const result = await writeGuestFile(access(fs), '/data/.elowen/test/a.txt', Buffer.from('two'));
    expect(typeof result).toBe('string');
    expect(result as string).toContain('version_conflict');
    expect(fs.file('/data/.elowen/test/a.txt')?.toString('utf8')).toBe('one');
  });

  it('overwrites through an explicit expectedVersion', async () => {
    const fs = managedGuestFs({ '/data/.elowen/test/a.txt': 'one' });
    const entry = await statGuestFile(access(fs), '/data/.elowen/test/a.txt');
    const result = await writeGuestFile(access(fs), '/data/.elowen/test/a.txt', Buffer.from('two'), (entry as { version: string }).version);
    expect(typeof result).toBe('object');
    expect(fs.file('/data/.elowen/test/a.txt')?.toString('utf8')).toBe('two');
  });

  it('confines central writes to the hidden artifact prefix', async () => {
    const fs = managedGuestFs({ '/workspace/a.txt': 'one' });
    const entry = await statGuestFile(access(fs), '/workspace/a.txt');
    const result = await writeGuestFile(access(fs), '/workspace/plain.txt', Buffer.from('x'), (entry as { version: string }).version);
    expect(result as string).toContain('not a managed artifact destination');
    expect(fs.exists('/workspace/plain.txt')).toBe(false);
  });

  it('refuses a write past the 512 KiB guest op limit instead of truncating', async () => {
    const fs = managedGuestFs();
    const result = await writeGuestFile(access(fs), '/data/.elowen/test/big.bin', Buffer.alloc(GUEST_WRITE_OP_BYTES + 1));
    expect(result as string).toContain('KiB guest write limit');
    expect(fs.exists('/data/.elowen/test/big.bin')).toBe(false);
  });

  it('propagates a provider refusal', async () => {
    const fs = managedGuestFs({}, { fail: new Error('down') });
    expect(await writeGuestFile(access(fs), '/data/.elowen/test/a.txt', Buffer.from('x'))).toContain('down');
  });
});

describe('statGuestFile', () => {
  it('answers null for a missing path and a stable version otherwise', async () => {
    const fs = managedGuestFs({ '/data/.elowen/test/a.txt': 'x' });
    expect(await statGuestFile(access(fs), '/workspace/absent.txt')).toBeNull();
    const first = await statGuestFile(access(fs), '/data/.elowen/test/a.txt');
    const second = await statGuestFile(access(fs), '/data/.elowen/test/a.txt');
    expect((first as { version: string }).version).toBe((second as { version: string }).version);
    expect((first as { version: string }).version).toBe(createHash('sha256').update('x').digest('hex'));
  });
});
