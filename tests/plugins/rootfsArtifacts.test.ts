import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { RootfsArtifactStore } from '../../plugins/sandbox/lib/rootfsArtifacts.mjs';
import { ROOTFS_ARTIFACTS, ROOTFS_RECIPES, artifactEntry, artifactReference, blobName, knownReferences, parseArtifactReference } from '../../plugins/sandbox/lib/rootfsCatalog.mjs';

const scratch = mkdtempSync(join(tmpdir(), 'elowen-rootfs-artifacts-'));
afterAll(() => { rmSync(scratch, { recursive: true, force: true }); });

const BYTES = Buffer.from('a root filesystem, as far as this test is concerned');
const DIGEST = `sha256:${createHash('sha256').update(BYTES).digest('hex')}`;

/** A catalogue answering for `project-base@1` and nothing else, built here rather than read from the
 *  shipped pins so that what these tests prove does not move when a release rebuilds an artifact.
 *  `overrides` is how a case asks for a variant of the entry, an unpublished one included. */
function published(overrides: Record<string, unknown> = {}) {
  return (reference: string) => (reference === 'project-base@1'
    ? { reference, digest: DIGEST, sizeBytes: BYTES.length, path: 'rootfs-project-base-v1/project-base-v1.tar.gz', ...overrides }
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

  it('names a leftover container image for what it is instead of failing as a parse error', () => {
    // Every environment created before this runtime carries a tag like this in its disk record. One that
    // was never materialized cannot be materialized now — the image is not published anywhere as a root
    // filesystem and there is no rule that turns a tag into an artifact. The refusal has to say that, and
    // it must not guess a conversion.
    for (const legacy of ['localhost/elowen-project-base:9f2c1d', 'docker.io/library/debian:bookworm-slim', 'ghcr.io/x/y:1']) {
      expect(() => parseArtifactReference(legacy), legacy).toThrow(/removed Podman runtime.*Delete the managed Project/);
      let code: string | undefined;
      try { parseArtifactReference(legacy); } catch (cause) { code = (cause as { code?: string }).code; }
      expect(code, legacy).toBe('unsupported_runtime');
    }
    // Every legacy shape gets the same actionable refusal; diagnostics identify the affected row separately.
    const messages = ['localhost/elowen-project-base:9f2c1d', 'docker.io/library/debian:bookworm-slim']
      .map((legacy) => { try { parseArtifactReference(legacy); } catch (cause) { return (cause as Error).message; } return ''; });
    expect(new Set(messages).size).toBe(1);
  });

  it('derives the blob name from the digest alone and refuses anything else', () => {
    expect(blobName(DIGEST)).toBe(`${DIGEST.replace(':', '-')}.tar.gz`);
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
    // A recipe this release declares and ships no copy of. That was the whole catalogue until a build
    // produced the bytes, and it is still what any recipe looks like between being declared and being
    // published, so the entry is injected rather than taken from the shipped pins. It has to name the
    // reference and stop: nothing here falls back to building a root filesystem on the host.
    const fetchImpl = vi.fn();
    const { store: subject } = store({ catalog: published({ digest: null, sizeBytes: null }), fetchImpl });
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
    const { store: subject } = store({ fetchImpl });
    const { path } = await subject.ensure('project-base@1');
    writeFileSync(path, BYTES.subarray(0, 3));
    const again = await subject.ensure('project-base@1');
    expect(again.fetched).toBe(true);
    expect(readFileSync(again.path)).toEqual(BYTES);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('hashes what is already in the store instead of trusting its length', async () => {
    // The substitution a length cannot see: the SAME number of bytes, different content. The helper
    // unpacks whatever comes back as root with `--same-owner` and `--preserve-permissions`, so a store
    // that answered on the size alone would establish this attacker's ownership, modes and capabilities
    // inside the next machine created from the recipe.
    const fetchImpl = respond(BYTES);
    const { dataDir, store: subject } = store({ fetchImpl });
    const { path } = await subject.ensure('project-base@1');

    const substituted = Buffer.alloc(BYTES.length, 0x7a);
    expect(substituted.length).toBe(BYTES.length);
    expect(substituted).not.toEqual(BYTES);
    writeFileSync(path, substituted);

    const again = await subject.ensure('project-base@1');
    expect(again).toMatchObject({ digest: DIGEST, fetched: true });
    expect(readFileSync(again.path)).toEqual(BYTES);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    // Replaced rather than kept beside the real one, so nothing can later find the substituted bytes.
    expect(blobs(dataDir)).toEqual([blobName(DIGEST)]);
  });

  it('carries the mismatch through when a substituted blob cannot be replaced', async () => {
    // The mirror is gone by the time the substitution is noticed, so there is nothing to re-fetch. The
    // refusal must not degrade into handing back what is on disk.
    const { dataDir, store: subject } = store({ fetchImpl: respond(BYTES) });
    const { path } = await subject.ensure('project-base@1');
    writeFileSync(path, Buffer.alloc(BYTES.length, 0x7a));

    const offline = new RootfsArtifactStore({ dataDir, catalog: published(),
      fetchImpl: vi.fn(async () => { throw new Error('getaddrinfo ENOTFOUND'); }) });
    await expect(offline.ensure('project-base@1')).rejects.toMatchObject({ code: 'artifact_unreachable' });
    expect(blobs(dataDir)).toEqual([]);
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

  it('touches no filesystem until something actually asks for an artifact', () => {
    // The store is constructed when the plugin REGISTERS. A data directory that does not exist yet is an
    // ordinary state on a fresh instance, and creating directories from a constructor took the whole
    // Sandbox plugin down on registration before anything had asked for a root filesystem.
    const absent = join(scratch, 'never-created', 'nested');
    const subject = new RootfsArtifactStore({ dataDir: absent, catalog: published(), fetchImpl: vi.fn() });
    expect(existsSync(absent)).toBe(false);
    // And the read-only answers still work over a store that has no directory at all.
    expect(subject.status('project-base@1')).toMatchObject({ published: true, present: false });
    expect(subject.collect(new Set())).toEqual([]);
    expect(existsSync(absent)).toBe(false);
  });

  it('will not be pointed at a mirror that is not plain https', () => {
    for (const bad of ['http://example.invalid/a', 'https://user:pw@example.invalid/a', 'https://example.invalid/a?token=x', 'not a url']) {
      expect(() => new RootfsArtifactStore({ dataDir: mkdtempSync(join(scratch, 'bad-')), baseUrl: bad }), bad)
        .toThrow(/artifact base URL/);
    }
  });
});
