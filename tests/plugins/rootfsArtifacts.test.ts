import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
// @ts-expect-error the bundled Sandbox plugin is plain ESM without declarations
import { RootfsArtifactStore } from '../../plugins/sandbox/lib/rootfsArtifacts.mjs';
// @ts-expect-error the bundled Sandbox plugin is plain ESM without declarations
import { ROOTFS_ARTIFACTS, ROOTFS_RECIPES, artifactEntry, artifactReference, blobName, knownReferences, parseArtifactReference } from '../../plugins/sandbox/lib/rootfsCatalog.mjs';

const scratch = mkdtempSync(join(tmpdir(), 'elowen-rootfs-artifacts-'));
afterAll(() => { rmSync(scratch, { recursive: true, force: true }); });

const BYTES = Buffer.from('a root filesystem, as far as this test is concerned');
const DIGEST = `sha256:${createHash('sha256').update(BYTES).digest('hex')}`;

/** A published entry, which the shipped catalogue deliberately has none of until a release builds one. */
function published(overrides: Record<string, unknown> = {}) {
  return (reference: string) => (reference === 'project-base@1'
    ? { reference, digest: DIGEST, sizeBytes: BYTES.length, path: 'rootfs-project-base-v1/project-base-v1.tar.zst', ...overrides }
    : null);
}

function respond(body: Buffer, init: { status?: number; length?: number | null } = {}) {
  return vi.fn(async () => ({
    ok: (init.status ?? 200) < 400,
    status: init.status ?? 200,
    headers: { get: (name: string) => (name === 'content-length' && init.length !== null ? String(init.length ?? body.length) : null) },
    body: new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(body)); controller.close(); } }),
  }));
}

function store(options: Record<string, unknown> = {}) {
  const dataDir = mkdtempSync(join(scratch, 'inst-'));
  return { dataDir, store: new RootfsArtifactStore({ dataDir, catalog: published(), ...options }) };
}

const blobs = (dataDir: string) => readdirSync(join(dataDir, 'rootfs', 'blobs'));
const incoming = (dataDir: string) => readdirSync(join(dataDir, 'rootfs', 'incoming'));

describe('root filesystem artifact catalogue', () => {
  it('names every recipe the runtime can build an environment from, with a pinned entry each', () => {
    // A recipe with no catalogue entry is a reference nothing can ever resolve, and the failure lands on
    // whoever creates the next environment rather than on whoever added the recipe.
    for (const name of Object.keys(ROOTFS_RECIPES)) {
      const reference = artifactReference(name);
      expect(Object.keys(ROOTFS_ARTIFACTS), `${name} has no catalogue entry`).toContain(reference);
    }
    expect(knownReferences().sort()).toEqual(Object.keys(ROOTFS_ARTIFACTS).sort());
  });

  it('holds every pinned entry to a well-formed digest, length and relative path', () => {
    for (const [reference, entry] of Object.entries(ROOTFS_ARTIFACTS) as [string, { digest: string | null; sizeBytes: number | null; path: string }][]) {
      parseArtifactReference(reference);
      // A half-pinned entry is the dangerous shape: a digest with no length cannot bound a download, and
      // a length with no digest cannot prove one. Both or neither.
      expect(entry.digest === null, `${reference} pins a length without a digest`).toBe(entry.sizeBytes === null);
      if (entry.digest !== null) {
        expect(entry.digest, reference).toMatch(/^sha256:[a-f0-9]{64}$/);
        expect(Number.isSafeInteger(entry.sizeBytes) && (entry.sizeBytes as number) > 0, reference).toBe(true);
      }
      expect(entry.path, reference).toMatch(/^[a-z0-9][a-z0-9./-]*$/);
      expect(entry.path, reference).not.toContain('..');
    }
  });

  it('refuses a reference it does not carry rather than turning it into a URL', () => {
    expect(() => artifactReference('not-a-recipe')).toThrow(/Unknown root filesystem recipe/);
    expect(() => parseArtifactReference('project-base')).toThrow(/Invalid root filesystem artifact reference/);
    expect(() => parseArtifactReference('../../etc@1')).toThrow(/Invalid root filesystem artifact reference/);
    expect(artifactEntry('project-base@99')).toBeNull();
  });

  it('derives the blob name from the digest alone and refuses anything else', () => {
    expect(blobName(DIGEST)).toBe(`${DIGEST.replace(':', '-')}.tar.zst`);
    for (const bad of ['sha256:nothex', 'sha512:' + 'a'.repeat(64), '', null]) {
      expect(() => blobName(bad), String(bad)).toThrow(/Invalid artifact digest/);
    }
  });
});

describe('root filesystem artifact store', () => {
  it('fetches, verifies and publishes a blob by rename, and reuses it afterwards', async () => {
    const fetchImpl = respond(BYTES);
    const { dataDir, store: subject } = store({ fetchImpl });

    const first = await subject.ensure('project-base@1');
    expect(first).toMatchObject({ digest: DIGEST, sizeBytes: BYTES.length, fetched: true });
    expect(readFileSync(first.path)).toEqual(BYTES);
    expect(blobs(dataDir)).toEqual([blobName(DIGEST)]);
    // Nothing is left behind by a completed download.
    expect(incoming(dataDir)).toEqual([]);

    // A second environment on the same recipe unpacks the copy that is already here.
    const second = await subject.ensure('project-base@1');
    expect(second).toMatchObject({ path: first.path, fetched: false });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('refuses a declared but unpublished artifact instead of building one', async () => {
    // This is the shipped catalogue's own state before a release builds the artifacts, so it is the
    // first thing a fresh host meets. It has to name the reference and stop.
    const fetchImpl = vi.fn();
    const { store: subject } = store({ catalog: artifactEntry, fetchImpl });
    await expect(subject.ensure('project-base@1')).rejects.toMatchObject({ code: 'artifact_unpublished' });
    await expect(subject.ensure('project-base@1')).rejects.toThrow(/project-base@1/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('keeps a mismatched digest out of the store entirely', async () => {
    const { dataDir, store: subject } = store({ fetchImpl: respond(Buffer.concat([BYTES, Buffer.from('!')]), { length: null }) });
    await expect(subject.ensure('project-base@1')).rejects.toMatchObject({ code: 'artifact_digest_mismatch' });
    // Not a short blob, not a quarantined one: no blob at all, and no incoming remains either.
    expect(blobs(dataDir)).toEqual([]);
    expect(incoming(dataDir)).toEqual([]);
  });

  it('stops a body that outgrows its pinned length while it is still arriving', async () => {
    // Bounded as it streams rather than afterwards: an endless answer must not be able to fill the disk
    // before anything checks how long it was.
    const flood = Buffer.alloc(BYTES.length * 64, 0x61);
    const { dataDir, store: subject } = store({ fetchImpl: respond(flood, { length: null }) });
    await expect(subject.ensure('project-base@1')).rejects.toMatchObject({ code: 'artifact_digest_mismatch' });
    expect(blobs(dataDir)).toEqual([]);
  });

  it('rejects a declared length that disagrees with the pin before writing a byte', async () => {
    const { dataDir, store: subject } = store({ fetchImpl: respond(BYTES, { length: BYTES.length + 1 }) });
    await expect(subject.ensure('project-base@1')).rejects.toMatchObject({ code: 'artifact_digest_mismatch' });
    expect(incoming(dataDir)).toEqual([]);
  });

  it('reports an unreachable mirror as itself rather than as a missing artifact', async () => {
    // Offline is not the same fact as unpublished, and an operator acts on them differently.
    const offline = store({ fetchImpl: vi.fn(async () => { throw new Error('getaddrinfo ENOTFOUND'); }) });
    await expect(offline.store.ensure('project-base@1')).rejects.toMatchObject({ code: 'artifact_unreachable' });
    const refused = store({ fetchImpl: respond(BYTES, { status: 404 }) });
    await expect(refused.store.ensure('project-base@1')).rejects.toMatchObject({ code: 'artifact_unreachable' });
    // And a retry after the mirror comes back succeeds without any cleanup step in between.
    const recovered = store({ fetchImpl: respond(BYTES) });
    await expect(recovered.store.ensure('project-base@1')).resolves.toMatchObject({ fetched: true });
  });

  it('re-fetches a blob that was truncated underneath it', async () => {
    const fetchImpl = respond(BYTES);
    const { dataDir, store: subject } = store({ fetchImpl });
    const { path } = await subject.ensure('project-base@1');
    writeFileSync(path, BYTES.subarray(0, 3));
    const again = await subject.ensure('project-base@1');
    expect(again.fetched).toBe(true);
    expect(readFileSync(again.path)).toEqual(BYTES);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('reports what the host holds without reaching the network', () => {
    const fetchImpl = vi.fn();
    const { store: subject } = store({ fetchImpl });
    expect(subject.status('project-base@1')).toMatchObject({ published: true, present: false, digest: DIGEST });
    expect(subject.status('project-base@99')).toMatchObject({ published: false, present: false, digest: null });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('collects only what nothing references, and sweeps abandoned downloads', async () => {
    const { dataDir, store: subject } = store({ fetchImpl: respond(BYTES) });
    const { path } = await subject.ensure('project-base@1');
    writeFileSync(join(dataDir, 'rootfs', 'incoming', 'abandoned.part'), 'half a download');

    expect(subject.collect(new Set([DIGEST]))).toEqual([]);
    expect(existsSync(path)).toBe(true);
    // The abandoned download goes either way: it is either being renamed by a live fetch or it is debris.
    expect(incoming(dataDir)).toEqual([]);

    // A materialized disk is deliberately NOT a reference, so a host that has built its environments
    // reclaims the whole cache.
    expect(subject.collect(new Set())).toEqual([blobName(DIGEST)]);
    expect(existsSync(path)).toBe(false);
  });

  it('will not be pointed at a mirror that is not plain https', () => {
    for (const bad of ['http://example.invalid/a', 'https://user:pw@example.invalid/a', 'https://example.invalid/a?token=x', 'not a url']) {
      expect(() => new RootfsArtifactStore({ dataDir: mkdtempSync(join(scratch, 'bad-')), baseUrl: bad }), bad)
        .toThrow(/artifact base URL/);
    }
  });
});
