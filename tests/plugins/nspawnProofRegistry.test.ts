import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { retireProofRanges } from './nspawnProofHost.mjs';

/** The proof suite runs against a real host, so the privileged helper it talks to allocates from the REAL
 *  uid-range registry at `/var/lib/elowen/nspawn-uid-ranges.json`. That registry is forward-only by design
 *  — one environment, one range, never reused, because a restored disk carries its ownership on disk — so
 *  every proof run burned one project slot and one site slot out of 4096 for good.
 *
 *  The helper is not the place to fix that: a registry path it took from a request would be a path the
 *  service account could name, and that account reaches the same sudoers-pinned argv the daemon does. The
 *  run's own teardown is, and this is what holds it to removing only what the run itself added. */
describe('nspawn proof host, uid range teardown', () => {
  let scratch: string;
  let registryPath: string;
  let storage: { sandboxDataDir: string; sitesDataDir: string };

  const write = (registry: Record<string, number>) =>
    writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`, { mode: 0o600 });
  const read = (): Record<string, number> => JSON.parse(readFileSync(registryPath, 'utf8'));

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), 'nsproof-registry-'));
    registryPath = join(scratch, 'nspawn-uid-ranges.json');
    storage = { sandboxDataDir: join(scratch, 'sandbox'), sitesDataDir: join(scratch, 'sites') };
    mkdirSync(join(storage.sandboxDataDir, 'projects'), { recursive: true });
    mkdirSync(storage.sitesDataDir, { recursive: true });
  });

  afterEach(() => rmSync(scratch, { recursive: true, force: true }));

  it('removes the ranges one run allocated and leaves every other entry exactly as it found it', () => {
    // `project:61` is a real environment that was already recorded; `project:62` is one the daemon
    // allocated while the suite was running, which is the entry a snapshot-and-restore teardown would
    // silently destroy. Both survive, values included.
    const before = ['project:61', 'site:demo'];
    write({
      'project:61': 1_073_741_824,
      'site:demo': 1_073_807_360,
      'project:990123456': 1_073_872_896,
      'site:nsproof-aabbccdd': 1_073_938_432,
      'project:62': 1_074_003_968,
    });

    const result = retireProofRanges(before, storage, registryPath);

    expect([...result.retired].sort()).toEqual(['project:990123456', 'site:nsproof-aabbccdd']);
    expect(result.kept).toEqual([]);
    expect(read()).toEqual({
      'project:61': 1_073_741_824,
      'site:demo': 1_073_807_360,
      'project:62': 1_074_003_968,
    });
    // Written the way the helper writes it, and still only root's to read.
    expect(readFileSync(registryPath, 'utf8')).toBe(`${JSON.stringify(read(), null, 2)}\n`);
    expect(statSync(registryPath).mode & 0o777).toBe(0o600);
  });

  it('keeps a range whose disk tree is still on the host', () => {
    // The safety rule the whole registry rests on: an entry matters as long as some tree carries ownership
    // in its range. A run that failed halfway leaves one behind, and its slot stays reserved.
    write({ 'project:990111111': 1_073_741_824, 'site:nsproof-01234567': 1_073_807_360 });
    mkdirSync(join(storage.sandboxDataDir, 'projects', '990111111', 'disks'), { recursive: true });

    const result = retireProofRanges([], storage, registryPath);

    expect(result.kept).toEqual(['project:990111111']);
    expect(result.retired).toEqual(['site:nsproof-01234567']);
    expect(Object.keys(read())).toEqual(['project:990111111']);
  });

  it('matches the ids the proof suite actually mints, in both registry key forms', () => {
    // Derived here the way `environmentNspawnProof.test.ts` derives them, so a change to either id shows
    // up as a failure here rather than as a slot quietly burned on every run.
    const suffix = randomBytes(4).toString('hex');
    const projectId = 990_000_000 + Number(BigInt(`0x${suffix}`) % 1_000_000n);
    const diskId = randomBytes(16).toString('hex');
    write({
      [`project:${projectId}`]: 1_073_741_824,
      [`site:nsproof-${suffix}`]: 1_073_807_360,
      // The earlier per-disk key form, which the helper still adopts and which older runs left behind.
      [`project:${projectId}:${diskId}`]: 1_073_872_896,
      // A real project id of the same length is not a proof id.
      'project:123456789': 1_073_938_432,
    });

    const result = retireProofRanges([], storage, registryPath);

    expect([...result.retired].sort()).toEqual([`project:${projectId}`, `project:${projectId}:${diskId}`,
      `site:nsproof-${suffix}`].sort());
    expect(Object.keys(read())).toEqual(['project:123456789']);
  });
});
