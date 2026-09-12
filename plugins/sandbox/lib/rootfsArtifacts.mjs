import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream, lstatSync, readdirSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { checkedHostPath } from './containerPaths.mjs';
import { hostPath } from './containerSpec.mjs';
import {
  ARTIFACT_BASE_URL, ARTIFACT_DIGEST, MAX_ARTIFACT_BYTES, artifactEntry, blobName, parseArtifactReference,
} from './rootfsCatalog.mjs';

/** The host's copy of the published root filesystems, addressed by what they contain.
 *
 *  One store per instance, shared by every environment, because the bytes are identical for all of them
 *  and a per-environment copy of a multi-gigabyte tarball is a per-environment disk leak. A blob is named
 *  after its digest, so a second environment on the same recipe finds it already there and unpacks it
 *  without fetching anything.
 *
 *  Three properties the rest of the runtime depends on:
 *
 *  - A blob that exists has been VERIFIED. It is written to a private incoming file, hashed as it is
 *    written, and only renamed into the store when the digest and the length both match what the
 *    catalogue pinned. A partial or substituted download never acquires a name anything looks up, so
 *    there is no state where a caller has to decide whether to trust what it found.
 *  - Nothing here builds, converts or approximates a root filesystem. A missing artifact is an error
 *    with a code and a reference in it; there is no path that produces a different filesystem instead.
 *  - A materialized disk does not depend on the blob surviving. Unpacking copies the bytes out, so the
 *    store is a cache and collection is free to remove anything not currently referenced.
 */
export class RootfsArtifactStore {
  #root;
  #incoming;
  #fetch;
  #baseUrl;
  #maxBytes;
  #logger;
  /** The pinned catalogue, as a lookup. The same kind of seam as the injected executor beside the
   *  machine runtime: trusted module code and the test harness choose it, and nothing reachable from a
   *  plugin control does. It exists so the download, verification and collection paths can be exercised
   *  against artifacts that are actually published, which the shipped catalogue's entries are not until
   *  a release builds them. */
  #catalog;

  constructor(options = {}) {
    if (!options.dataDir) throw new Error('A sandbox data directory is required for the artifact store');
    // Recorded, not created. This store is built when the plugin registers, and registering must not
    // touch the filesystem: a data directory that does not exist yet is an ordinary state on a fresh
    // instance, and failing there takes the whole plugin down before anything has asked for an artifact.
    // The directories are established on the first operation that actually needs them.
    this.#root = join(hostPath(options.dataDir), 'rootfs', 'blobs');
    this.#incoming = join(hostPath(options.dataDir), 'rootfs', 'incoming');
    this.#catalog = options.catalog ?? artifactEntry;
    this.#fetch = options.fetchImpl ?? globalThis.fetch;
    this.#baseUrl = trustedBaseUrl(options.baseUrl ?? ARTIFACT_BASE_URL);
    this.#maxBytes = positiveBound(options.maxBytes ?? MAX_ARTIFACT_BYTES);
    this.#logger = options.logger ?? null;
  }

  /** The catalogue entry plus whether this host already holds the bytes. Read-only and cheap: it stats
   *  one file and never reaches the network, so a readiness poll can ask it as often as it likes. */
  status(reference) {
    const { name, version } = parseArtifactReference(reference);
    const entry = this.#catalog(reference);
    if (!entry) return { reference, name, version, published: false, present: false, digest: null, sizeBytes: null };
    if (!entry.digest) return { reference, name, version, published: false, present: false, digest: null, sizeBytes: null };
    const path = join(this.#root, blobName(entry.digest));
    let present = false;
    try { present = lstatSync(path).size === entry.sizeBytes; }
    catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
    return { reference, name, version, published: true, present, digest: entry.digest, sizeBytes: entry.sizeBytes };
  }

  /** The local path of a verified blob, fetching it first when this host does not have it yet.
   *
   *  Every failure is explicit and carries a code, because the caller is a lifecycle operation whose
   *  whole purpose is to tell an operator what went wrong: `artifact_unpublished` when this release
   *  declares the recipe but ships no copy, `artifact_unreachable` when the network would not answer,
   *  `artifact_digest_mismatch` when it answered with something else. None of them degrades into
   *  building or substituting a filesystem. */
  async ensure(reference, options = {}) {
    const entry = this.#catalog(reference);
    if (!entry) {
      throw fail('artifact_unknown', `This release does not know the root filesystem ${reference}`);
    }
    if (!entry.digest || !entry.sizeBytes) {
      throw fail('artifact_unpublished', `The root filesystem ${reference} is declared by this release but no published copy is pinned; publish it and pin its digest before an environment can be created from it`);
    }
    if (!ARTIFACT_DIGEST.test(entry.digest)) throw fail('artifact_digest_invalid', `The pinned digest for ${reference} is malformed`);
    if (entry.sizeBytes > this.#maxBytes) throw fail('artifact_too_large', `${reference} is larger than this host accepts`);
    const path = join(this.#root, blobName(entry.digest));
    // Present already means verified already: nothing is renamed into the store until it has matched.
    // The size is re-checked because a truncating write outside this process is cheap to notice and
    // expensive to unpack.
    try {
      if (lstatSync(path).size === entry.sizeBytes) return { path, digest: entry.digest, sizeBytes: entry.sizeBytes, fetched: false };
      unlinkSync(path);
    } catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
    await this.#download(entry, path, options);
    return { path, digest: entry.digest, sizeBytes: entry.sizeBytes, fetched: true };
  }

  async #download(entry, path, options) {
    checkedHostPath(this.#root, { create: true });
    checkedHostPath(this.#incoming, { create: true });
    const url = `${this.#baseUrl}/${entry.path}`;
    const temporary = join(this.#incoming, `${randomUUID()}.part`);
    let response;
    try {
      response = await this.#fetch(url, { redirect: 'follow', ...(options.signal ? { signal: options.signal } : {}) });
    } catch (cause) {
      throw fail('artifact_unreachable', `The root filesystem ${entry.reference} could not be fetched from ${url}: ${cause.message}`);
    }
    if (!response.ok) throw fail('artifact_unreachable', `The root filesystem ${entry.reference} could not be fetched from ${url}: HTTP ${response.status}`);
    if (!response.body) throw fail('artifact_unreachable', `The root filesystem ${entry.reference} answered without a body`);
    // Declared length is checked before a byte is written, so an obviously wrong answer costs nothing.
    const declared = Number(response.headers?.get?.('content-length') ?? '');
    if (Number.isSafeInteger(declared) && declared > 0 && declared !== entry.sizeBytes) {
      throw fail('artifact_digest_mismatch', `The root filesystem ${entry.reference} is ${declared} bytes where ${entry.sizeBytes} was pinned`);
    }
    const hash = createHash('sha256');
    let received = 0;
    try {
      await pipeline(
        Readable.fromWeb(response.body),
        async function* (source) {
          for await (const chunk of source) {
            received += chunk.length;
            // Bounded as it arrives rather than afterwards: a stream that never ends must not be able to
            // fill the disk before anyone checks its length.
            if (received > entry.sizeBytes) throw fail('artifact_digest_mismatch', `The root filesystem ${entry.reference} is longer than the ${entry.sizeBytes} bytes pinned for it`);
            hash.update(chunk);
            options.onProgress?.(received, entry.sizeBytes);
            yield chunk;
          }
        },
        createWriteStream(temporary, { flags: 'wx', mode: 0o600 }),
      );
      if (received !== entry.sizeBytes) throw fail('artifact_digest_mismatch', `The root filesystem ${entry.reference} ended after ${received} of ${entry.sizeBytes} bytes`);
      const digest = `sha256:${hash.digest('hex')}`;
      if (digest !== entry.digest) throw fail('artifact_digest_mismatch', `The root filesystem ${entry.reference} hashed to ${digest} where ${entry.digest} was pinned`);
      // The rename is what publishes it, and it is the last thing that happens.
      renameSync(temporary, path);
      this.#logger?.info?.(`fetched root filesystem ${entry.reference} (${entry.sizeBytes} bytes, ${entry.digest})`);
    } catch (cause) {
      try { unlinkSync(temporary); }
      catch (cleanup) { if (cleanup.code !== 'ENOENT') throw new AggregateError([cause, cleanup], `${cause.message}; incoming artifact cleanup failed: ${cleanup.message}`); }
      throw cause;
    }
  }

  /** Remove every blob no live reference names, and every abandoned incoming file.
   *
   *  `referenced` is supplied by the caller and is the whole authority: this store keeps no reference
   *  count of its own, because a count is a second record of something the environment rows already
   *  state, and the two would eventually disagree. A materialized disk is deliberately NOT a reference —
   *  it holds its own unpacked copy — so collection after a host has built its environments reclaims the
   *  entire cache, which is the point. */
  collect(referenced = new Set()) {
    const keep = new Set();
    for (const digest of referenced) {
      if (ARTIFACT_DIGEST.test(digest ?? '')) keep.add(blobName(digest));
    }
    const removed = [];
    for (const name of listing(this.#root)) {
      if (keep.has(name)) continue;
      try { unlinkSync(join(this.#root, name)); removed.push(name); }
      catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
    }
    // An incoming file is never a reference: it is either being written right now by a live download,
    // which will rename it, or it is the remains of one that failed. Both are safe to drop, because a
    // download that loses its temporary file fails and is retried rather than producing a short blob.
    for (const name of listing(this.#incoming)) {
      try { unlinkSync(join(this.#incoming, name)); }
      catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
    }
    return removed;
  }
}

/** A directory that was never created holds nothing, which is the same answer as an empty one. */
function listing(path) {
  try { return readdirSync(path); }
  catch (cause) { if (cause.code === 'ENOENT') return []; throw cause; }
}

function fail(code, message) {
  return Object.assign(new Error(message), { code, status: 409 });
}

/** Only https, only an absolute origin, and never a URL carrying credentials. The mirror setting is an
 *  operator's, but an operator setting is still input. */
function trustedBaseUrl(value) {
  let url;
  try { url = new URL(String(value)); }
  catch { throw new Error('The root filesystem artifact base URL is invalid'); }
  if (url.protocol !== 'https:') throw new Error('The root filesystem artifact base URL must be https');
  if (url.username || url.password || url.search || url.hash) throw new Error('The root filesystem artifact base URL must carry no credentials or query');
  return url.toString().replace(/\/+$/, '');
}

function positiveBound(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_ARTIFACT_BYTES) throw new Error('Invalid artifact size bound');
  return value;
}
